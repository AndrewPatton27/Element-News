"""Offline evaluation of ranking v3 against today's formula (and ts_v2), with the v2 harness.

Input: method names (see v3/methods.py), worlds, seeds. Output: results/<out>.json and a markdown table
(mean (sd) over seeds, paired NDCG wins vs the formula, the synthetic gate per candidate).
Tuning uses seeds 101+ (other cards, other readers); the reported numbers use the held-out seeds 1-5.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from ..bandit.gate import synthetic_gate
from ..paths import RESULTS
from .bandit_eval import eval_task, train_model
from .harness import WORLDS

REF = "a1_current_server"


def ts_v2_ablation(method: str, cat, model, P):
    """Diagnosis only. "ts_v2:lam=1,lean=0,explore=0,onformula=1": the trained v2 model with its prior strength
    forced to lam, the macro lean set to lean, the draw width set, and (onformula=1) its hours added on top
    of the full formula score instead of replacing the formula's personal terms."""
    from ..bandit.policy import BanditPolicy
    from ..ranking.baselines import CurrentServer
    kw = dict(p.split("=") for p in method.split(":", 1)[1].split(",") if p)
    P = dict(P)
    if "lam" in kw:
        model.lam = {g: float(kw["lam"]) for g in ("c", "t", "s", "g")}
    if "lean" in kw:
        P["v2_prior_lean"] = float(kw["lean"])
    if "explore" in kw:
        P["v2_explore"] = float(kw["explore"])
    if "mu0" in kw and float(kw["mu0"]) == 0:
        model.mu0 = {}
    pol = BanditPolicy(cat, model, P)
    pol.name = method
    if kw.get("onformula") == "1":
        srv = CurrentServer(cat)

        class OnFormula:
            name = method

            def rank(self, state, rows, now, crowd):
                return srv.rank(state, rows, now, crowd,
                                extra=lambda rr: pol.scores(state, rr, now) - (cat.base[rr] - now))
        return OnFormula()
    return pol
EMPTY_MODEL = {"rows": [], "version": "none"}


def run(methods, worlds=("normal", "stress", "wild"), seeds=(1, 2, 3, 4, 5), per_type=10, days=14, workers=7,
        out_name="v3_eval.json", log=print) -> dict:
    t0 = time.time()
    methods = list(dict.fromkeys([REF] + list(methods)))
    with ProcessPoolExecutor(max_workers=workers) as ex:
        models = {w: EMPTY_MODEL for w in worlds}
        if "ts_v2" in methods:
            for w, (m, _) in zip(worlds, ex.map(train_model, worlds, [per_type] * len(worlds), [days] * len(worlds))):
                models[w] = m
        jobs = [(w, s, m, per_type, days, models[w]) for w in worlds for s in seeds for m in methods]
        runs = list(ex.map(eval_task, jobs))
    out = {"runs": runs, "methods": methods, "settings": {"seeds": list(seeds), "per_type": per_type, "days": days},
           "gates": {m: synthetic_gate(runs, cand=m) for m in methods if m != REF}}
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / out_name).write_text(json.dumps(out, default=float), encoding="utf-8")
    log(f"{len(runs)} runs in {time.time() - t0:.0f}s -> results/{out_name}")
    log(table(out))
    return out


def table(out: dict) -> str:
    runs, methods = out["runs"], out["methods"]
    keys = [("NDCG@10", "ndcg10", ".3f"), ("P@10", "p10", ".3f"), ("dislike@10", "exp_dis10", ".3f"),
            ("topics@10", "cats10", ".2f"), ("recovery d", "recovery_days", ".1f"), ("anti macro", "macro_anti", ".3f")]
    lines = []
    for w in [x for x in WORLDS if any(r["world"] == x for r in runs)]:
        lines += [f"\n{w}", "| method | " + " | ".join(k[0] for k in keys) + " | NDCG wins | new P@10 0/3/10 |",
                  "|---|" + "---|" * (len(keys) + 2)]
        ref = {r["seed"]: r for r in runs if r["world"] == w and r["method"] == REF}
        for m in methods:
            rs = sorted([r for r in runs if r["world"] == w and r["method"] == m], key=lambda r: r["seed"])
            cells = []
            for _, f, fmt in keys:
                v = np.array([r[f] for r in rs], dtype=float)
                cells.append(f"{np.nanmean(v):{fmt}} ({np.nanstd(v, ddof=1) if len(v) > 1 else 0:{fmt}})")
            wins = sum(r["ndcg10"] > ref[r["seed"]]["ndcg10"] for r in rs if r["seed"] in ref)
            pr = "/".join(f"{np.nanmean([r['probe_p10'][k] for r in rs]):.3f}" for k in ("0", "3", "10"))
            lines.append(f"| {m} | " + " | ".join(cells) + f" | {wins}/{len(rs)} | {pr} |")
        types = list(rs[0]["by_type"]) if rs else []
        for m in methods:
            rs = [r for r in runs if r["world"] == w and r["method"] == m]
            lines.append(f"P@10 by type {m}: " + "; ".join(
                f"{t} {np.nanmean([r['by_type'][t]['p10'] for r in rs]):.3f}" for t in types))
    for m, g in out.get("gates", {}).items():
        lines.append(f"gate {m}: {'PASS' if g['passed'] else 'FAIL'} " + "; ".join(
            f"{w}: " + ("pass" if c.get("passed") else "fail ("
                        + ",".join(k[:-3] for k in ("ndcg_ok", "dislike_ok", "topics_ok", "recovery_ok", "macro_ok")
                                   if not c.get(k, True)) + ")")
            for w, c in g["worlds"].items()))
    return "\n".join(lines)
