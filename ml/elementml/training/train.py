"""Training: simulate logged impressions under a mixed logging policy, then fit the embedder and the LightGBM heads.

Input: seeds and sizes only (everything is simulated). Output: files in ml/models/ (or a sub-folder):
embedder.pkl, <tag>.<head>.txt and <tag>.json per head set, train_report.json (sizes, AUCs, calibration).
`train_all` builds the original head sets (full + four ablations); `train_variant` one hardened set.
With real data the same steps would read core.user_events plus the logged pages instead of the simulator.

Train personas and train worlds use seed ranges that the evaluation never uses (see TRAIN_* / EVAL_* below).
Labels the heads see: like, dislike, open_detail and completion = dwell / (words x 150 ms), taken from the event
stream only (kind + dwell_ms). The logger copies a whitelist of keys from the simulator's outcome record.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from .. import config as C
from .. import features as F
from ..data.catalog import Catalog
from ..data.generator import generate_cards
from ..evaluation.policies import MixedPolicy, TAGS, state_factory
from ..features.embed import Embedder
from ..paths import MODELS
from ..ranking.heads import Heads, ece, platt_fit, train_heads
from ..simulator import World, make_persona, run_cohort

EMBED_SEED = 4999                                             # card corpus the embedder is fitted on
TRAIN_WORLD_SEEDS = [5000, 5001, 5002, 5003, 5004, 5005]     # 5005 = validation cohort
TRAIN_PERSONA_BASE = 500000
EVAL_WORLD_BASE = 100                                         # evaluation worlds: 101..; personas 900000+
EVAL_PERSONA_BASE = 900000
WHITELIST = ("like", "dislike", "detail", "dwell")           # the only outcome keys the logger reads


class ImpressionLogger:
    """Records the feature row and the labels of every impression a cohort run produces.
    Labels come from a whitelist of the outcome keys, so hidden simulator values never reach training."""

    def __init__(self, cat: Catalog, mix=None):
        self.cat, self.X, self.y = cat, [], {"like": [], "dislike": [], "detail": [], "comp": [], "comp_ok": []}
        self.mix, self.random_arm = mix, []       # which rows the uniform-random arm served (for IPS)

    def before(self, state, page, now, crowd, pos0):
        pos = pos0 + np.arange(len(page))
        X = F.build(state, self.cat, page, now, crowd, state.affinity(now), position=pos)
        return X, self.cat.words[page], getattr(self.mix, "last_arm", "") == "random"

    def after(self, token, outs):
        X, words, rnd = token
        n = len(outs)
        self.X.append(X[:n])
        self.random_arm += [rnd] * n
        for i, o in enumerate(outs):
            o = {k: o[k] for k in WHITELIST}
            self.y["like"].append(float(o["like"])); self.y["dislike"].append(float(o["dislike"]))
            self.y["detail"].append(float(o["detail"]))
            self.y["comp"].append(min(o["dwell"] / max(words[i] * C.READ_MS_PER_WORD_REF, 1.0), C.COMPLETION_CAP))
            self.y["comp_ok"].append(o["dwell"] <= C.DWELL_WALKAWAY_MS)

    def arrays(self):
        """(X, y): stacked features and label arrays, plus y["random_arm"] for inverse-propensity weights."""
        X = np.vstack(self.X)
        y = {k: np.array(v, dtype=float if k != "comp_ok" else bool) for k, v in self.y.items()}
        y["random_arm"] = np.array(self.random_arm, dtype=bool)
        return X, y


def world_params(world_seed: int, spec: str) -> dict:
    """Training-world behaviour. 'normal' = the default world; 'stress' = the stress world (diagnostic only);
    'dr' = domain randomisation: every training world draws its own noise level, topic-signal strength and
    position decay from wide ranges, so the heads cannot fit one noise level. The third test world's
    structural changes (moods, drift, bursty sessions, mistaps, exponential position curve) are NOT in this range."""
    if spec == "normal":
        return {}
    if spec == "stress":
        return dict(noise_mult=2.0, taste_scale=0.6, pos_decay=0.15)
    if spec == "dr":
        r = np.random.default_rng([world_seed, 77])
        return dict(noise_mult=float(r.uniform(0.8, 2.4)), taste_scale=float(r.uniform(0.5, 1.1)),
                    pos_decay=float(r.uniform(0.03, 0.22)))
    raise KeyError(spec)


def _collect(args):
    """One training world: (world_seed, n_personas, days, embedder_path, world_kw, vcfg) -> (X, y). Runs in a worker."""
    world_seed, n_personas, days, embedder_path, world_kw, vcfg = args
    emb = Embedder.load(Path(embedder_path))
    cards, lat = generate_cards(world_seed, days=days + 3)
    cat = Catalog.build(cards, emb)
    world = World(cat, lat, **world_kw)
    personas = [make_persona(TRAIN_PERSONA_BASE + world_seed * 1000 + i, "train", shift=(i % 6 == 0)) for i in range(n_personas)]
    for p in personas:
        if p.taste2 is not None:
            p.shift_day = world.user_start_day + days // 2
    mix = MixedPolicy(cat, emb, seed=world_seed)
    logger = ImpressionLogger(cat, mix)
    run_cohort(world, personas, lambda p: mix, state_factory(emb, vcfg=vcfg), days, logger=logger)
    X, y = logger.arrays()
    return X, y


def fit_embedder(path: Path, days: int = 20) -> Embedder:
    """Fit the embedder on the EMBED_SEED corpus and save it to `path`."""
    cards, _ = generate_cards(EMBED_SEED, days=days)
    emb = Embedder().fit(cards)
    emb.save(path)
    return emb


def auc(y, s):
    """ROC AUC, or nan when y has only one class."""
    from sklearn.metrics import roc_auc_score
    return float(roc_auc_score(y, s)) if 0 < np.sum(y) < len(y) else float("nan")


def train_all(n_personas: int = 50, days: int = 14, workers: int = 6, models_dir: Path = MODELS, log=print):
    """Original training: embedder + every TAGS head set into models_dir, validation AUCs in train_report.json."""
    models_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    emb_path = models_dir / "embedder.pkl"
    fit_embedder(emb_path)
    log(f"embedder fitted ({time.time() - t0:.0f}s)")
    jobs = [(s, n_personas, days, str(emb_path), {}, None) for s in TRAIN_WORLD_SEEDS]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        parts = list(ex.map(_collect, jobs))
    log(f"logs collected: {sum(len(p[0]) for p in parts)} impressions ({time.time() - t0:.0f}s)")
    val = parts[-1]
    tr = parts[:-1]
    X = np.vstack([p[0] for p in tr]); y = {k: np.concatenate([p[1][k] for p in tr]) for k in tr[0][1]}
    report = {"n_train": int(len(X)), "n_val": int(len(val[0])),
              "base_rates": {k: float(np.mean(y[k])) for k in ("like", "dislike", "detail")}}
    for tag, drop in TAGS.items():
        keep = F.names_without(*drop) if drop else list(F.NAMES)
        heads = train_heads(X, y, keep)
        heads.save(models_dir, tag)
        if tag == "full" or tag == "no_vec":
            pv = heads.predict(val[0])
            m = val[1]["comp_ok"]
            r2 = 1 - np.sum((val[1]["comp"][m] - pv["time"][m]) ** 2) / np.sum((val[1]["comp"][m] - val[1]["comp"][m].mean()) ** 2)
            report[tag] = {"auc_like": auc(val[1]["like"], pv["like"]), "auc_dislike": auc(val[1]["dislike"], pv["dislike"]),
                           "auc_detail": auc(val[1]["detail"], pv["detail"]), "r2_completion": float(r2)}
        log(f"trained heads '{tag}' ({time.time() - t0:.0f}s)")
    # feature importance of the full like head (gain)
    full = Heads.load(models_dir, "full")
    imp = full.boosters["like"].feature_importance("gain")
    report["like_head_top_features"] = [(n, float(v)) for n, v in sorted(zip(full.keep, imp), key=lambda t: -t[1])[:8]]
    (models_dir / "train_report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    log(json.dumps(report, indent=1))
    return report


# ---- hardening: train variants into a sub-folder of models/ ------------------------------
DR_WORLD_SEEDS = list(range(5100, 5110))      # domain-randomised training worlds (5109 = validation)
IPS_MAX_WEIGHT = 5.0                          # inverse-propensity weights are clipped here


def propensity(y: dict, X: np.ndarray, head: str, max_pos: int = 40) -> np.ndarray:
    """Examination curve by slot from the uniform-random logging arm (no relevance confounding there):
    rate(slot) / rate(0), smoothed over +-2 slots, forced non-increasing, floored at 0.2."""
    pos = X[:, F.NAMES.index("position")].astype(int)
    m = y["random_arm"]
    rate = np.ones(max_pos)
    base = None
    for k in range(max_pos):
        sel = m & (np.abs(pos - k) <= 2)
        r_ = (y[head][sel].sum() + 1.0) / (sel.sum() + 10.0)
        if base is None:
            base = r_
        rate[k] = r_ / base
    return np.minimum.accumulate(np.clip(rate, 0.2, 1.0))


def train_variant(sub: str, spec: str = "dr", robust: bool = True, pos_mode: str = "feature", calibrate: bool = True,
                  vcfg=None, n_personas: int = 50, days: int = 14, workers: int = 7, log=print, seeds=None, drop=()):
    """Train one hardened head set into models/<sub>/ (embedder copied from models/).
    pos_mode 'feature': position is a feature held at 0 when serving (original); 'ips': no position feature,
    rows weighted by 1 / examination(slot) estimated from the random arm (clipped at 5)."""
    import shutil
    t_start = time.time()
    out_dir = MODELS / sub
    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy(MODELS / "embedder.pkl", out_dir / "embedder.pkl")
    seeds = seeds or (DR_WORLD_SEEDS if spec == "dr" else TRAIN_WORLD_SEEDS)
    t0 = time.time()
    jobs = [(s, n_personas, days, str(out_dir / "embedder.pkl"), world_params(s, spec), vcfg) for s in seeds]
    with ProcessPoolExecutor(max_workers=workers) as ex:
        parts = list(ex.map(_collect, jobs))
    log(f"[{sub}] logs: {sum(len(p[0]) for p in parts)} impressions ({time.time() - t0:.0f}s)")
    val, tr = parts[-1], parts[:-1]
    X = np.vstack([p[0] for p in tr]); y = {k: np.concatenate([p[1][k] for p in tr]) for k in tr[0][1]}
    keep = F.names_without(*drop) if drop else list(F.NAMES)
    weights = None
    if pos_mode == "ips":
        keep = [n for n in keep if n != "position"]
        weights = {}
        pos = X[:, F.NAMES.index("position")].astype(int).clip(0, 39)
        for h in ("like", "detail", "dislike"):
            curve = propensity(y, X, h)
            weights[h] = np.minimum(1.0 / curve[pos], IPS_MAX_WEIGHT)
        weights["time"] = np.ones(len(X))
    t_fit = time.time()
    heads = train_heads(X, y, keep, robust=robust, weights=weights)
    pv_raw = heads.predict(val[0])
    rep = {"sub": sub, "spec": spec, "robust": robust, "pos_mode": pos_mode, "drop": list(drop), "n_train": int(len(X)), "n_val": int(len(val[0])),
           "vcfg": repr(vcfg), "worlds": {str(s): world_params(s, spec) for s in seeds}}
    if calibrate:
        heads.calib = {h: platt_fit(pv_raw[h], val[1][h]) for h in ("like", "dislike", "detail")}
    pv = heads.predict(val[0])
    for h in ("like", "dislike", "detail"):
        rep[f"auc_{h}"] = auc(val[1][h], pv[h])
        rep[f"ece_{h}_raw"] = ece(pv_raw[h], val[1][h]); rep[f"ece_{h}"] = ece(pv[h], val[1][h])
    heads.save(out_dir, "full")
    rep["seconds_total"] = round(time.time() - t_start, 1)
    rep["seconds_fit"] = round(time.time() - t_fit, 1)
    (out_dir / "train_report.json").write_text(json.dumps(rep, indent=1), encoding="utf-8")
    log(json.dumps({k: v for k, v in rep.items() if k != "worlds"}))
    return rep
