"""Ranking v3: the live For you formula stays the base; a per-reader residual adds a bounded personal term.

Input: a reader's per-card signal ledger (likes, dislikes, detail and source opens, longest dwell, fade),
their follows, the candidate cards and their features (topic c:, story type t:, source s:, tags g:, the same
features as ranking v2, so core.v2_features / core.tag_rules can be reused in SQL).
Output: hours added to the formula's score per card, and a feed order (formula's topic step + diversify).

The math, in plain words. For every card the reader looked at in the last 30 days:
    r_i  = the card's reward (like +1, detail +0.5, source +0.5, long look +0.25, quick skip -0.15,
           dislike -1; capped to -1..1.5: exactly the existing signal weights)
    f_i  = 14-day fade
    rbar = (sum f r) / (sum f + k0)          the reader's own average reward (shrunk toward 0)
    d_i  = r_i - rbar                        CENTERED: "better or worse than this reader's usual card"
Per feature j (diagonal model, one GROUP BY in SQL):
    n_j  = sum f x_ij            s_j = sum f x_ij d_i
    b_j  = s_j / (lam + n_j)                 prior mean 0: no population pull; grows with the reader's evidence
Optional full ridge (Python job, hourly): b = (X'FX + lam I)^-1 X'F d.
Card term:
    raw  = sum_j g_group(j) x_cj b_j         group weights: topic, type, source, tag
    hours = clamp(H * raw, -cap, +cap)
    score = formula score (follow boost, affinity, explore, trend, seen penalty) + hours
With no evidence every b_j is 0, so a new reader gets exactly today's formula. Thompson draws are optional
(b_j + e * tau / sqrt(lam + n_j) * z, z fixed by reader, feature and session) and off by default.

Why centered rewards: most views end in a long look (+0.25), so uncentered rewards make every feature the
reader was shown look good, which is how v2 drifted toward macro for everyone.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Optional

import numpy as np

from .. import config as C
from ..bandit import features as FT
from ..bandit.params import params as v2_params
from ..bandit.policy import Agg, card_reward, normal_draw
from ..interfaces import Policy
from ..ranking.baselines import CurrentServer

GROUPS = ("c", "t", "s", "g")


@dataclass(frozen=True)
class V3Config:
    hours_per_reward: float = 24.0   # H: one unit of centered reward on a card's features = 24 h of freshness
    cap_hours: float = 24.0          # the residual is clamped to +-cap
    lam: float = 2.0                 # ridge strength in pseudo-cards (prior mean 0)
    k0: float = 3.0                  # shrinkage of the reader's own average reward toward 0
    g_c: float = 1.0                 # group weights: topic
    g_t: float = 0.5                 # story type
    g_s: float = 0.5                 # source
    g_g: float = 1.0                 # tags (subtopic-like keywords)
    neg_mult: float = 1.0            # multiplier on negative card terms
    solver: str = "diag"             # "diag" (SQL GROUP BY) | "ridge" (full solve, hourly job)
    explore: float = 0.0             # Thompson width (0 = off)
    tau: float = 0.5                 # reward noise sd for the draws
    base: str = "formula"            # "formula" (full v4 score) | "base_follow" (rank_score + follow only)
    step_extra: float = 0.0          # extra hours per better same-topic card ahead (diversity guard)
    window_days: float = 30.0
    half_life_days: float = 14.0

    def with_(self, **kw) -> "V3Config":
        return replace(self, **kw)

    def group_weight(self, j: str) -> float:
        return {"c": self.g_c, "t": self.g_t, "s": self.g_s, "g": self.g_g}[FT.group_of(j)]


def _evidence(aggs: dict[str, Agg], feats_of: dict[str, list[str]], words_of: dict[str, int], now: float,
              cfg: V3Config, P: dict):
    """Per looked-at card: (features, fade, centered reward). Also returns rbar."""
    rows = []
    for cid, a in aggs.items():
        fs = feats_of.get(cid)
        if not fs or not a.viewed:
            continue
        r = card_reward(a, words_of.get(cid, 0), P)
        f = 0.5 ** (max(now - a.last_at, 0.0) / C.DAY / cfg.half_life_days)
        rows.append((fs, f, r))
    sw = sum(f for _, f, _ in rows)
    rbar = sum(f * r for _, f, r in rows) / (sw + cfg.k0) if rows else 0.0
    return [(fs, f, r - rbar) for fs, f, r in rows], rbar


def reader_weights(aggs: dict[str, Agg], feats_of: dict[str, list[str]], words_of: dict[str, int], now: float,
                   cfg: V3Config, P: Optional[dict] = None) -> tuple[dict[str, float], dict[str, float], float]:
    """(b_j, n_j, rbar) for one reader. b_j = 0 for features with no evidence."""
    P = P or v2_params()
    ev, rbar = _evidence(aggs, feats_of, words_of, now, cfg, P)
    n: dict[str, float] = {}
    s: dict[str, float] = {}
    for fs, f, d in ev:
        for j in fs:
            n[j] = n.get(j, 0.0) + f
            s[j] = s.get(j, 0.0) + f * d
    if cfg.solver == "diag" or not ev:
        return {j: s[j] / (cfg.lam + n[j]) for j in n}, n, rbar
    keys = sorted(n)
    ix = {j: i for i, j in enumerate(keys)}
    X = np.zeros((len(ev), len(keys)))
    w = np.zeros(len(ev)); y = np.zeros(len(ev))
    for i, (fs, f, d) in enumerate(ev):
        for j in fs:
            X[i, ix[j]] = 1.0
        w[i], y[i] = f, d
    A = X.T @ (X * w[:, None]) + cfg.lam * np.eye(len(keys))
    b = np.linalg.solve(A, X.T @ (w * y))
    return {j: float(b[ix[j]]) for j in keys}, n, rbar


def residual_hours(fs: list[str], b: dict[str, float], n: dict[str, float], cfg: V3Config,
                   uid: str = "", seed: int = 0) -> float:
    """The personal term in hours of one card."""
    raw = 0.0
    for j in fs:
        bj = b.get(j, 0.0)
        if cfg.explore > 0:
            bj += cfg.explore * cfg.tau / math.sqrt(cfg.lam + n.get(j, 0.0)) * normal_draw(uid, "v3" + j, seed)
        raw += cfg.group_weight(j) * bj
    h = cfg.hours_per_reward * raw
    if h < 0:
        h *= cfg.neg_mult
    return max(-cfg.cap_hours, min(cfg.cap_hours, h))


class _NoAffinity(CurrentServer):
    """The formula with the learned affinity, explore and topic hint removed (rank_score + follow + seen
    penalty + trend + card link), used when the residual replaces the formula's own learning."""

    def raw_scores(self, state, rows, now, crowd, aff=None):
        empty = {"c": {}, "t": {}, "s": {}, "k": {}}
        n_rows, state.n_rows = state.n_rows, 0           # explore needs >= 5 events: switch it off
        try:
            return super().raw_scores(state, rows, now, crowd, aff=empty)
        finally:
            state.n_rows = n_rows


