"""Model-value table: one row per variant x world x seed, from every results/*.json evaluation file,
plus inference time (micro-benchmark), training time and model size per variant.

Input: the result files listed in FILES (missing ones are skipped), the model folders, and
results/inference_ms.json. Output: results/model_value.csv and results/model_value_summary.md.
Run: python -m elementml.cli value [--bench]   (--bench re-measures inference ms; otherwise reuses results/inference_ms.json)
"""
from __future__ import annotations

import csv
import json
import statistics
import sys
import time
from pathlib import Path

import numpy as np

from ..paths import MODELS, RESULTS
from .harness import KS
from .policies import HARDENED, models_dir_for, parse_spec

BENCH_REPS = 25                 # timed rank() calls per variant (the median is reported)

# result file -> (world, split). split: "test" = seeds 1-5, "val" = seeds 11-13 (used for tuning)
FILES = {
    "eval_results.json": ("normal", "test"), "final_normal.json": ("normal", "test"), "value_normal.json": ("normal", "test"),
    "eval_stress.json": ("stress", "test"), "final_stress.json": ("stress", "test"), "value_stress.json": ("stress", "test"),
    "final_wild.json": ("wild", "test"), "value_wild.json": ("wild", "test"),
    "diag_stress_val.json": ("stress", "val"), "vgrid_stress_val.json": ("stress", "val"), "b2_stress_val.json": ("stress", "val"),
    "b3_stress_val.json": ("stress", "val"), "b4_stress_val.json": ("stress", "val"), "b5_stress_val.json": ("stress", "val"),
    "vgrid_normal_val.json": ("normal", "val"), "b3_normal_val.json": ("normal", "val"), "b4_normal_val.json": ("normal", "val"),
    "b5_normal_val.json": ("normal", "val"),
}
# original ablations -> head-set tag in models/; methods without LightGBM heads
ORIG_TAG = {"e_no_crowd": "no_crowd", "e_no_vecfeat": "no_vec", "e_no_aff": "no_aff", "e_no_posfeat": "no_pos"}
NO_MODEL = {"a1_current_server", "a2_current_device", "b_recency_importance", "c_popularity", "z_oracle_nonoise"}


def model_folder(name: str) -> tuple[Path | None, str]:
    """(folder, tag) of the LightGBM heads a variant uses, or (None, '') if it uses none."""
    if name in NO_MODEL or name.startswith("d") or name == "e_no_gbdt":
        return None, ""
    if name in ORIG_TAG:
        return MODELS, ORIG_TAG[name]
    if name in HARDENED or "+" in name:
        sp = parse_spec(HARDENED.get(name, name))
        if sp["base"] == "d":
            return None, ""
        return models_dir_for(name, MODELS), "full"
    return MODELS, "full"


def model_size_kb(name: str) -> float:
    """Size of the heads plus the embedder a variant needs, in KB."""
    folder, tag = model_folder(name)
    emb = (MODELS / "embedder.pkl").stat().st_size if (name.startswith(("d", "e", "h")) and name not in NO_MODEL) else 0
    if folder is None:
        return round(emb / 1024, 1)
    heads = sum(p.stat().st_size for p in folder.glob(f"{tag}.*.txt"))
    return round((heads + emb) / 1024, 1)


def train_seconds(name: str) -> float | str:
    """Training time from the matching train_report.json ("" when not recorded)."""
    folder, _ = model_folder(name)
    if folder is None:
        return 0.0 if name in NO_MODEL or name.startswith("d") else ""
    if folder == MODELS:
        rep = MODELS / "orig_timing" / "train_report.json"     # retrained copy of the original heads, timed
    else:
        rep = folder / "train_report.json"
        if folder.name == "nr":
            rep = MODELS / "nr_timing" / "train_report.json"   # identical retrain of h_full's heads, timed
    if rep.exists():
        return json.loads(rep.read_text(encoding="utf-8")).get("seconds_total", "")
    return ""


