"""Does the vector + LightGBM ranker generalise beyond the cards it was trained on? (simulated-reader impressions)

Input: the exported impression log of the simulated-reader run (`impressions.jsonl`, one row per served slot with
the outcome) and the card records of the same pool (`cards.json`). Output: `ml/results/real_eval.json` and
`real_eval.md` with held-out metrics for three split types:
  * by card      - GroupKFold on card id: every impression of a card stays on one side (the overfitting test)
  * by reader    - GroupKFold on reader id: a reader the model has never seen
  * by category  - leave one category out: a topic the model has never seen
Why: with a few hundred cards a model can memorise card identities. Random splits hide that; these splits do not.
How: each reader's history is replayed in time order through the same `UserState` / `features.build` the
simulator-trained ranker uses, so the features at each impression are exactly what the ranker could know then
(no future events, no card id, no hidden taste). Heads are trained on viewed impressions only. Baselines: the
server formula score (v5), the v3 formula (v5 + per-reader hours, the Python mirror of the SQL port),
a category-mean model, position order and random.
Simulated readers only: this checks the pipeline and generalisation, not real-reader quality.

Run (from ml/): py -3.13 -m elementml.evaluation.real_eval [--data <impressions-v3 folder>] [--quick]
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold

from .. import config as C
from .. import features as F
from ..bandit.params import params as _v2_params
from ..bandit.policy import Event
from ..data.cards import card_from_json
from ..data.catalog import Catalog
from ..features.embed import Embedder
from ..features.uservec import UserState, make_prior
from ..paths import MODELS, REPO, RESULTS
from ..ranking import heads as heads_mod
from ..ranking.heads import HEADS, ece, train_heads
from ..ranking.utility import utility
from ..v3.reference import card_hours, sql_params, weights as v3_weights

DEFAULT_DATA = REPO / "context" / "sample-users" / "run" / "impressions-v3"
CARD_CAP_SHARE = 0.01          # no card may carry more than 1% of the training rows (weight cap)
NDCG_K = 10
MIN_PAGE_VIEWED, MIN_CAT_ROWS = 5, 300
GATE = dict(max_overfit_gap=0.05, max_ece=0.05)


# ---- load + replay --------------------------------------------------------------------------------------------
def _hours(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() / 3600.0


def load(data: Path):
    raw = json.loads((data / "cards.json").read_text(encoding="utf-8"))
    cards = [card_from_json(r) for r in raw]
    feats_of = {r["id"]: list(r.get("features") or []) for r in raw}
    emb = Embedder().fit(cards)                                   # unsupervised: text only, no labels
    cat = Catalog.build(cards, emb)
    rows = [json.loads(l) for l in (data / "out" / "impressions.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    rows = [r for r in rows if r["card_id"] in cat.index]
    return cards, feats_of, emb, cat, rows


def replay(cards, feats_of, emb, cat, rows, log=print):
    """Rebuild the feature matrix at every impression from the reader's earlier events only."""
    by_reader = defaultdict(list)
    for r in rows:
        by_reader[r["persona_id"]].append(r)
    words_of = {c.id: c.word_count for c in cards}
    P = sql_params()
    Xs, meta = [], defaultdict(list)
    for n_r, (pid, rr) in enumerate(sorted(by_reader.items())):
        pages = defaultdict(list)
        for r in rr:
            pages[(r["served_at"], r["page_no"])].append(r)
        follows = list(rr[0]["reader_before"].get("followed") or [])
        state = UserState(pid, emb.k, follows=follows, prior=make_prior(emb, follows),
                          now=_hours(min(r["served_at"] for r in rr)) - 1.0)
        events: list[Event] = []
        for key in sorted(pages):
            pg = sorted(pages[key], key=lambda r: r["slot"])
            now = _hours(key[0])
            idx = cat.rows_of([r["card_id"] for r in pg])
            slots = np.array([r["slot"] for r in pg], dtype=float)
            X = F.build(state, cat, idx, now, None, state.affinity(now), position=slots)
            b, n, _ = v3_weights(events, feats_of, words_of, now, P)
            hours = np.array([card_hours(feats_of.get(r["card_id"], []), b, n, P) for r in pg])
            srv = X[:, F.NAMES.index("srv_score")]
            for i, r in enumerate(pg):
                o = r["outcome"]
                w = max(float(cat.words[idx[i]]), 1.0)
                dwell = o.get("dwell_ms")
                meta["reader"].append(pid); meta["card"].append(r["card_id"]); meta["cat"].append(cat.cat[idx[i]])
                meta["page"].append(f"{pid}|{key[0]}|{key[1]}"); meta["slot"].append(r["slot"])
                meta["surface"].append(r["surface"] if not r.get("browse_category") else "chip:" + r["browse_category"])
                meta["viewed"].append(bool(o["viewed"])); meta["like"].append(float(o["like"])); meta["dislike"].append(float(o["dislike"]))
                meta["detail"].append(float(o["open_detail"])); meta["source"].append(float(o["open_source"]))
                meta["comp"].append(min((dwell or 0.0) / (w * C.READ_MS_PER_WORD_REF), C.COMPLETION_CAP))
                meta["comp_ok"].append(bool(o["viewed"] and dwell is not None and dwell <= C.DWELL_WALKAWAY_MS))
                meta["eligible"].append(bool(r.get("train_eligible", True)))
                meta["v3"].append(float(srv[i] + hours[i]))
            Xs.append(X)
            # what the reader did becomes state only for pages that carry real outcomes
            if not (pg[0].get("duplicate_page") or pg[0].get("outcome_lost")):
                for i, r in enumerate(pg):
                    o = r["outcome"]
                    if not o["viewed"]:
                        continue
                    t = now + r["slot"] * 1e-4
                    ev = [("view", None)]
                    if o.get("dwell_ms") is not None:
                        ev.append(("dwell", float(o["dwell_ms"])))
                    for k, key2 in (("open_detail", "open_detail"), ("open_source", "open_source"), ("like", "like"), ("dislike", "dislike")):
                        if o.get(key2):
                            ev.append((k, None))
                    state.observe(cat.cards[idx[i]], cat.emb[idx[i]], ev, t)
                    events.append(Event(r["card_id"], "view", None, t, r["slot"]))
                    for kind, ms in ev[1:]:
                        events.append(Event(r["card_id"], kind, ms, t, None))
        if (n_r + 1) % 10 == 0:
            log(f"  replayed {n_r + 1}/{len(by_reader)} readers")
    X = np.vstack(Xs)
    M = {k: np.array(v) for k, v in meta.items()}
    return X, M


