"""Stage 2: four LightGBM heads trained on logged impressions, plus probability calibration.

Heads: p(like), p(dislike), p(open_detail) (binary) and expected completion = dwell / (words x 150 ms)
(regression; walked-away dwell is excluded). Position is a training feature (position bias) and is held
at 0 when serving.
Input to training: the full feature matrix X, labels y, the feature names to keep. Output: `Heads`, which
predicts all four numbers for a feature matrix and saves / loads as plain-text trees under ml/models/
(`<tag>.<head>.txt` plus `<tag>.json` with the feature list and the Platt calibration).
Why plain LightGBM: free, local, fast (milliseconds for 150 cards), deterministic with one thread.
"""
from __future__ import annotations

import json
from pathlib import Path

import lightgbm as lgb
import numpy as np

from .. import config as C
from .. import features as F

HEADS = ("like", "dislike", "detail", "time")

# Monotone constraints (hardening): +1 = prediction may only rise with the feature, -1 = only fall.
# They encode "more similar to what you liked / followed can never lower p(like)" so the trees cannot
# learn odd wiggles that only hold at one noise level. Features not listed are unconstrained.
_POS = {"cos_user": 1, "max_cos_liked": 1, "max_cos_disliked": -1, "cat_aff": 1, "src_aff": 1, "type_aff": 1,
        "followed": 1, "age_h": -1, "position": -1}
MONOTONE = {
    "like": _POS, "detail": _POS, "time": {k: v for k, v in _POS.items() if k != "position"},
    "dislike": {"cos_user": -1, "max_cos_liked": -1, "max_cos_disliked": 1, "cat_aff": -1, "src_aff": -1,
                "type_aff": -1, "followed": -1},
}
# Stronger regularisation used with the monotone constraints (fewer, larger leaves; more L2).
LGB_ROBUST = dict(num_leaves=11, min_data_in_leaf=300, lambda_l2=30.0, feature_fraction=0.7,
                  min_gain_to_split=0.5, monotone_constraints_method="intermediate")
PLATT_ITERATIONS = 50           # Newton steps for the two calibration numbers
ECE_BINS = 10                   # equal-count bins for the calibration error


class Heads:
    """The four boosters, the feature subset they were trained on and the optional calibration."""

    def __init__(self, boosters: dict, keep: list[str], calib: dict | None = None):
        self.boosters, self.keep = boosters, keep
        self.cols = F.columns(keep)
        self.calib = calib or {}          # head -> (a, b): p' = sigmoid(a * logit(p) + b)  (Platt, fitted on validation)

    def predict(self, X: np.ndarray) -> dict[str, np.ndarray]:
        """{head: prediction per row} for an all-feature matrix X (columns are selected here)."""
        Z = X[:, self.cols]
        out = {h: self.boosters[h].predict(Z, num_threads=1) for h in HEADS}
        for h, (a, b) in self.calib.items():
            out[h] = platt_apply(out[h], a, b)
        return out

    def save(self, folder: Path, tag: str) -> None:
        """Write `<tag>.<head>.txt` per head and `<tag>.json` (features, heads, calibration) to folder."""
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        for h, b in self.boosters.items():
            b.save_model(str(folder / f"{tag}.{h}.txt"))
        (folder / f"{tag}.json").write_text(json.dumps({"features": self.keep, "heads": list(HEADS), "calib": self.calib}), encoding="utf-8")

    @staticmethod
    def load(folder: Path, tag: str) -> "Heads":
        """Read a head set written by `save`."""
        folder = Path(folder)
        meta = json.loads((folder / f"{tag}.json").read_text(encoding="utf-8"))
        calib = {h: tuple(v) for h, v in meta.get("calib", {}).items()}
        return Heads({h: lgb.Booster(model_file=str(folder / f"{tag}.{h}.txt")) for h in meta["heads"]}, meta["features"], calib)


def _logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def platt_apply(p: np.ndarray, a: float, b: float) -> np.ndarray:
    """Recalibrated probability sigmoid(a * logit(p) + b)."""
    return 1.0 / (1.0 + np.exp(-(a * _logit(p) + b)))


def platt_fit(p: np.ndarray, y: np.ndarray, iters: int = PLATT_ITERATIONS) -> tuple[float, float]:
    """Two-number logistic recalibration on the logit of the raw prediction (Newton steps, deterministic)."""
    z = _logit(p); a, b = 1.0, 0.0
    for _ in range(iters):
        q = 1.0 / (1.0 + np.exp(-(a * z + b)))
        w = q * (1 - q) + 1e-9
        g = np.array([np.sum((q - y) * z), np.sum(q - y)])
        H = np.array([[np.sum(w * z * z), np.sum(w * z)], [np.sum(w * z), np.sum(w)]]) + 1e-6 * np.eye(2)
        step = np.linalg.solve(H, g)
        a, b = a - step[0], b - step[1]
        if np.abs(step).max() < 1e-8:
            break
    return float(a), float(b)


def ece(p: np.ndarray, y: np.ndarray, bins: int = ECE_BINS) -> float:
    """Expected calibration error over equal-count bins."""
    o = np.argsort(p, kind="stable")
    tot = 0.0
    for idx in np.array_split(o, bins):
        if len(idx):
            tot += len(idx) * abs(float(p[idx].mean()) - float(y[idx].mean()))
    return tot / max(len(p), 1)


def train_heads(X: np.ndarray, y: dict[str, np.ndarray], keep: list[str], robust: bool = False,
                weights: dict[str, np.ndarray] | None = None) -> Heads:
    """X: all-feature matrix; y: like/dislike/detail (0/1), comp (float), comp_ok (bool mask).
    robust: monotone constraints + stronger regularisation. weights: optional per-head sample weights (IPS)."""
    cols = F.columns(keep)
    cat_idx = [i for i, n in enumerate(keep) if n in F.CATEGORICAL]
    out = {}
    for h in HEADS:
        if h == "time":
            m = y["comp_ok"]
            Z, lab, obj = X[m][:, cols], y["comp"][m], "regression"
            wt = weights[h][m] if weights and h in weights else None
        else:
            Z, lab, obj = X[:, cols], y[h], "binary"
            wt = weights[h] if weights and h in weights else None
        ds = lgb.Dataset(Z, label=lab, weight=wt, categorical_feature=cat_idx or "auto", free_raw_data=False,
                         feature_name=[f"f{i}_{n}" for i, n in enumerate(keep)])
        params = dict(C.LGB_PARAMS, objective=obj)
        if robust:
            params.update(LGB_ROBUST)
            params["monotone_constraints"] = [MONOTONE[h].get(n, 0) for n in keep]
        out[h] = lgb.train(params, ds, num_boost_round=C.LGB_ROUNDS[h])
    return Heads(out, keep)
