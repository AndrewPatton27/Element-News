"""Go / no-go for switching For you to ranking v2 (foryou_ml_mode = 2). All parts are required.

1. Synthetic (offline evaluation, every world): NDCG@10 better than the formula in >= 4 of 5 seeds;
   expected dislikes in the top 10 at most +0.005; distinct topics in the top 10 at least formula - 0.3;
   recovery after a taste change at most 1 day slower; the anti-macro reader's macro share of the top 10
   from day 7 on at most 1.2 x their true interest.
2. Real replay (inverse propensity on logged For you pages; needs >= 14 days and >= 200 readers): the 90%
   bootstrap lower bound of the per-reader gain is above 0.
3. Drew approves (outside this code: he sets foryou_ml_mode = 2 by hand).
`gate_passed` in core.ml_models = parts 1 and 2. The feed also needs part 3 (the mode).

Replay estimator, in plain words: on each logged page the reader acted on some cards at some slots. A
card's observed reward divided by the chance a card at its logged slot is looked at, times the chance at
the slot v2 would have put it, estimates what v2's order would have earned from the same cards
(a position-based model; weights capped at v2_propensity_cap). Gain = that minus the logged reward,
averaged per page, then per reader; the bootstrap resamples readers.
"""
from __future__ import annotations

from collections import defaultdict

import numpy as np

from .policy import HOUR_PER_DAY, Event, Model, RefCard, aggregate, card_reward, score_reference, slot_bucket

NDCG_MIN_WINS, DISLIKE_MAX_UP, TOPICS_MAX_DOWN, RECOVERY_MAX_UP, MACRO_MAX_RATIO = 4, 0.005, 0.3, 1.0, 1.2
REPLAY_MIN_DAYS, REPLAY_MIN_READERS = 14, 200
REWARD_WINDOW_H = 1.0          # events within 1 hour after a page count as its outcome


def synthetic_gate(results: list[dict], ref: str = "a1_current_server", cand: str = "ts_v2") -> dict:
    """results: one dict per (world, seed, method) with ndcg10, exp_dis10, cats10, recovery_days,
    macro_anti, macro_anti_true. Returns per-world criteria and `passed`."""
    worlds = sorted({r["world"] for r in results})
    out = {"worlds": {}, "passed": bool(worlds)}
    for w in worlds:
        by = {(r["method"], r["seed"]): r for r in results if r["world"] == w}
        seeds = sorted({s for (m, s) in by if m == cand and (ref, s) in by})
        if not seeds:
            out["worlds"][w] = {"passed": False, "why": "no paired seeds"}
            out["passed"] = False
            continue
        A = [by[(ref, s)] for s in seeds]; B = [by[(cand, s)] for s in seeds]
        mean = lambda rows, k: float(np.nanmean([r[k] for r in rows]))
        wins = sum(b["ndcg10"] > a["ndcg10"] for a, b in zip(A, B))
        need = NDCG_MIN_WINS if len(seeds) >= 5 else len(seeds)
        c = {
            "ndcg_wins": f"{wins}/{len(seeds)}", "ndcg_ok": wins >= need,
            "ndcg_delta": round(mean(B, "ndcg10") - mean(A, "ndcg10"), 4),
            "dislike_delta": round(mean(B, "exp_dis10") - mean(A, "exp_dis10"), 4),
            "topics_delta": round(mean(B, "cats10") - mean(A, "cats10"), 3),
            "recovery_delta": round(mean(B, "recovery_days") - mean(A, "recovery_days"), 2),
            "macro_anti": round(mean(B, "macro_anti"), 4), "macro_anti_true": round(mean(B, "macro_anti_true"), 4),
        }
        c["dislike_ok"] = c["dislike_delta"] <= DISLIKE_MAX_UP
        c["topics_ok"] = c["topics_delta"] >= -TOPICS_MAX_DOWN
        c["recovery_ok"] = c["recovery_delta"] <= RECOVERY_MAX_UP
        c["macro_ok"] = c["macro_anti"] <= MACRO_MAX_RATIO * c["macro_anti_true"]
        c["passed"] = all(c[k] for k in ("ndcg_ok", "dislike_ok", "topics_ok", "recovery_ok", "macro_ok"))
        out["worlds"][w] = c
        out["passed"] = out["passed"] and c["passed"]
    return out