# ---- metrics --------------------------------------------------------------------------------------------------
def auc(y, s):
    return float(roc_auc_score(y, s)) if 0 < np.sum(y) < len(y) else float("nan")


def ndcg_at_k(rel, score, k=NDCG_K):
    o = np.argsort(-score, kind="stable")[:k]
    disc = 1.0 / np.log2(np.arange(2, len(o) + 2))
    ideal = np.sort(rel)[::-1][:k]
    idcg = float((ideal * (1.0 / np.log2(np.arange(2, len(ideal) + 2)))).sum())
    return float((rel[o] * disc).sum() / idcg) if idcg > 0 else float("nan")


def page_ndcg(M, mask, score, rng):
    """Mean NDCG@10 over pages (viewed rows only) for a score vector, plus the same for position order and random."""
    out = {"model": [], "served_order": [], "random": []}
    rel_all = M["like"] + 0.5 * M["detail"] + 0.5 * M["source"]
    pages = defaultdict(list)
    for i in np.flatnonzero(mask):
        pages[M["page"][i]].append(i)
    for ids in pages.values():
        ids = np.array(ids)
        rel = rel_all[ids]
        if len(ids) < MIN_PAGE_VIEWED or rel.sum() <= 0:
            continue
        out["model"].append(ndcg_at_k(rel, score[ids]))
        out["served_order"].append(ndcg_at_k(rel, -M["slot"][ids].astype(float)))
        out["random"].append(ndcg_at_k(rel, rng.random(len(ids))))
    return {k: (float(np.nanmean(v)) if v else float("nan")) for k, v in out.items()} | {"pages": len(out["model"])}


