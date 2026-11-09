"""Offline evaluation of ranking v2 (ts_v2) against today's server formula (a1_current_server).

Input: seeds, worlds (normal / stress / wild from harness.WORLDS), readers per type, days.
Output: results/bandit_eval.json = {"runs": [one dict per (world, seed, method)], "gate": synthetic gate,
"paging": paging checks} and a printed table. Nothing is tuned on these numbers.

How a run works:
  1. Training (once per world, on separate training seeds): a cohort of the six reader types reads the
     formula's feed for 14 days; every impression is logged as core.user_events rows would be (view with
     its slot, like, dislike, open_detail, open_source, dwell). bandit.prior.fit turns that log into the
     model, exactly like the weekly job does on real data.
  2. Evaluation (per seed): new cards and new readers (held-out seeds). Each method serves its own feed in
     the loop for 14 days; the taste changers switch halfway.
Metrics (first page of each session, 10 cards): NDCG@10 against true value, P@10 (share of cards on
topics the reader truly likes: hidden topic score >= 0.5), expected dislikes, distinct topics, longest
same-topic run, repeat share vs the last session, macro share (markets, bonds, jobs, inflation, housing,
Fed, savings) and the reader's true macro interest (macro share of their total value over the eligible
cards), days to recover after the taste change (first day back at 90% of the pre-change like ratio),
P@10 for new readers with two follows after 0, 3 and 10 explicit events (a fixed-pool probe), and for
ts_v2 the paging check on the logged events (pages of a frozen scroll never repeat; the same cursor
gives the same page even after new events arrive).
Card vectors are not used by either method, so cards get zero vectors (no embedder needed).
"""
from __future__ import annotations

import json
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from .. import config as C
from ..bandit import features as FT
from ..bandit.gate import synthetic_gate
from ..bandit.params import params
from ..bandit.policy import BanditPolicy, Event, Model, RefCard, keyset_page, score_reference
from ..bandit.prior import fit
from ..data.catalog import Catalog
from ..data.generator import generate_cards
from ..features.uservec import UserState
from ..interfaces import Policy
from ..paths import RESULTS
from ..ranking.baselines import CurrentServer
from ..simulator import World, ndcg_at, run_cohort
from ..simulator.bandit_personas import IS_MACRO, TYPES, cohort
from ..training.train import EVAL_PERSONA_BASE, EVAL_WORLD_BASE, TRAIN_PERSONA_BASE, TRAIN_WORLD_SEEDS
from .harness import WORLDS

DIMS = 4                          # zero card vectors: neither method reads them
RELEVANT_TOPIC = 0.5              # P@10: a card is relevant when its hidden topic score is at least this
PROBE_KS = (0, 3, 10)
METHODS = ("a1_current_server", "ts_v2")
ACTION_BUCKETS = ((0, 5), (5, 15), (15, 30), (30, 60), (60, 10**9))   # explicit events before the session


def _state_factory(p, now):
    return UserState(p.id, DIMS, follows=p.follows, now=now)


class EventLogger:
    """run_cohort logger: every impression as core.user_events-like rows, per reader."""

    def __init__(self, cat):
        self.cat = cat
        self.events: dict[str, list[Event]] = defaultdict(list)

    def before(self, state, page, now, crowd, pos0):
        return state.uid, page, now, pos0

    def after(self, token, outs):
        uid, page, now, pos0 = token
        for i, o in enumerate(outs):
            cid = self.cat.cards[page[i]].id
            t = now + 0.002 * (pos0 + i)
            ev = self.events[uid]
            ev.append(Event(cid, "view", None, t, pos0 + i))
            for key, kind in (("dislike", "dislike"), ("like", "like"), ("detail", "open_detail"), ("src", "open_source")):
                if o[key]:
                    ev.append(Event(cid, kind, None, t))
            ev.append(Event(cid, "dwell", float(o["dwell"]), t))