class ResidualPolicy(Policy):
    """v3 for the simulator: the formula's own rank() with the residual hours passed as `extra`."""

    def __init__(self, cat, cfg: V3Config = V3Config(), name: str = "v3_residual"):
        self.cat, self.cfg, self.name = cat, cfg, name
        self.P = v2_params()
        self.inner = CurrentServer(cat) if cfg.base == "formula" else _NoAffinity(cat)
        self.feats = [FT.card_features(c.category, c.event_type or c.kind, c.source, c.headline) for c in cat.cards]
        self.feats_of = {c.id: self.feats[i] for i, c in enumerate(cat.cards)}
        self.words_of = {c.id: c.word_count for c in cat.cards}

    def aggs(self, state, now: float) -> dict[str, Agg]:
        win = self.cfg.window_days * C.DAY
        return {cid: Agg(liked=sg.liked, disliked=sg.disliked, detail=sg.detail, src=sg.srcopen, viewed=sg.viewed,
                         max_dwell=sg.max_dwell, last_at=sg.last_t)
                for cid, sg in state.sigs.items() if now - sg.last_t < win}

    def hours(self, state, rows: np.ndarray, now: float) -> np.ndarray:
        b, n, _ = reader_weights(self.aggs(state, now), self.feats_of, self.words_of, now, self.cfg, self.P)
        seed = int(round(now * 1000)) % 2147483647
        return np.array([residual_hours(self.feats[r], b, n, self.cfg, state.uid, seed) for r in rows])

    def rank(self, state, rows, now, crowd):
        if self.cfg.step_extra == 0:
            return self.inner.rank(state, rows, now, crowd, extra=lambda rr: self.hours(state, rr, now))
        old = C.SQL["category_step"]                     # same rank() with a bigger same-topic step
        C.SQL["category_step"] = old + self.cfg.step_extra
        try:
            return self.inner.rank(state, rows, now, crowd, extra=lambda rr: self.hours(state, rr, now))
        finally:
            C.SQL["category_step"] = old
