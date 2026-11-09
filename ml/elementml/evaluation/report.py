"""Markdown tables from evaluation results.

Input: JSON files in ml/results/ written by the harness. Output: `write_report` -> results/eval_tables.md
(main comparison, ablations, learning curves, shifted taste, persona types); `write_stress` ->
results/eval_stress_tables.md; `compare(files)` -> mean (sd) per method and paired differences vs a
reference, printed by `python -m elementml.cli compare <files>`.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from ..paths import RESULTS
from .harness import KS, _ms, paired, table
from .policies import ABLATIONS

SHIFT_ROWS_EXTRA = ["e_no_explore", "e_no_mmr", "e_no_prior", "e_static_step"]   # extra rows in the curve tables
MAIN = ["b_recency_importance", "c_popularity", "a2_current_device", "a1_current_server", "d_vectors_only", "e_full"]


def _curve(results, m, getter, keys):
    seeds = sorted({r["seed"] for r in results})
    by = {(r["method"], r["seed"]): r for r in results}
    cells = []
    for k in keys:
        mu, _ = _ms([getter(by[(m, s)], k) for s in seeds if (m, s) in by])
        cells.append(f"{mu:.3f}")
    return cells


def write_report(path: Path | None = None) -> str:
    """Tables from results/eval_results.json, written to `path` (default results/eval_tables.md) and returned."""
    results = json.loads((RESULTS / "eval_results.json").read_text(encoding="utf-8"))
    seeds = sorted({r["seed"] for r in results})
    have = {r["method"] for r in results}
    ABL = ["e_full"] + [m for m in ABLATIONS if m != "e_full" and m in have]
    n = len(seeds)
    out = [f"Seeds: {n}. Each cell is the mean over seeds (sd across seeds in brackets).\n"]
    K1 = [("NDCG@10", "ndcg10", ".3f"), ("exp. like rate@10", "exp_like10", ".3f"), ("real like rate@10", "like10_real", ".3f"),
          ("exp. dislike@10", "exp_dis10", ".3f"), ("real dislike@10", "dis10_real", ".3f"),
          ("exp. dwell/slot@10 ms", "exp_dwell10", ".0f"), ("real dwell/slot@10 ms", "dwell10_real", ".0f"), ("session dwell ms", "dwell_total", ".0f"), ("cards/session", "n_cards", ".1f"),
          ("categories@10", "cats10", ".2f"), ("subtopics@10", "subs10", ".2f"), ("repeat vs last session", "repeat", ".3f")]
    out += ["### Main comparison (in the loop, 14 days, held-out personas)\n", table(results, MAIN, K1), ""]
    out += ["### Paired difference vs the current server formula (a1), per metric\n"]
    for lab, f, fmt in [("NDCG@10", "ndcg10", ".3f"), ("expected like rate@10", "exp_like10", ".3f"), ("real like rate@10", "like10_real", ".3f"),
                        ("dwell/slot ms", "dwell10_real", ".0f"), ("session dwell ms", "dwell_total", ".0f"), ("expected dislike@10", "exp_dis10", ".3f")]:
        out += [f"**{lab}**\n", "```", paired(results, [m for m in MAIN if m != "a1_current_server"], f, fmt=fmt), "```", ""]
    out += ["### Ablations (each row removes one part of e_full)\n", table(results, ABL, K1), ""]
    out += ["Paired vs e_full (NDCG@10):\n", "```", paired(results, ABL[1:], "ndcg10", ref="e_full"), "```", "",
            "Paired vs e_full (expected like rate@10):\n", "```", paired(results, ABL[1:], "exp_like10", ref="e_full"), "```", "",
            "Paired vs e_full (session dwell ms):\n", "```", paired(results, ABL[1:], "dwell_total", ref="e_full", fmt=".0f"), "```", ""]
    # early sessions
    out += ["### First three days (cold start inside the loop)\n", table(results, MAIN, [("NDCG@10", "early_ndcg10", ".3f"), ("exp. like@10", "early_like10", ".3f")]), ""]
    # probe curve
    for lab, key in (("NDCG@10", "ndcg10"), ("expected like rate@10", "like10")):
        out += [f"### New-user learning curve (probe: same random exposure for every method), {lab} after k explicit events (like/dislike/detail/source tap)\n",
                "| method | " + " | ".join(f"k={k}" for k in KS) + " |", "|---|" + "---|" * len(KS)]
        for m in MAIN + [x for x in SHIFT_ROWS_EXTRA if x in have]:
            out.append(f"| {m} | " + " | ".join(_curve(results, m, lambda r, k, key=key: r["probe"][str(k)][key], KS)) + " |")
        out.append("")
    out += ["Impressions consumed before k explicit events (mean, same for all methods up to rounding): "
            + ", ".join(f"k={k}: {np.mean([r['probe'][str(k)]['impressions'] for r in results if r['method'] == 'e_full']):.0f}" for k in KS), ""]
    # in-loop curve
    out += ["### In-loop learning curve: NDCG@10 of a session's first page by how many explicit events the reader had before it\n",
            "| method | " + " | ".join(f"{k}+" for k in KS) + " |", "|---|" + "---|" * len(KS)]
    for m in MAIN:
        out.append(f"| {m} | " + " | ".join(_curve(results, m, lambda r, k: r["loop_curve"][str(k)]["ndcg10"], KS)) + " |")
    out.append("")
    # shift
    days = sorted(int(d) for d in results[0]["shift_days"])
    shift_at = len(days) // 2
    out += [f"### Shifted taste: share of the best possible expected like rate@10 reached, by day (taste changes at day {shift_at})\n",
            "| method | " + " | ".join(f"d{d}" for d in days) + " | pre (d3-6) | post d7-8 | post d9-13 | days to recover |", "|---|" + "---|" * (len(days) + 4)]
    for m in MAIN + [x for x in SHIFT_ROWS_EXTRA if x in have]:
        cells, curve = [], []
        for d in days:
            mu, _ = _ms([r["shift_days"][str(d)] for r in results if r["method"] == m])
            curve.append(mu); cells.append(f"{mu:.2f}")
        pre = float(np.nanmean(curve[3:shift_at])); p1 = float(np.nanmean(curve[shift_at:shift_at + 2])); p2 = float(np.nanmean(curve[shift_at + 2:]))
        rec = next((d - shift_at for d in range(shift_at, len(days)) if curve[d] >= 0.9 * pre), None)
        out.append(f"| {m} | " + " | ".join(cells) + f" | {pre:.2f} | {p1:.2f} | {p2:.2f} | {rec if rec is not None else '>%d' % (len(days) - shift_at)} |")
    out.append("")
    # by kind
    kinds = sorted({k for r in results for k in r["by_kind"]})
    out += ["### NDCG@10 by persona type (mean over seeds)\n", "| method | " + " | ".join(kinds) + " |", "|---|" + "---|" * len(kinds)]
    for m in MAIN:
        out.append(f"| {m} | " + " | ".join(f"{np.nanmean([r['by_kind'].get(k, {}).get('ndcg10', np.nan) for r in results if r['method'] == m]):.3f}" for k in kinds) + " |")
    out.append("")
    out += ["### Seconds per run (mean)\n", ", ".join(f"{m}: {np.mean([r['seconds'] for r in results if r['method'] == m]):.0f}s" for m in MAIN)]
    text = "\n".join(out)
    (path or RESULTS / "eval_tables.md").write_text(text, encoding="utf-8")
    return text


def write_stress() -> str:
    """Same ranker, a differently-behaving world: 2x idiosyncratic noise, 0.6x topic signal, stronger position bias."""
    results = json.loads((RESULTS / "eval_stress.json").read_text(encoding="utf-8"))
    ms = ["a2_current_device", "a1_current_server", "d_vectors_only", "e_full"]
    keys = [("NDCG@10", "ndcg10", ".3f"), ("exp. like rate@10", "exp_like10", ".3f"), ("real like rate@10", "like10_real", ".3f"),
            ("dwell/slot@10 ms", "dwell10_real", ".0f"), ("session dwell ms", "dwell_total", ".0f"), ("exp. dislike@10", "exp_dis10", ".3f")]
    out = ["### Stress world (models trained on the normal world, evaluated where noise is 2x, topic signal 0.6x, position decay 0.15)\n",
           table(results, ms, keys), "", "```", paired(results, ["a2_current_device", "d_vectors_only", "e_full"], "ndcg10"),
           paired(results, ["a2_current_device", "d_vectors_only", "e_full"], "exp_like10"),
           paired(results, ["a2_current_device", "d_vectors_only", "e_full"], "dwell_total", fmt=".0f"), "```"]
    text = "\n".join(out)
    (RESULTS / "eval_stress_tables.md").write_text(text, encoding="utf-8")
    return text


# ---- hardening: compare methods across result files ------------------------------------
CMP_KEYS = [("NDCG@10", "ndcg10", ".3f"), ("exp like@10", "exp_like10", ".3f"), ("real like@10", "like10_real", ".3f"),
            ("exp dislike@10", "exp_dis10", ".3f"), ("real dislike@10", "dis10_real", ".3f"),
            ("session dwell ms", "dwell_total", ".0f"), ("cats@10", "cats10", ".2f"), ("first 3 days NDCG", "early_ndcg10", ".3f")]
LOWER_BETTER = {"exp_dis10", "dis10_real"}


def compare(files: list[str], ref: str = "a1_current_server", methods: list[str] | None = None) -> str:
    """Mean (sd) per method, then paired difference vs `ref` with the number of seeds where the method is better."""
    results = []
    for f in files:
        results += json.loads((RESULTS / f).read_text(encoding="utf-8"))
    by = {}
    for r in results:
        by[(r["method"], r["seed"])] = r
    seeds = sorted({s for _, s in by})
    ms = methods or list(dict.fromkeys(r["method"] for r in results))
    head = "| method | " + " | ".join(k[0] for k in CMP_KEYS) + " |"
    lines = [f"Seeds: {seeds}", head, "|---|" + "---|" * len(CMP_KEYS)]
    for m in ms:
        cells = []
        for _, f, fmt in CMP_KEYS:
            mu, sd = _ms([by[(m, s)][f] for s in seeds if (m, s) in by])
            cells.append(f"{mu:{fmt}} ({sd:{fmt}})")
        lines.append(f"| {m} | " + " | ".join(cells) + " |")
    if any(m == ref for m in ms):
        lines += ["", f"Paired vs {ref}: mean difference [seeds better / seeds]", "| method | " + " | ".join(k[0] for k in CMP_KEYS) + " |",
                  "|---|" + "---|" * len(CMP_KEYS)]
        for m in ms:
            if m == ref:
                continue
            cells = []
            for _, f, fmt in CMP_KEYS:
                d = [by[(m, s)][f] - by[(ref, s)][f] for s in seeds if (m, s) in by and (ref, s) in by]
                better = sum(1 for x in d if (x < 0 if f in LOWER_BETTER else x > 0))
                cells.append(f"{np.mean(d):+{fmt}} [{better}/{len(d)}]" if d else "-")
            lines.append(f"| {m} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def main(argv=None) -> None:
    """`python -m elementml.evaluation.report [--ref=<method>] <files under results/>`."""
    import sys
    args = sys.argv[1:] if argv is None else list(argv)
    ref = "a1_current_server"
    if args and args[0].startswith("--ref="):
        ref = args[0][6:]; args = args[1:]
    print(compare(args, ref=ref))


if __name__ == "__main__":
    main()
