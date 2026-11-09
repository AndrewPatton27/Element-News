"""Ranking v2 scoring: Thompson sampling over card features, and a line-by-line mirror of the SQL feed.

Input: one reader's events (or, in the simulator, the per-card signal ledger), their follows and hides,
the trained model (population prior mu0 per feature, prior strength lambda per group, reward noise tau,
slot propensities), the settings, the frozen "as of" time and the scroll's seed.
Output: per candidate card the personal term in hours and the page key `ps` that core.v2_scores returns,
and (BanditPolicy) a full feed order for the simulator.

The formula, in plain words: every feature j of a card (topic, story type, source, tags) has a belief per
reader: an average reward mu_j and an uncertainty sigma_j. The belief starts at the population average
mu0_j (plus a small lean for rates / inflation / jobs / growth / markets tags) and moves toward the
reader's own rewards as evidence n_j grows:
    n_j     = sum over the reader's cards with j of  w * x^2
    mu_j    = (lambda_g * mu0_j + sum w * x * r) / (lambda_g + n_j)
    sigma_j = tau / sqrt(lambda_g + n_j)
    theta_j = mu_j + v2_explore * sigma_j * z_j          (z_j: a normal draw fixed by user, j and seed)
    hours   = clamp(v2_hours_per_reward * sum_j x * theta_j, -v2_cap_hours, +v2_cap_hours)
    s0      = rank_score + hours - seen penalty
    ps      = s0 - step * (number of better cards of the same topic)      (step = topic step + cold step)
with x = 1/sqrt(active features), r = the card's reward (like +1, detail +0.5, source +0.5, long look
+0.25, quick skip -0.15, dislike -1, clipped to -1..1.5) and w = 14-day fade x min(1/propensity(slot), 3).
A follow adds v2_follow_pseudo observations of reward v2_follow_reward to its topic.

The draw z uses md5 (available in Postgres and in Python) so the SQL and Python draws are identical.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Iterable, Optional

import numpy as np

from ..interfaces import Policy
from . import features as FT
from .params import LEAN_TAGS, SLOT_BUCKETS

HOUR_PER_DAY = 24.0


@lru_cache(maxsize=200000)
def _features_cached(category, typ, skey, headline, series) -> list[str]:
    return FT.card_features(category, typ, skey, headline, series)


# ---- data records ----------------------------------------------------------------------
@dataclass(frozen=True)
class Event:
    """One core.user_events row: card id, kind, dwell ms, time in hours, displayed slot (views only)."""
    card: str
    kind: str
    ms: Optional[float]
    t: float
    slot: Optional[int] = None


@dataclass(frozen=True)
class RefCard:
    """What the feed knows about a card (core.blurbs + its source key)."""
    id: str
    category: str
    typ: Optional[str]             # coalesce(event_type, kind)
    skey: Optional[str]            # source key ('fred' for data cards)
    headline: str
    series: tuple = ()             # FRED series ids in macro
    rank_score: float = 0.0        # hours
    sort_at: float = 0.0           # hours
    published_at: float = 0.0      # hours
    words: int = 0
    status: str = "published"
    tags: Optional[tuple] = None   # features as the database worked them out (export); None = compute here

    @property
    def features(self) -> list[str]:
        if self.tags is not None:
            return sorted(self.tags)
        return _features_cached(self.category, self.typ, self.skey, self.headline, tuple(self.series))


@dataclass
class Agg:
    """What one reader did with one card in the window (the `ev` CTE of core.v2_scores)."""
    liked: bool = False
    disliked: bool = False
    detail: bool = False
    src: bool = False
    viewed: bool = False
    max_dwell: Optional[float] = None      # longest dwell at or under the walk-away cut
    last_at: float = -math.inf
    slot: Optional[int] = None             # smallest displayed slot of a view (None = unknown)


@dataclass
class Model:
    """A trained ranking v2 model (core.ml_weights rows of one core.ml_models row)."""
    mu0: dict[str, float] = field(default_factory=dict)          # feature -> population mean reward
    n_readers: dict[str, int] = field(default_factory=dict)      # feature -> readers behind mu0
    lam: dict[str, float] = field(default_factory=dict)          # group (c/t/s/g) -> prior strength
    tau: Optional[float] = None                                  # reward noise sd
    prop: dict[int, float] = field(default_factory=dict)         # slot bucket -> propensity (0..1]
    version: str = "hand-prior"

    def rows(self) -> list[dict]:
        """As core.ml_weights rows: {kind, key, value, n_readers}."""
        out = [{"kind": "feature", "key": k, "value": round(float(v), 6), "n_readers": int(self.n_readers.get(k, 0))}
               for k, v in sorted(self.mu0.items())]
        out += [{"kind": "group", "key": g, "value": round(float(v), 6), "n_readers": 0} for g, v in sorted(self.lam.items())]
        if self.tau is not None:
            out.append({"kind": "global", "key": "tau", "value": round(float(self.tau), 6), "n_readers": 0})
        out += [{"kind": "slot", "key": str(s), "value": round(float(v), 6), "n_readers": 0} for s, v in sorted(self.prop.items())]
        return out

    @staticmethod
    def from_rows(rows: Iterable[dict], version: str = "db") -> "Model":
        m = Model(version=version)
        for r in rows:
            k, v = r["key"], float(r["value"])
            if r["kind"] == "feature":
                m.mu0[k] = v; m.n_readers[k] = int(r.get("n_readers") or 0)
            elif r["kind"] == "group":
                m.lam[k] = v
            elif r["kind"] == "global" and k == "tau":
                m.tau = v
            elif r["kind"] == "slot":
                m.prop[int(k)] = v
        return m


# ---- small pieces (each one SQL expression) ----------------------------------------------
def long_look_ms(words: Optional[int], P: dict) -> float:
    """core.long_look_ms: words x 150 ms, between 6 and 8 s."""
    return min(P["dwell_long_ms"], max(P["dwell_long_min_ms"], (words or 0) * P["dwell_ms_per_word"]))


def aggregate(events: Iterable[Event], asof: float, P: dict, window_days: Optional[float]) -> dict[str, Agg]:
    """Per card: what the reader did before `asof` (and after asof - window_days, if given)."""
    out: dict[str, Agg] = {}
    lo = -math.inf if window_days is None else asof - window_days * HOUR_PER_DAY
    for e in events:
        if not (lo < e.t < asof):
            continue
        a = out.get(e.card)
        if a is None:
            a = out[e.card] = Agg()
        a.last_at = max(a.last_at, e.t)
        if e.kind == "like": a.liked = True
        elif e.kind == "dislike": a.disliked = True
        elif e.kind == "open_detail": a.detail = True
        elif e.kind == "open_source": a.src = True
        elif e.kind == "view":
            a.viewed = True
            if e.slot is not None:
                a.slot = e.slot if a.slot is None else min(a.slot, e.slot)
        if e.ms is not None and e.ms <= P["dwell_walkaway_ms"]:
            a.max_dwell = e.ms if a.max_dwell is None else max(a.max_dwell, e.ms)
    return out


def card_reward(a: Agg, words: Optional[int], P: dict) -> float:
    """The card's reward (same weights and caps as core.user_affinity_dims)."""
    s = (P["w_like"] * a.liked + P["w_dislike"] * a.disliked + P["w_open_detail"] * a.detail
         + P["w_open_source"] * a.src + P["w_view"] * a.viewed)
    if a.max_dwell is not None and a.max_dwell >= long_look_ms(words, P):
        s += P["w_dwell_long"]
    if a.max_dwell is not None and a.max_dwell <= P["dwell_skip_ms"] and not (a.liked or a.detail or a.src):
        s += P["w_dwell_skip"]
    return max(min(s, P["card_cap_pos_hours"]), P["card_cap_neg_hours"])


