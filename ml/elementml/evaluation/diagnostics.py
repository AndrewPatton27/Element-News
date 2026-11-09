"""Hardening diagnostics: how good are the heads, and how calibrated, on logs from each world?

`head_diag` collects logged impressions (mixed logging policy, held-out world seeds 5200..) in the normal,
stress and domain-randomised worlds, then scores every saved head set on them: AUC and expected
calibration error (ECE) per head, plus the AUC of the single feature cos_user (how much signal the
reader vector itself carries in that world). Run: python -m elementml.cli diag [sub ...]

`OraclePolicy` is the headroom check: it reads the simulator's hidden taste, so it is NOT a ranker and
lives here, next to the evaluation, never in ranking/ or serving/.
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from .. import features as F
from ..paths import MODELS
from ..ranking.heads import Heads, ece
from ..training.train import _collect, auc, world_params

DIAG_SEEDS = {"normal": 5200, "stress": 5201}       # held-out world seeds for the head diagnostics


def head_diag(subs=("",), n_personas=50, days=14, workers=3, vcfg=None) -> dict:
    """AUC and ECE of each saved head set (models/<sub>/full.*) on fresh normal- and stress-world logs."""
    jobs = [(s, n_personas, days, str(MODELS / "embedder.pkl"), world_params(s, w), vcfg) for w, s in DIAG_SEEDS.items()]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        parts = dict(zip(DIAG_SEEDS, ex.map(_collect, jobs)))
    out = {}
    for w, (X, y) in parts.items():
        row = {"n": int(len(X)), "like_rate": float(y["like"].mean()), "dislike_rate": float(y["dislike"].mean()),
               "auc_like_cos_user_only": auc(y["like"], X[:, F.NAMES.index("cos_user")]),
               "auc_dislike_cos_user_only": auc(y["dislike"], -X[:, F.NAMES.index("cos_user")])}
        for sub in subs:
            h = Heads.load(MODELS / sub if sub else MODELS, "full")
            p = h.predict(X)
            tag = sub or "original"
            for k in ("like", "dislike", "detail"):
                row[f"{tag}:auc_{k}"] = auc(y[k], p[k])
                row[f"{tag}:ece_{k}"] = ece(p[k], y[k])
        out[w] = row
    return out


# ---- headroom diagnostic: an oracle that knows each reader's hidden taste but not the per-card noise ----
class OraclePolicy:
    """NOT a ranker: reads the simulator's hidden taste. Ranks unseen fresh cards by the noise-free expected
    gain, i.e. the best any ranker could do without knowing each reader's idiosyncratic reaction to each card.
    Used only to measure how much headroom each world leaves."""
    name = "z_oracle_nonoise"

    def __init__(self, world, persona):
        import copy
        self.w = copy.copy(world)
        self.w.noise_mult = 0.0
        self.p = persona

    def rank(self, state, rows, now, crowd):
        cat = self.w.catalog
        seen, dis = state.seen_ids, state.disliked_ids
        e = np.array([r for r in rows if cat.cards[r].id not in seen and cat.cards[r].id not in dis], dtype=int)
        if len(e) == 0:
            return e
        g = self.w.gain(self.p, e, now)
        return e[np.argsort(-g, kind="stable")]


def oracle_method(world, bundle):
    """(policy_for, state_factory) for the oracle, in the same shape as policies.method."""
    from .policies import state_factory
    return (lambda p: OraclePolicy(world, p)), state_factory(bundle.embedder)


def main(argv=None) -> None:
    """`diag [sub ...]`: print head_diag for the named model sub-folders ("original" = models/ itself)."""
    args = sys.argv[1:] if argv is None else list(argv)
    subs = tuple(args) or ("",)
    subs = tuple("" if s == "original" else s for s in subs)
    print(json.dumps(head_diag(subs), indent=1))


if __name__ == "__main__":
    main()