def shift_recovery(r: dict) -> float | str:
    """Days after the taste shift until the method is back at 90% of its own pre-shift level."""
    days = sorted(int(d) for d in r["shift_days"])
    curve = [r["shift_days"][str(d)] for d in days]
    sa = len(days) // 2
    pre = float(np.nanmean(curve[3:sa]))
    for d in range(sa, len(days)):
        if curve[d] >= 0.9 * pre:
            return d - sa
    return f">{len(days) - sa}"


def bench(names: list[str], reps: int = BENCH_REPS) -> dict:
    """Median wall-clock ms of one rank() call over the 72 h pool (about 360 cards), single process, for a
    reader with about 60 impressions of history. Same state and pool for every variant."""
    from ..data.catalog import Catalog
    from ..data.generator import generate_cards
    from ..features.crowd import CrowdTables
    from ..simulator import World, make_persona
    from .policies import Bundle, method
    out = {}
    bundles = {}
    cards, lat = generate_cards(101, days=8)
    for name in names:
        if name == "z_oracle_nonoise":
            continue
        d = models_dir_for(name, MODELS)
        if d not in bundles:
            bundles[d] = Bundle.load(d)
        b = bundles[d]
        cat = Catalog.build(cards, b.embedder)
        world = World(cat, lat)
        try:
            policy_for, sf = method(name, cat, b)
        except KeyError:
            continue
        p = make_persona(990001, "bench")
        now = 6 * 24.0 + 12.0
        st = sf(p, now - 30)
        pool = cat.fresh_rows(now - 1)
        for i, r in enumerate(np.random.default_rng(5).permutation(pool)[:60]):
            ev, _ = world.behave(p, int(r), i % 10, now - 1)
            st.observe(cat.cards[r], cat.emb[r], ev, now - 1)
        pool = cat.fresh_rows(now)
        crowd = CrowdTables.empty(cat.n)
        pol = policy_for(p)
        pol.rank(st, pool, now, crowd)
        ts = []
        for _ in range(reps):
            t0 = time.perf_counter(); pol.rank(st, pool, now, crowd); ts.append((time.perf_counter() - t0) * 1000)
        out[name] = round(statistics.median(ts), 2)
    return out


FIELDS = ["variant", "world", "split", "seed", "ndcg10", "like_rate10", "dislike_rate10", "like_rate10_expected",
          "dislike_rate10_expected", "dwell_per_slot_ms", "session_ms", "categories10", "first3days_ndcg10"] + \
         [f"coldstart_ndcg10_k{k}" for k in KS] + ["shift_recovery_days", "inference_ms", "train_s", "model_kb"]


def rows() -> list[dict]:
    """One dict per (variant, world, seed) from every results file in FILES (first occurrence wins)."""
    seen, out = set(), []
    for f, (world, split) in FILES.items():
        p = RESULTS / f
        if not p.exists():
            continue
        for r in json.loads(p.read_text(encoding="utf-8")):
            key = (r["method"], world, r["seed"])
            if key in seen:                                     # same deterministic run stored twice
                continue
            seen.add(key)
            row = dict(variant=r["method"], world=world, split=split, seed=r["seed"], ndcg10=r["ndcg10"],
                       like_rate10=r["like10_real"], dislike_rate10=r["dis10_real"], like_rate10_expected=r["exp_like10"],
                       dislike_rate10_expected=r["exp_dis10"], dwell_per_slot_ms=r["dwell10_real"], session_ms=r["dwell_total"],
                       categories10=r["cats10"], first3days_ndcg10=r["early_ndcg10"], shift_recovery_days=shift_recovery(r))
            for k in KS:
                row[f"coldstart_ndcg10_k{k}"] = r["probe"][str(k)]["ndcg10"]
            out.append(row)
    return out