def slot_bucket(slot: Optional[int]) -> Optional[int]:
    return None if slot is None else min(int(slot), SLOT_BUCKETS)


def propensity_weight(slot: Optional[int], model: Model, P: dict) -> float:
    """min(1 / propensity(slot), cap); 1 when the slot or its propensity is unknown."""
    b = slot_bucket(slot)
    p = model.prop.get(b, 1.0) if b is not None else 1.0
    return min(1.0 / max(p, 1e-9), P["v2_propensity_cap"])


def fade(age_hours: float, P: dict) -> float:
    return 0.5 ** ((age_hours / HOUR_PER_DAY) / max(P["signal_half_life_days"], 0.01))


def md5_uniforms(text: str) -> tuple[float, float]:
    """Two uniforms in (0, 1) from md5(text): hex digits 1-8 and 9-16 (same as core.v2_normal)."""
    h = hashlib.md5(text.encode("utf-8")).hexdigest()
    return (int(h[0:8], 16) + 0.5) / 4294967296.0, (int(h[8:16], 16) + 0.5) / 4294967296.0


def normal_draw(user_id: str, feature: str, seed: int) -> float:
    """Box-Muller normal fixed by (user, feature, seed): the same in Python and Postgres."""
    u1, u2 = md5_uniforms(f"{user_id}|{feature}|{seed}")
    return math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)


