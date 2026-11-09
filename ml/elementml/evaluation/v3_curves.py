"""Learning curves from results/v3_eval.json: NDCG@10 by explicit actions before the session and by day,
plus paired per-seed differences vs the formula. `python -m elementml.evaluation.v3_curves [file] [method]`."""
from __future__ import annotations

import json
import sys

import numpy as np

from ..paths import RESULTS

REF = "a1_current_server"


def curves(path=RESULTS / "v3_eval.json", cand="v3:H=36,cap=30,step_extra=1.5") -> str:
    d = json.loads(open(path, encoding="utf-8").read())
    lines = []
    for w in ("normal", "stress", "wild"):
        for m in (REF, "ts_v2", cand):
            rs = [r for r in d["runs"] if r["world"] == w and r["method"] == m]
            if not rs:
                continue
            ba = {k: np.nanmean([r["ndcg_by_actions"][k] for r in rs]) for k in rs[0]["ndcg_by_actions"]}
            bd = np.nanmean([r["ndcg_by_day"] for r in rs], axis=0)
            lines.append(f"{w} {m}: by actions " + " ".join(f"{k}:{v:.3f}" for k, v in ba.items())
                         + " | day 0,1,2,3,13: " + " ".join(f"{x:.3f}" for x in list(bd[:4]) + [bd[-1]]))
        by = {(r["method"], r["seed"]): r["ndcg10"] for r in d["runs"] if r["world"] == w}
        diffs = [by[(cand, s)] - by[(REF, s)] for s in sorted({s for m, s in by if m == cand})]
        lines.append(f"{w} paired diff {cand} - formula: mean {np.mean(diffs):+.3f}, min {min(diffs):+.3f}, max {max(diffs):+.3f}")
    return "\n".join(lines)


if __name__ == "__main__":
    print(curves(*sys.argv[1:]))