def bootstrap_lower(values: list[float], q: float = 0.05, n: int = 2000, seed: int = 0) -> float:
    """Lower q quantile of the bootstrap mean (q = 0.05 gives the lower end of a 90% interval)."""
    v = np.asarray(values, dtype=float)
    if len(v) == 0:
        return float("nan")
    rng = np.random.default_rng(seed)
    means = v[rng.integers(0, len(v), size=(n, len(v)))].mean(axis=1)
    return float(np.quantile(means, q))


def replay_gains(pages: list[dict], events_by_user: dict[str, list[Event]], cards: dict[str, RefCard],
                 follows: dict[str, list[str]], model: Model, P: dict, seed: int = 1) -> dict[str, list[float]]:
    """Per reader, the per-page gain of v2's order over the logged order (see the module text).
    pages: {user_id, surface, holdout, as_of (h), shown_at (h), card_ids}; only For you pages are used."""
    gains: dict[str, list[float]] = defaultdict(list)
    cap = P["v2_propensity_cap"]
    prop = lambda s: max(model.prop.get(slot_bucket(s), 1.0), 1.0 / cap)
    for pg in pages:
        if pg.get("surface") != "for_you":
            continue
        u, ids = pg["user_id"], [i for i in pg["card_ids"] if i in cards]
        if len(ids) < 2:
            continue
        evs = events_by_user.get(u, [])
        t0 = pg["shown_at"]
        after = aggregate([e for e in evs if e.card in set(ids)], t0 + REWARD_WINDOW_H, P, REWARD_WINDOW_H / HOUR_PER_DAY)
        r = {c: card_reward(after[c], cards[c].words, P) if c in after else 0.0 for c in ids}
        # v2 may only know what happened before the page (a later like or dislike must not leak in); its
        # evidence is every card the reader acted on before then, as in SQL
        before = [e for e in evs if e.t < pg["as_of"]]
        ev_cards = [cards[e.card] for e in before if e.card in cards]
        scored = score_reference(u, [cards[c] for c in ids], before, follows.get(u, []), (), (), model, P, pg["as_of"],
                                 seed, evidence_cards=ev_cards)
        new_slot = {s.id: k for k, s in enumerate(scored)}
        old = sum(r.values())
        new = sum(r[c] * min(prop(new_slot.get(c, len(ids))) / prop(k), cap) for k, c in enumerate(ids))
        gains[u].append((new - old) / len(ids))
    return dict(gains)


def replay_gate(pages: list[dict], gains: dict[str, list[float]]) -> dict:
    """Part 2: enough data, then the bootstrap lower bound of the per-reader mean gain."""
    fy = [p for p in pages if p.get("surface") == "for_you"]
    days = len({int(p["shown_at"] // HOUR_PER_DAY) for p in fy})
    readers = len(gains)
    out = {"days": days, "readers": readers, "pages": len(fy)}
    if days < REPLAY_MIN_DAYS or readers < REPLAY_MIN_READERS:
        out.update(passed=False, why=f"needs >= {REPLAY_MIN_DAYS} days and >= {REPLAY_MIN_READERS} readers")
        return out
    per_reader = [float(np.mean(v)) for v in gains.values() if v]
    lo = bootstrap_lower(per_reader)
    out.update(mean_gain=round(float(np.mean(per_reader)), 5), lower90=round(lo, 5), passed=bool(lo > 0))
    return out


def decide(synthetic: dict, replay: dict) -> bool:
    """gate_passed for core.ml_models: synthetic and replay both passed."""
    return bool(synthetic.get("passed")) and bool(replay.get("passed"))