def holdout_u(user_id: str) -> float:
    """The reader's holdout number in (0, 1): holdout when 100 x u < v2_holdout_pct (core.v2_holdout)."""
    return md5_uniforms(f"{user_id}|v2holdout")[0]


def lean_tags_from(P: dict) -> set[str]:
    """Tags with a lean: rank_params rows v2_lean_tag_<tag> <> 0 if given, else LEAN_TAGS."""
    keys = {k[len("v2_lean_tag_"):]: v for k, v in P.items() if k.startswith("v2_lean_tag_")}
    if keys:
        return {t for t, v in keys.items() if v != 0}
    return set(LEAN_TAGS)


# ---- the belief per feature -----------------------------------------------------------------
def feature_stats(aggs: dict[str, Agg], feats_of: dict[str, list[str]], words_of: dict[str, int],
                  follows: Iterable[str], model: Model, asof: float, P: dict) -> dict[str, list[float]]:
    """feature -> [n, sum w x r]: the reader's weighted evidence (cards they acted on, plus follows)."""
    st: dict[str, list[float]] = {}
    for cid, a in aggs.items():
        fs = feats_of.get(cid)
        if not fs:
            continue
        r = card_reward(a, words_of.get(cid, 0), P)
        w = fade(asof - a.last_at, P) * propensity_weight(a.slot, model, P)
        x = FT.x_of(fs)
        for j in fs:
            s = st.setdefault(j, [0.0, 0.0])
            s[0] += w * x * x
            s[1] += w * x * r
    for c in set(follows):
        s = st.setdefault("c:" + c, [0.0, 0.0])
        s[0] += P["v2_follow_pseudo"]
        s[1] += P["v2_follow_pseudo"] * P["v2_follow_reward"]
    return st


def prior_of(j: str, model: Model, P: dict, lean: set[str]) -> tuple[float, float]:
    """(mu0, lambda) of feature j: the trained mean if present (else 0) plus the lean; the group's lambda."""
    g = FT.group_of(j)
    lam = model.lam.get(g, P["v2_lambda_default"])
    mu0 = model.mu0.get(j, 0.0)
    if g == "g" and j[2:] in lean:
        mu0 += P["v2_prior_lean"]
    return mu0, lam


def posterior(j: str, stats: dict[str, list[float]], model: Model, P: dict, lean: set[str]) -> tuple[float, float]:
    """(mu_j, sigma_j) for one feature."""
    mu0, lam = prior_of(j, model, P, lean)
    n, sxr = stats.get(j, (0.0, 0.0))
    tau = model.tau if model.tau is not None else P["v2_tau_default"]
    return (lam * mu0 + sxr) / (lam + n), tau / math.sqrt(lam + n)


def bandit_hours(fs: list[str], user_id: str, seed: int, stats, model: Model, P: dict, lean: set[str],
                 cache: Optional[dict] = None) -> float:
    """The personal term in hours of one card (one Thompson draw per feature, shared by every card)."""
    if not fs:
        return 0.0
    x = FT.x_of(fs)
    tot = 0.0
    for j in fs:
        th = cache.get(j) if cache is not None else None
        if th is None:
            mu, sg = posterior(j, stats, model, P, lean)
            th = mu + P["v2_explore"] * sg * normal_draw(user_id, j, seed)
            if cache is not None:
                cache[j] = th
        tot += x * th
    h = P["v2_hours_per_reward"] * tot
    return max(-P["v2_cap_hours"], min(P["v2_cap_hours"], h))


