"""Python mirror of the SQL port of ranking v3 (supabase/migrations/20261112000000_ranking_v3.sql).

Input: a reader's raw events (bandit.policy.Event, hours), card features and word counts, as-of time (hours),
the core.rank_params values (v3_* plus the w_* reward weights). Output: what core.v3_reader_weights returns
(b_j, n_j, rbar) and the v3 hours of each card in core.v3_scores. Used by ml/tests/test_v3_sql.py (PGlite
parity). The math is elementml.v3.policy (reader_weights, residual_hours); this file only adds the SQL's
evidence window, the v3_max_evidence_cards cap and the 6-place rounding.
"""
from __future__ import annotations

from typing import Iterable

from ..bandit.params import params as v2_params
from ..bandit.policy import Event, aggregate
from .policy import V3Config, reader_weights, residual_hours

# core.rank_params values after every migration (a test compares them with the SQL). The ranking v3
# migration writes v3_step_extra_cold = 0; 20261117000000_v3_extra_cold.sql sets it to 1 (Drew's decision:
# the extra topic step also for cold readers, as in Python's V3Config).
LATER_MIGRATION_VALUES = {"v3_step_extra_cold": 1.0}
SQL_DEFAULTS = {
    "v3_hours_per_reward": 36.0, "v3_cap_hours": 30.0, "v3_lambda": 2.0, "v3_k0": 3.0,
    "v3_w_topic": 1.0, "v3_w_type": 0.5, "v3_w_source": 0.5, "v3_w_tag": 1.0, "v3_neg_mult": 1.0,
    "v3_step_extra": 2.5, "v3_step_extra_cold": 1.0, "v3_window_days": 30.0, "v3_half_life_days": 14.0,
    "v3_max_evidence_cards": 500.0, "v3_max_candidates": 3000.0, "v3_holdout_pct": 10.0,
    "v3_kill_ratio": 1.2, "v3_kill_min_cards": 500.0,
}


def sql_params(overrides: dict | None = None) -> dict[str, float]:
    """v2/formula params + the v3 SQL defaults, with optional overrides (core.rank_params rows)."""
    P = v2_params()
    P.update(SQL_DEFAULTS)
    if overrides:
        P.update({k: float(v) for k, v in overrides.items()})
    return P


def sql_config(P: dict) -> V3Config:
    """The V3Config the SQL runs with these params (the shipped values = methods.FINAL, 'v3:H=36,cap=30,step_extra=2.5')."""
    return V3Config(hours_per_reward=P["v3_hours_per_reward"], cap_hours=max(P["v3_cap_hours"], 0.0),
                    lam=max(P["v3_lambda"], 0.0), k0=max(P["v3_k0"], 0.0),
                    g_c=P["v3_w_topic"], g_t=P["v3_w_type"], g_s=P["v3_w_source"], g_g=P["v3_w_tag"],
                    neg_mult=P["v3_neg_mult"], solver="diag", explore=0.0, base="formula",
                    step_extra=max(P["v3_step_extra"], 0.0), step_extra_cold=1.0 if P["v3_step_extra_cold"] > 0 else 0.0,
                    window_days=P["v3_window_days"], half_life_days=max(P["v3_half_life_days"], 0.01))


def weights(events: Iterable[Event], feats_of: dict[str, list[str]], words_of: dict[str, int], asof: float,
            P: dict) -> tuple[dict[str, float], dict[str, float], float]:
    """core.v3_reader_weights(user, as_of): (b_j, n_j, rbar); empty dicts = cold start."""
    cfg = sql_config(P)
    aggs = aggregate(list(events), asof, P, cfg.window_days)
    ev = [(cid, a) for cid, a in aggs.items() if a.viewed and feats_of.get(cid)]
    ev.sort(key=lambda t: (t[1].last_at, t[0]), reverse=True)            # SQL: last_at desc, blurb_id desc
    keep = dict(ev[:max(int(P["v3_max_evidence_cards"]), 1)])
    b, n, rbar = reader_weights(keep, feats_of, words_of, asof, cfg, P)
    return b, n, rbar


def card_hours(features: list[str], b: dict[str, float], n: dict[str, float], P: dict) -> float:
    """The v3 hours of one card in core.v3_scores (0 when the reader has no evidence)."""
    if not n:
        return 0.0
    return round(residual_hours(features, b, n, sql_config(P)), 6)