# ---- training / cross-validation ------------------------------------------------------------------------------
def card_weights(M, idx):
    """Per-row weight min(1, cap / rows of that card): no card carries more than CARD_CAP_SHARE of the training rows."""
    cards = M["card"][idx]
    u, inv, cnt = np.unique(cards, return_inverse=True, return_counts=True)
    cap = max(CARD_CAP_SHARE * len(idx), 1.0)
    w = np.minimum(1.0, cap / cnt)[inv]
    return {h: w for h in HEADS}


def predict_utility(heads, X, M, idx):
    Xp = X[idx].copy()
    Xp[:, F.NAMES.index("position")] = 0.0                      # position is training-only; held at 0 when serving
    pred = heads.predict(Xp)
    return pred, utility(pred, Xp[:, F.NAMES.index("base_rel")])


def cv(X, M, keep, groups, folds, capw=False, seed=0):
    """Out-of-fold predictions for like / dislike / detail and utility; also train-fold AUC (the overfit gap)."""
    viewed = np.flatnonzero(M["viewed"] & M["eligible"])
    oof = {"like": np.full(len(X), np.nan), "dislike": np.full(len(X), np.nan), "detail": np.full(len(X), np.nan), "util": np.full(len(X), np.nan)}
    tr_auc = defaultdict(list)
    for tr, te in GroupKFold(n_splits=folds).split(viewed, groups=groups[viewed]):
        tr_i, te_i = viewed[tr], viewed[te]
        heads = _train(X, M, tr_i, keep, capw)
        pred, u = predict_utility(heads, X, M, te_i)
        for h in ("like", "dislike", "detail"):
            oof[h][te_i] = pred[h]
        oof["util"][te_i] = u
        ptr, _ = predict_utility(heads, X, M, tr_i)
        for h in ("like", "dislike", "detail"):
            tr_auc[h].append(auc(M[h][tr_i], ptr[h]))
    return oof, {h: float(np.nanmean(v)) for h, v in tr_auc.items()}


def _train(X, M, idx, keep, capw):
    # train_heads indexes X with the row mask for the time head, so pass the training rows only
    Xtr = X[idx]
    y = {"like": M["like"][idx], "dislike": M["dislike"][idx], "detail": M["detail"][idx], "comp": M["comp"][idx], "comp_ok": M["comp_ok"][idx]}
    return train_heads(Xtr, y, keep, robust=True, weights=card_weights(M, idx) if capw else None)


def catmean_oof(M, groups, folds):
    """Baseline: the like / detail rate of the row's category in the training fold (global rate for unseen categories)."""
    viewed = np.flatnonzero(M["viewed"] & M["eligible"])
    out = {"like": np.full(len(M["like"]), np.nan), "dislike": np.full(len(M["like"]), np.nan), "detail": np.full(len(M["like"]), np.nan)}
    for tr, te in GroupKFold(n_splits=folds).split(viewed, groups=groups[viewed]):
        tr_i, te_i = viewed[tr], viewed[te]
        for h in out:
            g = float(M[h][tr_i].mean())
            rate = {c: float(M[h][tr_i][M["cat"][tr_i] == c].mean()) for c in np.unique(M["cat"][tr_i])}
            out[h][te_i] = [rate.get(c, g) for c in M["cat"][te_i]]
    return out


DEFAULT_REG = dict(rounds_scale=1.0, min_leaf=300, l2=30.0, ff=0.7, leaves=11)
SWEEP = [DEFAULT_REG,
         dict(rounds_scale=0.6, min_leaf=300, l2=30.0, ff=0.7, leaves=11),
         dict(rounds_scale=1.0, min_leaf=600, l2=60.0, ff=0.7, leaves=11),
         dict(rounds_scale=0.6, min_leaf=600, l2=60.0, ff=0.6, leaves=7),
         dict(rounds_scale=0.4, min_leaf=600, l2=100.0, ff=0.5, leaves=7),
         dict(rounds_scale=0.6, min_leaf=900, l2=100.0, ff=0.6, leaves=7)]