def card_prior(fs: list[str], model: Model, P: dict, lean: set[str]) -> float:
    """sum_j x (mu0_j + lean): a card's expected reward for a reader nobody knows (core.v2_card_prior)."""
    x = FT.x_of(fs)
    return sum(x * prior_of(j, model, P, lean)[0] for j in fs)


def trend_points_v2(pts: float, n_readers: int, prior: float, P: dict) -> float:
    """Trending v2 buzz points: n x (pts + m x p0) / (n + m), p0 = points per reward x prior (section H)."""
    m = P["v2_trend_prior_n"]
    return n_readers * (pts + m * P["v2_trend_points_per_reward"] * prior) / (n_readers + m)


def trend_boost_hours(pts: float, P: dict) -> float:
    """The buzz curve of core.refresh_trending (without the quality term)."""
    if pts > 0:
        return P["trend_max_hours"] * pts / (pts + P["trend_half_points"])
    return -P["trend_max_neg_hours"] * (-pts) / (-pts + P["trend_half_points"])


# ---- the SQL mirror (core.v2_scores) --------------------------------------------------------------
@dataclass(frozen=True)
class Scored:
    id: str
    category: str
    s0: float
    bandit: float
    ps: float


def score_reference(user_id: str, cards: list[RefCard], events: list[Event], follows: list[str],
                    hidden_cats: Iterable[str], hidden_srcs: Iterable[str], model: Model, P: dict,
                    asof: float, seed: int, evidence_cards: Iterable[RefCard] = ()) -> list[Scored]:
    """Mirror of core.v2_scores(user, as_of, model, seed): every candidate, best first (ps desc, id desc).
    evidence_cards: more cards the reader has events on (any status, any age), used only as evidence, as the
    SQL `allc` CTE does; candidates come from `cards` only."""
    hidden_cats, hidden_srcs = set(hidden_cats), set(hidden_srcs)
    lean = lean_tags_from(P)
    by_id = {c.id: c for c in evidence_cards}
    by_id.update({c.id: c for c in cards})
    feats_of = {k: c.features for k, c in by_id.items()}
    words_of = {k: c.words for k, c in by_id.items()}
    win = P["affinity_days"]
    aggs = aggregate(events, asof, P, win)
    stats = feature_stats(aggs, feats_of, words_of, follows, model, asof, P)
    nev = sum(1 for e in events if asof - win * HOUR_PER_DAY < e.t < asof)
    step = P["foryou_category_step_hours"]
    if not follows:
        step += max(P["foryou_cold_step_hours"], 0) * max(1 - nev / max(P["foryou_cold_events"], 1), 0)
    disliked = {e.card for e in events if e.kind == "dislike"}
    shown: dict[str, bool] = {}
    for e in events:                                           # seen penalty: all time before as of
        if e.t < asof and e.kind in ("view", "dwell", "open_detail", "open_source"):
            c = by_id.get(e.card)
            read = e.kind == "open_detail" or (e.kind == "dwell" and e.ms is not None
                                               and e.ms >= long_look_ms(c.words if c else 0, P))
            shown[e.card] = shown.get(e.card, False) or read
    cache: dict[str, float] = {}
    base = []
    for c in cards:
        if (c.status != "published" or c.published_at > asof
                or c.sort_at <= asof - P["for_you_window_days"] * HOUR_PER_DAY
                or c.category in hidden_cats or c.id in disliked
                or (hidden_srcs and (c.skey is None or c.skey in hidden_srcs))):   # as SQL: null key is dropped too
            continue
        b = round(bandit_hours(feats_of[c.id], user_id, seed, stats, model, P, lean, cache), 6)
        pen = 0.0
        if c.id in shown:
            pen = P["seen_penalty_hours"] if shown[c.id] else P["seen_view_penalty_hours"]
        base.append((c, c.rank_score + b - pen, b))
    depth: dict[str, int] = {}
    out = []
    for c, s0, b in sorted(base, key=lambda t: (t[1], t[0].id), reverse=True):
        d = depth.get(c.category, 0)
        depth[c.category] = d + 1
        out.append(Scored(c.id, c.category, s0, b, round(s0 - step * d, 6)))
    out.sort(key=lambda s: (s.ps, s.id), reverse=True)
    return out