class Recorder(Policy):
    """Wraps a method for one persona: on the first page of each session it grades the page."""

    def __init__(self, inner, world, persona, sink):
        self.inner, self.world, self.p, self.sink = inner, world, persona, sink
        self.name = inner.name
        self.last_now = None

    def rank(self, state, rows, now, crowd):
        order = self.inner.rank(state, rows, now, crowd)
        if now != self.last_now:
            self.last_now = now
            w, p, cat = self.world, self.p, self.world.catalog
            page = order[:C.PAGE_SIZE]
            seen, dis = state.seen_ids, state.disliked_ids
            elig = np.array([r for r in rows if cat.cards[r].id not in seen and cat.cards[r].id not in dis], dtype=int)
            if len(page) and len(elig):
                taste = w.taste_of(p, now / C.DAY)
                topic = w.L[page] @ taste
                g_all = w.gain(p, elig, now)
                macro_e = IS_MACRO[w.sub_main[elig]]
                cats = [int(cat.cat[r]) for r in page]
                run = best = 1
                for a, b in zip(cats, cats[1:]):
                    run = run + 1 if a == b else 1
                    best = max(best, run)
                self.sink.append(dict(user=p.id, kind=p.kind, now=now, day=int(now // C.DAY) - w.user_start_day,
                                      p10=float((topic >= RELEVANT_TOPIC).mean()),
                                      macro=float(IS_MACRO[w.sub_main[page]].mean()),
                                      macro_true=float(g_all[macro_e].sum() / max(g_all.sum(), 1e-9)),
                                      max_run=best))
        return order


def _world(seed_cards: int, days: int, world_kw: dict):
    cards, lat = generate_cards(seed_cards, days=days + 3)
    cat = Catalog(cards, np.zeros((len(cards), DIMS)))
    return World(cat, lat, **world_kw), cat


def train_model(world_name: str, per_type: int = 10, days: int = 14) -> tuple[dict, dict]:
    """Simulated logs under the formula on a training world -> the ts_v2 model (as rows) and the fit report."""
    widx = list(WORLDS).index(world_name)
    world, cat = _world(TRAIN_WORLD_SEEDS[0] + 100 * widx, days, WORLDS[world_name])
    people = cohort(TRAIN_PERSONA_BASE + 77000 + 1000 * widx, "train", per_type)
    for p in people:
        if p.taste2 is not None:
            p.shift_day = world.user_start_day + days // 2
    log = EventLogger(cat)
    pol = CurrentServer(cat)
    run_cohort(world, people, lambda p: pol, _state_factory, days, logger=log)
    feats = {c.id: FT.card_features(c.category, c.event_type or c.kind, c.source, c.headline) for c in cat.cards}
    words = {c.id: c.word_count for c in cat.cards}
    asof = (world.user_start_day + days) * C.DAY
    model, rep = fit(dict(log.events), feats, words, {p.id: p.follows for p in people}, asof, params(),
                     version=f"sim-{world_name}")
    return {"rows": model.rows(), "version": model.version}, rep


def _recovery(sessions, days):
    """Days until the taste changers are back at 90% of their pre-change like ratio (censored at the end)."""
    sh = [s for s in sessions if s["shift"] and s.get("orc_like10", 0) > 0 and "exp_like10" in s]
    if not sh:
        return float("nan")
    d0 = days // 2
    by_day = defaultdict(list)
    for s in sh:
        by_day[s["day"]].append(s["exp_like10"] / s["orc_like10"])
    pre = [np.mean(by_day[d]) for d in range(max(d0 - 3, 0), d0) if by_day[d]]
    if not pre:
        return float("nan")
    target = 0.9 * float(np.mean(pre))
    for d in range(d0, days):
        if by_day[d] and np.mean(by_day[d]) >= target:
            return float(d - d0)
    return float(days - d0)


def _probe(world, people, make_policy):
    """New readers with two follows: P@10 on a fixed pool after 0, 3 and 10 explicit events."""
    cat = world.catalog
    now = (world.user_start_day + 5) * C.DAY + 12.0
    pool = cat.fresh_rows(now)
    acc = {k: [] for k in PROBE_KS}
    for p in [q for q in people if q.kind == "cold_two_follows"]:
        st = _state_factory(p, now - 1.0)
        pol = make_policy(p)
        order = np.random.default_rng([p.seed, 99]).permutation(pool)
        done: set = set()
        taste = world.taste_of(p, now / C.DAY)

        def measure(k):
            top = pol.rank(st, pool, now, None)[:C.PAGE_SIZE]
            acc[k].append(float((world.L[top] @ taste >= RELEVANT_TOPIC).mean()))
            done.add(k)

        measure(0)
        for i, r in enumerate(order):
            ev, _ = world.behave(p, int(r), 0, now)
            st.observe(cat.cards[r], cat.emb[r], ev, now)
            for k in PROBE_KS:
                if k not in done and st.n_strong >= k:
                    measure(k)
            if len(done) == len(PROBE_KS):
                break
    return {str(k): float(np.mean(v)) if v else float("nan") for k, v in acc.items()}


def _paging(cat, log: EventLogger, model: Model, P, n_checks: int = 40, seed: int = 0) -> dict:
    """For logged sessions: three keyset pages of a frozen scroll while that session's events arrive."""
    rng = np.random.default_rng(seed)
    refs = [RefCard(id=c.id, category=c.category, typ=c.event_type or c.kind, skey=c.source, headline=c.headline,
                    rank_score=c.rank_score, sort_at=c.sort_at, published_at=c.published_at, words=c.word_count)
            for c in cat.cards]
    users = sorted(log.events)
    repeats = mismatched = checked = 0
    for _ in range(n_checks):
        u = users[int(rng.integers(len(users)))]
        evs = log.events[u]
        starts = sorted({round(e.t - (e.slot or 0) * 0.002, 3) for e in evs if e.kind == "view" and e.slot == 0})
        if not starts:
            continue
        asof = starts[int(rng.integers(len(starts)))] - 1e-4
        live = [c for c in refs if asof - 72 < c.sort_at <= asof]          # the For you window is 30 days; 72 h keeps it fast
        s_seed = int(rng.integers(1, 2**31 - 1))
        key, kid, shown = 1e12, "ffffffff-ffff-ffff-ffff-ffffffffffff", []
        for k in range(3):
            known = [e for e in evs if e.t < asof + 0.02 * (k + 1)]         # the session's events so far
            scored = score_reference(u, live, known, [], [], [], model, P, asof, s_seed)
            pg = keyset_page(scored, key, kid, 10)
            again = keyset_page(score_reference(u, live, known + [Event(live[0].id, "like", None, asof + 1)], [], [], [],
                                                model, P, asof, s_seed), key, kid, 10)
            mismatched += [s.id for s in pg] != [s.id for s in again]
            shown += [s.id for s in pg]
            if not pg:
                break
            key, kid = pg[-1].ps, pg[-1].id
        repeats += len(shown) - len(set(shown))
        checked += 1
    return {"scrolls": checked, "repeats": repeats, "same_cursor_mismatches": mismatched}


def eval_task(args) -> dict:
    world_name, seed, method, per_type, days, model_rows = args
    world, cat = _world(EVAL_WORLD_BASE + seed, days, WORLDS[world_name])
    people = cohort(EVAL_PERSONA_BASE + 50000 + seed * 1000, "test", per_type)
    for p in people:
        if p.taste2 is not None:
            p.shift_day = world.user_start_day + days // 2
    P = params()
    model = Model.from_rows(model_rows["rows"], model_rows["version"])
    if method == "ts_v2":
        base = BanditPolicy(cat, model, P)
    elif method.startswith("ts_v2:"):
        from .v3_eval import ts_v2_ablation
        base = ts_v2_ablation(method, cat, model, P)
    elif method.startswith("v3"):
        from ..v3.methods import make_v3
        base = make_v3(method, cat)
    else:
        base = CurrentServer(cat)
    graded: list[dict] = []
    log = EventLogger(cat)
    t0 = time.time()
    out = run_cohort(world, people, lambda p: Recorder(base, world, p, graded), _state_factory, days, logger=log)
    S = [s for s in out["sessions"] if "ndcg10" in s]
    mean = lambda xs: float(np.mean(xs)) if len(xs) else float("nan")
    res = dict(world=world_name, seed=seed, method=method, n_sessions=len(S),
               ndcg10=mean([s["ndcg10"] for s in S]), exp_dis10=mean([s["exp_dis10"] for s in S]),
               exp_like10=mean([s["exp_like10"] for s in S]), cats10=mean([s["cats10"] for s in S]),
               repeat=mean([s["repeat"] for s in S]),
               p10=mean([g["p10"] for g in graded]), max_run=mean([g["max_run"] for g in graded]),
               recovery_days=_recovery(S, days))
    res["ndcg_by_day"] = [mean([s["ndcg10"] for s in S if s["day"] == d]) for d in range(days)]
    res["ndcg_by_actions"] = {f"{lo}-{hi}": mean([s["ndcg10"] for s in S if lo <= s["n_strong"] < hi])
                              for lo, hi in ACTION_BUCKETS}
    anti = [g for g in graded if g["kind"] == "anti_macro" and g["day"] >= 7]
    res["macro_anti"] = mean([g["macro"] for g in anti])
    res["macro_anti_true"] = mean([g["macro_true"] for g in anti])
    res["by_type"] = {t: {"ndcg10": mean([s["ndcg10"] for s in S if s["kind"] == t]),
                          "p10": mean([g["p10"] for g in graded if g["kind"] == t]),
                          "macro": mean([g["macro"] for g in graded if g["kind"] == t]),
                          "macro_true": mean([g["macro_true"] for g in graded if g["kind"] == t])} for t in TYPES}
    res["probe_p10"] = _probe(world, people, lambda p: base)
    if method == "ts_v2":
        res["paging"] = _paging(cat, log, model, P, seed=seed)
    res["seconds"] = round(time.time() - t0, 1)
    return res


def run(seeds=(1, 2, 3, 4, 5), worlds=("normal", "stress", "wild"), per_type=10, days=14, workers=7,
        out_name="bandit_eval.json", log=print) -> dict:
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=workers) as ex:
        trained = dict(zip(worlds, ex.map(train_model, worlds, [per_type] * len(worlds), [days] * len(worlds))))
        log(f"trained {len(trained)} models in {time.time() - t0:.0f}s: "
            + ", ".join(f"{w}: {r[1].get('features', 0)} features, lambda {r[1].get('lam')}, tau {r[1].get('tau')}"
                        for w, r in trained.items()))
        jobs = [(w, s, m, per_type, days, trained[w][0]) for w in worlds for s in seeds for m in METHODS]
        runs = list(ex.map(eval_task, jobs))
    out = {"runs": runs, "gate": synthetic_gate(runs), "models": {w: r[1] for w, r in trained.items()},
           "settings": {"seeds": list(seeds), "per_type": per_type, "days": days}}
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / out_name).write_text(json.dumps(out, default=float), encoding="utf-8")
    log(f"eval done: {len(runs)} runs in {time.time() - t0:.0f}s -> results/{out_name}")
    log(table(out))
    return out