# component value: (label, variant, reference) -- metric gain of `variant` over `reference`, paired by seed
COMPONENTS = [
    ("Today's server formula vs importance x recency", "a1_current_server", "b_recency_importance"),
    ("Reader vector alone (original) vs server formula", "d_vectors_only", "a1_current_server"),
    ("+ importance/freshness term on the vector", "d_hard_cos", "d_vectors_only"),
    ("RLS reader model instead of cosine (with importance term)", "d_hard", "d_hard_cos"),
    ("Original full pipeline vs server formula", "e_full", "a1_current_server"),
    ("Hardened full pipeline vs server formula", "h_full", "a1_current_server"),
    ("Hardened vs original full pipeline", "h_full", "e_full"),
    ("Domain-randomised training (vs h_full)", "h_full_dr", "h_full"),
    ("RLS features in the GBDT (h_full minus them)", "h_full", "h_no_rls"),
    ("Server-score feature (learned gate)", "h_full", "h_no_srv"),
    ("Monotone + regularised trees", "h_full", "h_no_monotone"),
    ("Platt calibration", "h_full", "h_no_calib"),
    ("No exploration slots (vs with them)", "h_full", "h_with_explore"),
    ("Utility mix vs p(like) head alone", "h_full", "hx_like_only"),
    ("Utility mix vs p(dislike) head alone", "h_full", "hx_dislike_only"),
    ("Utility mix vs p(detail) head alone", "h_full", "hx_detail_only"),
    ("Utility mix vs dwell head alone", "h_full", "hx_dwell_only"),
    ("Explicit evidence gate k=5 (vs none)", "h_gate5", "h_full"),
    ("Inverse-propensity training instead of position feature", "h_ips", "h_full_dr"),
    ("Popularity vs server formula", "c_popularity", "a1_current_server"),
]


def summary(R: list[dict]) -> str:
    """Markdown table: gain of each COMPONENTS variant over its reference, per world, paired by seed."""
    by = {(r["variant"], r["world"], r["seed"]): r for r in R if r["split"] == "test"}
    lines = ["Gain of the first variant over the second, test seeds 1-5, paired by seed: mean (sd) [seeds better/seeds].",
             "NDCG@10 and real like/dislike rate in the top 10.\n",
             "| component | world | NDCG@10 | like rate | dislike rate (lower is better) |", "|---|---|---|---|---|"]
    for label, a, b in COMPONENTS:
        for w in ("normal", "stress", "wild"):
            seeds = [s for s in range(1, 6) if (a, w, s) in by and (b, w, s) in by]
            if not seeds:
                continue
            cells = []
            for f, low in (("ndcg10", False), ("like_rate10", False), ("dislike_rate10", True)):
                d = [by[(a, w, s)][f] - by[(b, w, s)][f] for s in seeds]
                better = sum(1 for x in d if (x < 0 if low else x > 0))
                sd = float(np.std(d, ddof=1)) if len(d) > 1 else 0.0
                cells.append(f"{np.mean(d):+.3f} ({sd:.3f}) [{better}/{len(d)}]")
            lines.append(f"| {label} | {w} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def main(argv=None):
    """Rebuild model_value.csv and model_value_summary.md (re-benchmark with --bench)."""
    argv = argv if argv is not None else sys.argv[1:]
    R = rows()
    names = sorted({r["variant"] for r in R})
    inf_path = RESULTS / "inference_ms.json"
    if "--bench" in argv or not inf_path.exists():
        inf = bench(names)
        inf_path.write_text(json.dumps(inf, indent=1), encoding="utf-8")
    inf = json.loads(inf_path.read_text(encoding="utf-8"))
    meta = {n: (inf.get(n, ""), train_seconds(n), model_size_kb(n)) for n in names}
    for r in R:
        r["inference_ms"], r["train_s"], r["model_kb"] = meta[r["variant"]]
    R.sort(key=lambda r: (r["world"], r["split"], r["variant"], r["seed"]))
    with open(RESULTS / "model_value.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        for r in R:
            w.writerow({k: (round(v, 5) if isinstance(v, float) else v) for k, v in r.items()})
    text = summary(R)
    (RESULTS / "model_value_summary.md").write_text(text, encoding="utf-8")
    print(f"{len(R)} rows, {len(names)} variants -> results/model_value.csv")
    print(text)


if __name__ == "__main__":
    main()