@contextmanager
def regularisation(cfg):
    """Temporarily set the robust-head regularisation (rounds scale, min rows per leaf, L2, feature fraction, leaves)."""
    old_r, old_p = dict(C.LGB_ROUNDS), dict(heads_mod.LGB_ROBUST)
    try:
        C.LGB_ROUNDS.update({h: max(10, int(v * cfg["rounds_scale"])) for h, v in old_r.items()})
        heads_mod.LGB_ROBUST.update(min_data_in_leaf=cfg["min_leaf"], lambda_l2=cfg["l2"], feature_fraction=cfg["ff"], num_leaves=cfg["leaves"])
        yield
    finally:
        C.LGB_ROUNDS.clear(); C.LGB_ROUNDS.update(old_r)
        heads_mod.LGB_ROBUST.clear(); heads_mod.LGB_ROBUST.update(old_p)


def sweep(X, M, folds=5, log=print):
    """Pick the regularisation on the BY-READER folds only (full variant): best held-out like AUC among configs whose
    overfit gap is <= 0.04 (a margin under the 0.05 line); if none qualifies, the smallest gap. The by-card split is
    then reported untouched by this choice."""
    keep = F.names_without("crowd"); v = np.flatnonzero(M["viewed"] & M["eligible"]); rows = []
    for cfg in SWEEP:
        with regularisation(cfg):
            oof, tr = cv(X, M, keep, M["reader"], folds)
        a = auc(M["like"][v], oof["like"][v]); gap = tr["like"] - a
        rows.append({**cfg, "heldout_reader_auc_like": a, "overfit_gap_like": gap})
        log(f"  sweep {cfg}: AUC {a:.3f} gap {gap:+.3f}")
    ok = [r for r in rows if r["overfit_gap_like"] <= 0.04]
    best = max(ok, key=lambda r: r["heldout_reader_auc_like"]) if ok else min(rows, key=lambda r: r["overfit_gap_like"])
    return {k: best[k] for k in DEFAULT_REG}, rows


def evaluate(X, M, folds=5, quick=False, log=print):
    rng = np.random.default_rng(0)
    elig = M["viewed"] & M["eligible"]
    v = np.flatnonzero(elig)
    base_rates = {h: float(M[h][v].mean()) for h in ("like", "dislike", "detail")}
    variants = {"full": F.names_without("crowd"), "no_srv": F.names_without("crowd", "srv"), "no_vec": F.names_without("crowd", "vec", "rls")}
    if quick:
        variants = {"full": variants["full"]}
    res = {"rows_viewed_eligible": int(len(v)), "base_rates": base_rates, "schemes": {}}
    for scheme, groups in (("by_card", M["card"]), ("by_reader", M["reader"])):
        log(f"split: {scheme}")
        S = {"variants": {}, "baselines": {}}
        cm = catmean_oof(M, groups, folds)
        S["baselines"]["category_mean"] = {h: auc(M[h][v], cm[h][v]) for h in ("like", "dislike", "detail")}
        S["baselines"]["server_formula_v5"] = {"like": auc(M["like"][v], X[v, F.NAMES.index("srv_score")]),
                                               "detail": auc(M["detail"][v], X[v, F.NAMES.index("srv_score")])}
        S["baselines"]["v3_formula"] = {"like": auc(M["like"][v], M["v3"][v]), "detail": auc(M["detail"][v], M["v3"][v])}
        S["baselines"]["position_only"] = {"like": auc(M["like"][v], -M["slot"][v].astype(float))}
        S["ndcg_baselines"] = {"server_formula_v5": page_ndcg(M, elig, X[:, F.NAMES.index("srv_score")], rng),
                               "v3_formula": page_ndcg(M, elig, M["v3"], rng)}
        for name, keep in variants.items():
            for capw in ((False, True) if name == "full" else (False,)):
                tag = name + ("+cardcap" if capw else "")
                log(f"  variant {tag}")
                oof, tr_auc = cv(X, M, keep, groups, folds, capw=capw)
                row = {"heldout_auc": {h: auc(M[h][v], oof[h][v]) for h in ("like", "dislike", "detail")},
                       "train_auc": tr_auc,
                       "ece": {h: float(ece(np.clip(oof[h][v], 1e-6, 1 - 1e-6), M[h][v])) for h in ("like", "dislike", "detail")},
                       "ndcg": page_ndcg(M, elig, oof["util"], rng)}
                row["overfit_gap_like"] = row["train_auc"]["like"] - row["heldout_auc"]["like"]
                S["variants"][tag] = row
        res["schemes"][scheme] = S
    # leave-one-category-out with the full variant
    log("split: leave one category out")
    keep = variants["full"]
    cats = {}
    for c in np.unique(M["cat"][v]):
        te_i = v[M["cat"][v] == c]
        if len(te_i) < MIN_CAT_ROWS:
            continue
        tr_i = v[M["cat"][v] != c]
        heads = _train(X, M, tr_i, keep, False)
        pred, _ = predict_utility(heads, X, M, te_i)
        name = C.CATEGORIES[c] if 0 <= c < len(C.CATEGORIES) else "unknown"
        gl = float(M["like"][tr_i].mean())
        cats[name] = {"rows": int(len(te_i)), "like_rate": float(M["like"][te_i].mean()),
                      "auc_like": auc(M["like"][te_i], pred["like"]), "auc_detail": auc(M["detail"][te_i], pred["detail"]),
                      "auc_like_v3_formula": auc(M["like"][te_i], M["v3"][te_i]),
                      "mean_pred_like": float(pred["like"].mean()), "global_like_rate_train": gl}
    res["leave_one_category_out"] = cats
    return res