def table(out: dict) -> str:
    """Mean (sd) over seeds per world and method, the per-type P@10 and the gate, as markdown."""
    runs = out["runs"]
    keys = [("NDCG@10", "ndcg10", ".3f"), ("P@10", "p10", ".3f"), ("dislike@10", "exp_dis10", ".4f"),
            ("topics@10", "cats10", ".2f"), ("max run", "max_run", ".2f"), ("repeat", "repeat", ".3f"),
            ("recovery d", "recovery_days", ".1f"), ("anti macro", "macro_anti", ".3f"), ("anti true", "macro_anti_true", ".3f")]
    lines = []
    for w in sorted({r["world"] for r in runs}, key=list(WORLDS).index):
        lines += [f"\n{w}", "| method | " + " | ".join(k[0] for k in keys) + " | new reader P@10 (0/3/10) |",
                  "|---|" + "---|" * (len(keys) + 1)]
        for m in METHODS:
            rs = [r for r in runs if r["world"] == w and r["method"] == m]
            cells = []
            for _, f, fmt in keys:
                v = np.array([r[f] for r in rs], dtype=float)
                cells.append(f"{np.nanmean(v):{fmt}} ({np.nanstd(v, ddof=1) if len(v) > 1 else 0:{fmt}})")
            pr = "/".join(f"{np.nanmean([r['probe_p10'][str(k)] for r in rs]):.3f}" for k in PROBE_KS)
            lines.append(f"| {m} | " + " | ".join(cells) + f" | {pr} |")
        g = out["gate"]["worlds"].get(w, {})
        lines.append(f"gate {w}: {'PASS' if g.get('passed') else 'FAIL'}  " + ", ".join(
            f"{k}={g[k]}" for k in ("ndcg_wins", "ndcg_delta", "dislike_delta", "topics_delta", "recovery_delta",
                                    "macro_anti", "macro_anti_true") if k in g))
        types = sorted({t for r in runs for t in r["by_type"]}, key=TYPES.index)
        lines.append("P@10 by type: " + "; ".join(
            f"{t} " + " vs ".join(f"{np.nanmean([r['by_type'][t]['p10'] for r in runs if r['world'] == w and r['method'] == m]):.3f}"
                                  for m in METHODS) for t in types))
        pg = [r["paging"] for r in runs if r["world"] == w and "paging" in r]
        if pg:
            lines.append(f"ts_v2 paging: {sum(x['scrolls'] for x in pg)} frozen scrolls, {sum(x['repeats'] for x in pg)} repeats, "
                         f"{sum(x['same_cursor_mismatches'] for x in pg)} same-cursor mismatches")
    lines.append(f"\nSYNTHETIC GATE: {'PASS' if out['gate']['passed'] else 'FAIL'}")
    return "\n".join(lines)