def keyset_page(scored: list[Scored], key: float, key_id: str, n: int) -> list[Scored]:
    """The next n cards strictly after (key, key_id) in (ps desc, id desc) order, as the SQL `page` CTE."""
    return [s for s in scored if (s.ps, s.id) < (key, key_id)][:n]


# ---- the simulator adapter -----------------------------------------------------------------
class BanditPolicy(Policy):
    """ts_v2 on catalog rows, for the simulator. Same math as score_reference; the reader's evidence comes
    from the UserState signal ledger (one row per card), and the seed is fixed per session (`now`).
    The order after the topic step is spread over topics with the same diversify port as the formula."""
    name = "ts_v2"

    def __init__(self, cat, model: Model, P: dict, tags_rows: Optional[list[list[str]]] = None):
        self.cat, self.model, self.P = cat, model, P
        self.lean = lean_tags_from(P)
        self.feats = tags_rows if tags_rows is not None else [
            FT.card_features(c.category, c.event_type or c.kind, c.source, c.headline) for c in cat.cards]
        self.feats_of = {c.id: self.feats[i] for i, c in enumerate(cat.cards)}
        self.words_of = {c.id: c.word_count for c in cat.cards}

    @staticmethod
    def session_seed(now: float) -> int:
        return int(round(now * 1000)) % 2147483647

    def aggs_from_state(self, state, now: float) -> dict[str, Agg]:
        win = self.P["affinity_days"] * HOUR_PER_DAY
        out = {}
        for cid, sg in state.sigs.items():
            if now - sg.last_t >= win:
                continue
            out[cid] = Agg(liked=sg.liked, disliked=sg.disliked, detail=sg.detail, src=sg.srcopen, viewed=sg.viewed,
                           max_dwell=sg.max_dwell, last_at=sg.last_t, slot=getattr(sg, "slot", None))
        return out

    def scores(self, state, rows: np.ndarray, now: float, seed: Optional[int] = None) -> np.ndarray:
        """s0 (relative to now) for each row: rank_score + personal hours - seen penalty."""
        P, cat = self.P, self.cat
        seed = self.session_seed(now) if seed is None else seed
        aggs = self.aggs_from_state(state, now)
        stats = feature_stats(aggs, self.feats_of, self.words_of, state.follows, self.model, now, P)
        cache: dict[str, float] = {}
        s0 = np.zeros(len(rows))
        for i, r in enumerate(rows):
            c = cat.cards[r]
            b = bandit_hours(self.feats[r], state.uid, seed, stats, self.model, P, self.lean, cache)
            sg = state.sigs.get(c.id)
            pen = 0.0
            if sg is not None and sg.viewed:
                read = sg.detail or (sg.max_dwell is not None and sg.max_dwell >= long_look_ms(sg.words, P))
                pen = P["seen_penalty_hours"] if read else P["seen_view_penalty_hours"]
            s0[i] = cat.base[r] - now + b - pen
        return s0

    def rank(self, state, rows, now, crowd):
        from ..ranking.baselines import DIVERSIFY_HEAD, _unseen_filter, diversify_feed
        cat, P = self.cat, self.P
        rows = _unseen_filter(state, cat, rows, False)
        if len(rows) == 0:
            return rows
        step = P["foryou_category_step_hours"]
        if not state.follows:
            step += P["foryou_cold_step_hours"] * max(1 - state.n_rows / max(P["foryou_cold_events"], 1), 0)
        s0 = self.scores(state, rows, now)
        order = np.argsort(-s0, kind="stable")
        rows, s0 = rows[order], s0[order]
        depth: dict[int, int] = {}
        ps = np.zeros(len(rows))
        for i, r in enumerate(rows):
            d = depth.get(int(cat.cat[r]), 0)
            depth[int(cat.cat[r])] = d + 1
            ps[i] = s0[i] - step * d
        rows = rows[np.argsort(-ps, kind="stable")]
        head = rows[:DIVERSIFY_HEAD]
        idx = diversify_feed([int(cat.cat[r]) for r in head])
        return np.concatenate([head[idx], rows[DIVERSIFY_HEAD:]]).astype(int)