def verdict(res):
    """The protocol's pass line, evaluated on the by-card split of the `full` variant."""
    s = res["schemes"]["by_card"]; f = s["variants"]["full"]
    checks = {
        "overfit_gap_like <= %.2f" % GATE["max_overfit_gap"]: f["overfit_gap_like"] <= GATE["max_overfit_gap"],
        "ece_like <= %.2f" % GATE["max_ece"]: f["ece"]["like"] <= GATE["max_ece"],
        "heldout_card_auc_like > category_mean": f["heldout_auc"]["like"] > s["baselines"]["category_mean"]["like"],
        "heldout_card_ndcg > v3_formula ndcg": f["ndcg"]["model"] > s["ndcg_baselines"]["v3_formula"]["model"],
        "heldout_card_ndcg > server_formula ndcg": f["ndcg"]["model"] > s["ndcg_baselines"]["server_formula_v5"]["model"],
    }
    return {"checks": checks, "passed": all(checks.values())}


def train_final(X, M, emb, cfg, folder: Path):
    """Fit the heads on ALL train-eligible viewed rows with the chosen regularisation and save embedder + heads
    (ml/models/real_dev). Nothing reads this folder yet: there is no serving path (see ml/ml.md)."""
    keep = F.names_without("crowd")
    idx = np.flatnonzero(M["viewed"] & M["eligible"])
    with regularisation(cfg):
        heads = _train(X, M, idx, keep, False)
    folder.mkdir(parents=True, exist_ok=True)
    emb.save(folder / "embedder.pkl")
    heads.save(folder, "full")
    (folder / "README.txt").write_text("Trained on SIMULATED readers (dev cards). Heads: like, dislike, detail, time. Features: all except the crowd group. "
                                       "Not served anywhere; see ml/results/real_eval.md.\n", encoding="utf-8")
    return len(idx)


