"""Evaluation harness: held-out personas, several seeds, current formula vs vectors vs vectors + GBDT, ablations.

Input: seeds, method names, cohort size, days, a models folder and a world (normal / stress / wild).
Output: one result dict per (seed, method): session metrics (summarize), the new-user probe curve,
seconds; `run_eval` writes the list to ml/results/<out_name>. `table` and `paired` format results.

Each (seed, method) task: build a fresh eval world and cohort (seeds disjoint from training), simulate
DAYS days in the loop (the method's own feed drives what the persona sees and does), then run a probe
learning curve on a fixed pool. Common random numbers: a persona's reaction to a given card is fixed,
so methods differ only in what they show and in what order.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from .. import config as C
from ..data.catalog import Catalog
from ..data.generator import generate_cards
from ..features.crowd import CrowdTables
from ..paths import MODELS, RESULTS
from ..simulator import World, make_persona, ndcg_at, run_cohort
from ..training.train import EVAL_PERSONA_BASE, EVAL_WORLD_BASE
from .policies import ABLATIONS, BASELINES, Bundle, method, models_dir_for

KS = (0, 1, 3, 5, 10, 20)                 # probe: explicit events after which the top 10 is graded
PROBE_DAY = 5                             # probe pool: the fresh cards at noon, 5 days after readers start
# Test worlds. "normal" and "stress" were known while hardening (tuning used validation seeds 11-13 only);
# "wild" has a different noise structure and was run only once, at the end, on seeds 1-5 (never tuned on).
WORLDS = {
    "normal": {},
    "stress": dict(noise_mult=2.0, taste_scale=0.6, pos_decay=0.15),
    "wild": dict(noise_mult=1.3, taste_scale=0.8, pos_form="exp", mood_sd=0.45, session_gain_sd=0.35,
                 drift=0.6, mistap=0.03, bursty=True),
}


def make_env(seed: int, n_personas: int, days: int, bundle: Bundle, world_kw: dict | None = None):
    """Evaluation world and held-out personas for one seed (a third of them change taste at mid-run)."""
    cards, lat = generate_cards(EVAL_WORLD_BASE + seed, days=days + 3)
    cat = Catalog.build(cards, bundle.embedder)
    world = World(cat, lat, **(world_kw or {}))
    personas = [make_persona(EVAL_PERSONA_BASE + seed * 1000 + i, "test", shift=(i % 3 == 0)) for i in range(n_personas)]
    for p in personas:
        if p.taste2 is not None:
            p.shift_day = world.user_start_day + days // 2
    return world, personas


def _mean(xs):
    xs = [x for x in xs if x is not None and not (isinstance(x, float) and np.isnan(x))]
    return float(np.mean(xs)) if xs else float("nan")


def summarize(S: list[dict], days: int) -> dict:
    """Session records -> mean metrics, persona-type breakdown, in-loop learning curve and shift curves."""
    R = [s for s in S if "ndcg10" in s]
    out = {"n_sessions": len(R)}
    for k in ("ndcg10", "exp_like10", "exp_dis10", "exp_dwell10", "gain10", "cats10", "subs10", "base10", "repeat", "n_cards", "dwell_total"):
        out[k] = _mean([s[k] for s in R])
    imp = sum(s["impr10"] for s in R)
    out["like10_real"] = sum(s["likes10"] for s in R) / max(imp, 1)
    out["dis10_real"] = sum(s["dislikes10"] for s in R) / max(imp, 1)
    sd = np.sum([s["slot_dwell"] for s in R], axis=0); sn = np.sum([s["slot_n"] for s in R], axis=0)
    out["dwell10_real"] = float(sd.sum() / max(sn.sum(), 1))
    out["like_ratio"] = _mean([s["exp_like10"] / s["orc_like10"] for s in R if s["orc_like10"] > 0])
    early = [s for s in R if s["day"] < 3]
    out["early_ndcg10"] = _mean([s["ndcg10"] for s in early]); out["early_like10"] = _mean([s["exp_like10"] for s in early])
    out["by_kind"] = {}
    for kind in sorted({s["kind"] for s in R}):
        kk = [s for s in R if s["kind"] == kind]
        out["by_kind"][kind] = {"n": len(kk), "ndcg10": _mean([s["ndcg10"] for s in kk]), "like10": _mean([s["exp_like10"] for s in kk]),
                                "dwell": _mean([s["dwell_total"] for s in kk])}
    # in-loop learning curve: bucket by strong events at session start
    edges = list(KS) + [10 ** 9]
    out["loop_curve"] = {}
    for a, b in zip(edges[:-1], edges[1:]):
        bb = [s for s in R if a <= s["n_strong"] < b]
        out["loop_curve"][str(a)] = {"n": len(bb), "ndcg10": _mean([s["ndcg10"] for s in bb]),
                                     "like10": _mean([s["exp_like10"] for s in bb])}
    # shifted taste: per day, ratio to the oracle, for personas whose taste changes mid-run
    sh = [s for s in R if s["shift"]]; ns = [s for s in R if not s["shift"]]
    out["shift_days"] = {str(d): _mean([s["exp_like10"] / s["orc_like10"] for s in sh if s["day"] == d and s["orc_like10"] > 0]) for d in range(days)}
    out["noshift_days"] = {str(d): _mean([s["exp_like10"] / s["orc_like10"] for s in ns if s["day"] == d and s["orc_like10"] > 0]) for d in range(days)}
    return out


def probe(world: World, personas, policy_for, sf) -> dict:
    """New-user curve: every method sees the same random cards; after k explicit events grade its top 10."""
    cat = world.catalog
    now = (world.user_start_day + PROBE_DAY) * C.DAY + 12.0
    pool = cat.fresh_rows(now)
    empty = CrowdTables.empty(cat.n)
    acc = {k: {"ndcg10": [], "like10": [], "n_impr": []} for k in KS}
    for p in personas:
        st = sf(p, now - 1.0)
        pol = policy_for(p)
        order = np.random.default_rng([p.seed, 99]).permutation(pool)
        reached: set = set()

        def measure(k, n_impr):
            seen, dis = st.seen_ids, st.disliked_ids
            elig = np.array([r for r in pool if cat.cards[r].id not in seen and cat.cards[r].id not in dis], dtype=int)
            top = pol.rank(st, pool, now, empty)[:C.PAGE_SIZE]
            g_all = world.gain(p, elig, now)
            acc[k]["ndcg10"].append(ndcg_at(world.gain(p, top, now), g_all))
            acc[k]["like10"].append(float(world.expected(p, top, now)[0].mean()))
            acc[k]["n_impr"].append(n_impr)
            reached.add(k)

        measure(0, 0)
        for i, r in enumerate(order):
            ev, _ = world.behave(p, int(r), 0, now)
            st.observe(cat.cards[r], cat.emb[r], ev, now)
            for k in KS:
                if k not in reached and st.n_strong >= k:
                    measure(k, i + 1)
            if len(reached) == len(KS):
                break
    return {str(k): {"n": len(v["ndcg10"]), "ndcg10": _mean(v["ndcg10"]), "like10": _mean(v["like10"]), "impressions": _mean(v["n_impr"])}
            for k, v in acc.items()}


def eval_task(args) -> dict:
    """One (seed, method name, personas, days, models_dir, world_kw) run. Runs in a worker process."""
    seed, name, n_personas, days, models_dir, world_kw = args
    bundle = Bundle.load(models_dir_for(name, Path(models_dir)))
    world, personas = make_env(seed, n_personas, days, bundle, world_kw)
    if name == "z_oracle_nonoise":                      # diagnostic only (reads hidden taste), see diagnostics.py
        from .diagnostics import oracle_method
        policy_for, sf = oracle_method(world, bundle)
    else:
        policy_for, sf = method(name, world.catalog, bundle)
    t0 = time.time()
    out = run_cohort(world, personas, policy_for, sf, days)
    res = summarize(out["sessions"], days)
    res["probe"] = probe(world, personas, policy_for, sf)
    res.update(seed=seed, method=name, seconds=round(time.time() - t0, 1))
    return res


def run_eval(seeds=(1, 2, 3, 4, 5), methods=None, n_personas=60, days=14, workers=7, models_dir=MODELS, log=print, out_name="eval_results.json", world_kw=None) -> list[dict]:
    """Every (seed, method) in parallel; writes ml/results/<out_name> and returns the results."""
    methods = methods or (BASELINES + list(ABLATIONS))
    jobs = [(s, m, n_personas, days, str(models_dir), world_kw) for s in seeds for m in methods]
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(eval_task, jobs))
    log(f"eval done: {len(jobs)} runs in {time.time() - t0:.0f}s")
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / out_name).write_text(json.dumps(results), encoding="utf-8")
    return results


# ---- formatting -------------------------------------------------------------------------
def _ms(vals):
    """(mean, sample sd) ignoring nan."""
    v = np.array([x for x in vals if not np.isnan(x)])
    return (v.mean(), v.std(ddof=1) if len(v) > 1 else 0.0)


def table(results: list[dict], methods: list[str], keys: list[tuple[str, str, str]], ref: str = "a1_current_server") -> str:
    """keys: (label, field, fmt). Each cell: mean (sd across seeds); delta vs ref in last columns."""
    by = {(r["method"], r["seed"]): r for r in results}
    seeds = sorted({r["seed"] for r in results})
    head = "| method | " + " | ".join(k[0] for k in keys) + " |"
    lines = [head, "|---|" + "---|" * len(keys)]
    for m in methods:
        cells = []
        for label, field, fmt in keys:
            vals = [by[(m, s)][field] for s in seeds if (m, s) in by]
            mu, sd = _ms(vals)
            cells.append(f"{mu:{fmt}} ({sd:{fmt}})")
        lines.append(f"| {m} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def paired(results: list[dict], methods: list[str], field: str, ref: str = "a1_current_server", fmt: str = ".3f") -> str:
    """Per method: mean (sd) of the per-seed difference vs `ref` and in how many seeds it was better."""
    by = {(r["method"], r["seed"]): r for r in results}
    seeds = sorted({r["seed"] for r in results})
    out = []
    for m in methods:
        d = [by[(m, s)][field] - by[(ref, s)][field] for s in seeds if (m, s) in by and (ref, s) in by]
        wins = sum(1 for x in d if x > 0)
        mu, sd = _ms(d)
        out.append(f"{m}: {mu:+{fmt}} (sd {sd:{fmt}}), better than {ref} in {wins}/{len(d)} seeds")
    return "\n".join(out)
