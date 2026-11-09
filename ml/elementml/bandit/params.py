"""Every number ranking v2 reads, with the same names and start values as the core.rank_params rows.

Input: nothing (constants). Output: `DEFAULTS` (key -> value) and `LEAN_TAGS`.
Why one table: the SQL feed reads these keys from core.rank_params; the Python mirror reads them from here
(or from a dict exported from the database), so both always agree on what a value means.

New keys for ranking v2 start with `v2_`. The other keys already exist in core.rank_params and are reused
unchanged (signal weights, dwell rules, seen penalties, topic step), so the reward of a card is exactly the
signal the live formula already uses.
"""
from __future__ import annotations

DEFAULTS: dict[str, float] = {
    # ---- ranking v2 (new rows in core.rank_params) ----------------------------------------
    "v2_hours_per_reward": 12.0,     # one unit of expected reward (one like) is worth 12 h of freshness
    "v2_cap_hours": 18.0,            # the personal term is clamped to +-18 h
    "v2_explore": 1.0,               # draw width: theta = mu + v2_explore * sigma * z
    "v2_follow_pseudo": 3.0,         # a follow counts as 3 pseudo-observations ...
    "v2_follow_reward": 0.5,         # ... each with reward +0.5, on the followed topic
    "v2_prior_lean": 0.15,           # prior lean added to mu0 of every v2_lean_tag_<tag> feature (about +1.8 h)
    "v2_min_readers": 20.0,          # a trained mu0 needs at least this many readers, else the hand prior (0)
    "v2_propensity_cap": 3.0,        # inverse-propensity weight 1/propensity(slot) is capped at 3
    "v2_holdout_pct": 10.0,          # share of readers (by id hash) who keep the formula while v2 is on
    "v2_kill_ratio": 1.2,            # daily check: back to mode 1 if treatment dislikes > 1.2 x holdout's
    "v2_kill_min_cards": 500.0,      # ... only with at least this many cards shown in each group
    "v2_lambda_default": 5.0,        # prior strength (pseudo-events) when the model has no group value
    "v2_tau_default": 0.5,           # reward noise (sd) when the model has none
    "v2_reader_weight_cap": 20.0,    # training: one reader adds at most this much weight to a population mean
    "v2_trend_prior_n": 10.0,        # Trending v2: prior strength m (readers) of the Bayesian average
    "v2_trend_points_per_reward": 3.0,   # Trending v2: one reward unit = 3 buzz points (a like is 3 points)
    # ---- existing rows reused unchanged -----------------------------------------------------
    "w_like": 1.0, "w_dislike": -1.0, "w_open_detail": 0.5, "w_open_source": 0.5,
    "w_dwell_long": 0.25, "w_dwell_skip": -0.15, "w_view": 0.0,
    "dwell_skip_ms": 1500.0, "dwell_walkaway_ms": 120000.0,
    "card_cap_pos_hours": 1.5, "card_cap_neg_hours": -1.0,
    "dwell_long_ms": 8000.0, "dwell_long_min_ms": 6000.0, "dwell_ms_per_word": 150.0,
    "affinity_days": 30.0, "signal_half_life_days": 14.0, "for_you_window_days": 30.0,
    "seen_penalty_hours": 100.0, "seen_view_penalty_hours": 24.0,
    "foryou_category_step_hours": 0.75, "foryou_cold_step_hours": 4.0, "foryou_cold_events": 5.0,
    # Trending (existing, used by the v2 Bayesian average)
    "trend_max_hours": 6.0, "trend_max_neg_hours": 3.0, "trend_half_points": 8.0,
}

# rank_params rows v2_lean_tag_<tag> = 1 switch a tag's lean on (0 = off)
LEAN_TAGS: tuple[str, ...] = ("rates", "inflation", "jobs", "growth", "markets")

SLOT_BUCKETS = 20                # propensities for slots 0..19; slot 20 and later share bucket 20

# Settings that are new in ranking v2 (for context/settings.md and the docs), (key, value, meaning)
SETTINGS_TABLE = [(k, v, "") for k, v in DEFAULTS.items() if k.startswith("v2_")]


def params(overrides: dict | None = None) -> dict[str, float]:
    """DEFAULTS with optional overrides (for example rows read from core.rank_params)."""
    p = dict(DEFAULTS)
    if overrides:
        p.update({k: float(v) for k, v in overrides.items()})
    return p