def markdown(res, meta):
    L = ["# Real-impression evaluation (SIMULATED readers, dev cards)", "",
         f"Rows (viewed, train-eligible): {res['rows_viewed_eligible']}; base rates {json.dumps({k: round(v, 3) for k, v in res['base_rates'].items()})}.", ""]
    reg = res.get("regularisation") or {}
    if reg.get("sweep"):
        L += ["## Regularisation (chosen on the by-reader folds only)", "", "| rounds x | min rows/leaf | L2 | feature fraction | leaves | AUC like (by reader) | gap |", "|---|---|---|---|---|---|---|"]
        for r in reg["sweep"]:
            mark = " **chosen**" if all(r[k] == reg["chosen"][k] for k in reg["chosen"]) else ""
            L.append(f"| {r['rounds_scale']} | {r['min_leaf']} | {r['l2']} | {r['ff']} | {r['leaves']} | {r['heldout_reader_auc_like']:.3f} | {r['overfit_gap_like']:+.3f}{mark} |")
        L.append("")
    for scheme, S in res["schemes"].items():
        L += [f"## Split {scheme}", "", "| model | AUC like | AUC dislike | AUC detail | train AUC like | overfit gap | ECE like | NDCG@10 |", "|---|---|---|---|---|---|---|---|"]
        for t, r in S["variants"].items():
            L.append(f"| {t} | {r['heldout_auc']['like']:.3f} | {r['heldout_auc']['dislike']:.3f} | {r['heldout_auc']['detail']:.3f} | {r['train_auc']['like']:.3f} | {r['overfit_gap_like']:+.3f} | {r['ece']['like']:.3f} | {r['ndcg']['model']:.3f} |")
        b = S["baselines"]
        L.append(f"| baseline category mean | {b['category_mean']['like']:.3f} | {b['category_mean']['dislike']:.3f} | {b['category_mean']['detail']:.3f} | | | | |")
        L.append(f"| baseline server formula v5 | {b['server_formula_v5']['like']:.3f} | | {b['server_formula_v5']['detail']:.3f} | | | | {S['ndcg_baselines']['server_formula_v5']['model']:.3f} |")
        L.append(f"| baseline v3 formula | {b['v3_formula']['like']:.3f} | | {b['v3_formula']['detail']:.3f} | | | | {S['ndcg_baselines']['v3_formula']['model']:.3f} |")
        L.append(f"| baseline served order / random | | | | | | | {S['variants']['full']['ndcg']['served_order']:.3f} / {S['variants']['full']['ndcg']['random']:.3f} |")
        L += [f"", f"NDCG pages: {S['variants']['full']['ndcg']['pages']}.", ""]
    L += ["## Leave one category out (full variant)", "", "| held-out category | rows | like rate | AUC like | AUC detail | AUC like v3 formula |", "|---|---|---|---|---|---|"]
    for c, r in res["leave_one_category_out"].items():
        L.append(f"| {c} | {r['rows']} | {r['like_rate']:.3f} | {r['auc_like']:.3f} | {r['auc_detail']:.3f} | {r['auc_like_v3_formula']:.3f} |")
    L += ["", "## Pass line (by-card split, full variant)", ""]
    for k, ok in res["verdict"]["checks"].items():
        L.append(f"- {'PASS' if ok else 'FAIL'}: {k}")
    L += ["", f"Overall: {'PASS' if res['verdict']['passed'] else 'FAIL'}.", "", "Limits: simulated readers only (a few hidden category tastes); the dev pool has no tech, insider or personal-finance cards and almost no energy, world or science, so those topics cannot be judged; chips and trending pages carry no logged page id.", ""]
    L.append(f"Run: {json.dumps(meta)}")
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", default=str(DEFAULT_DATA))
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--quick", action="store_true", help="full variant only")
    ap.add_argument("--sweep", action="store_true", help="choose the regularisation on the by-reader folds first")
    ap.add_argument("--save", action="store_true", help="also fit final heads on all rows and save to ml/models/real_dev")
    ap.add_argument("--out", default=str(RESULTS))
    a = ap.parse_args(argv)
    data = Path(a.data)
    print("loading cards and impressions ...")
    cards, feats_of, emb, cat, rows = load(data)
    print(f"{len(cards)} cards, {len(rows)} impressions; replaying reader histories ...")
    X, M = replay(cards, feats_of, emb, cat, rows)
    print(f"feature matrix {X.shape}; evaluating ...")
    cfg, table = (DEFAULT_REG, None)
    if a.sweep:
        print("regularisation sweep (by-reader folds) ...")
        cfg, table = sweep(X, M, folds=a.folds)
    with regularisation(cfg):
        res = evaluate(X, M, folds=a.folds, quick=a.quick)
    res["regularisation"] = {"chosen": cfg, "sweep": table}
    res["verdict"] = verdict(res)
    if a.save:
        n = train_final(X, M, emb, cfg, MODELS / "real_dev")
        res["saved_model"] = {"folder": "ml/models/real_dev", "rows": int(n)}
        print(f"saved final heads trained on {n} rows to {MODELS / 'real_dev'}")
    meta = {"cards": len(cards), "impressions": len(rows), "features": len(F.NAMES), "folds": a.folds, "simulated": True}
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    (out / "real_eval.json").write_text(json.dumps({"meta": meta, **res}, indent=1, default=float), encoding="utf-8")
    (out / "real_eval.md").write_text(markdown(res, meta), encoding="utf-8")
    print((out / "real_eval.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
