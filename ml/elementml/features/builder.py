"""Stage-2 feature matrix for (reader, card) pairs. Ranker-visible data only.

Input: a UserState, the Catalog, candidate rows, the time, the crowd tables (or None) and the slot.
Output: an (n_rows, len(NAMES)) float64 matrix; column order is NAMES.
Why: the LightGBM heads and the "why" sentences read these columns, and training and serving must
build them the same way, so there is exactly one builder.

Groups (used for ablations): vec, aff, base, user, crowd, rls, srv, pos.
`position` is a training-only nuisance variable: logged with the real slot, held at 0 when serving.
"""
from __future__ import annotations

import numpy as np

from .. import config as C
from ..data.catalog import Catalog
from .crowd import CrowdTables
from .uservec import UserState

GROUPS = {
    "vec": ["cos_user", "max_cos_liked", "max_cos_disliked", "unc_card", "uvec_norm"],
    "aff": ["cat_aff", "type_aff", "src_aff", "followed", "cat_conf", "cat_exposure"],
    "base": ["age_h", "imp_log2", "base_rel", "words", "event_code", "cat_code", "src_code", "is_data"],
    "user": ["n_ev", "n_strong", "comp_ema", "like_ema", "skip_ema"],
    "crowd": ["c_boost", "c_quality", "c_users", "c_pos_rate", "c_link_x", "c_topic_prior"],
    "rls": ["rls_score", "rls_unc"],         # hardening: RLS reader model (every impression, full covariance)
    "srv": ["srv_score"],                    # hardening: today's server-formula score (hours, relative to now) as a feature
    "pos": ["position"],
}
NAMES = [n for g in GROUPS.values() for n in g]          # column order of the matrix
CATEGORICAL = ["event_code", "cat_code", "src_code"]     # LightGBM treats these as categories
NO_CROWD_POS_RATE = 0.15                                 # c_pos_rate when there are no crowd tables


def build(state: UserState, cat: Catalog, rows: np.ndarray, now: float, crowd: CrowdTables | None,
          aff: dict | None = None, position: float | np.ndarray = 0.0) -> np.ndarray:
    """Feature matrix for `rows` (see module docstring). `aff` may be passed to reuse state.affinity(now)."""
    m = len(rows)
    aff = aff if aff is not None else state.affinity(now)
    emb = cat.emb[rows]
    v = state.vec
    nv = float(np.linalg.norm(v))
    cos_user = emb @ (v / nv) if nv > 1e-9 else np.zeros(m)

    def maxcos(q):
        return (emb @ np.stack(list(q)).T).max(axis=1) if len(q) else np.zeros(m)
    unc = np.sqrt((emb * emb) @ state.uncertainty())
    ci = cat.cat[rows]
    catA = np.array([aff["c"].get(k, 0.0) for k in C.CATEGORIES] + [0.0])     # last entry: unknown category (-1)
    catK = np.array([aff["k"].get(k, 0.0) for k in C.CATEGORIES] + [0.0])
    typA = np.array([aff["t"].get(k, 0.0) for k in C.EVENT_TYPES])
    srcA = np.array([aff["s"].get(k, 0.0) for k in C.SOURCES])
    ti = cat.typ[rows]
    none_t = ti == C.EVENT_TYPES.index("none")
    # cards without an event type are keyed by kind ("data" / "summary"), as in core.user_affinity_dims
    type_aff = np.where(none_t, np.where(cat.is_data[rows] > 0, aff["t"].get("data", 0.0), aff["t"].get("summary", 0.0)), typA[ti])
    fol = np.array([C.CATEGORIES.index(f) for f in state.follows if f in C.CATEGORIES], dtype=int)
    exp_counts = np.zeros(len(C.CATEGORIES) + 1)
    for c in state.recent_cats:
        if c in C.CATEGORIES:
            exp_counts[C.CATEGORIES.index(c)] += 1
    expo = exp_counts / max(len(state.recent_cats), 1)
    age = np.maximum(now - cat.sort_at[rows], 0.0)
    if crowd is not None and crowd.n == cat.n:
        link = crowd.link_x(state, cat, now)[rows]
        tp = crowd.topic_prior(state, aff)
        topic_prior = tp[np.clip(ci, 0, None)]
        cb, cq, cu, cpr = crowd.boost[rows], crowd.quality[rows], crowd.users[rows], crowd.pos_rate[rows]
    else:
        link = topic_prior = cb = cq = cu = np.zeros(m)
        cpr = np.full(m, NO_CROWD_POS_RATE)
    cols = [cos_user, maxcos(state.liked_embs), maxcos(state.disliked_embs), unc, np.full(m, nv),
            catA[ci], type_aff, srcA[cat.src[rows]], np.isin(ci, fol).astype(float), catK[ci], expo[np.clip(ci, 0, None)],
            age, np.log2(cat.importance[rows]), cat.base[rows] - now, cat.words[rows], ti.astype(float),
            ci.astype(float), cat.src[rows].astype(float), cat.is_data[rows],
            np.full(m, state.n_ev), np.full(m, float(state.n_strong)), np.full(m, state.comp_ema),
            np.full(m, state.like_ema), np.full(m, state.skip_ema),
            cb, cq, cu, cpr, link, topic_prior, *state.rls_scores(emb), _server_scores(state, cat, rows, now, crowd, aff),
            np.broadcast_to(np.asarray(position, dtype=float), (m,))]
    return np.column_stack(cols).astype(np.float64)


_SERVERS: dict[int, object] = {}       # one server-formula port per catalog (it caches nothing else)


def _server_scores(state: UserState, cat: Catalog, rows: np.ndarray, now: float, crowd, aff) -> np.ndarray:
    """api.feed_for_you's score before its same-topic step (see ranking.baselines.CurrentServer.raw_scores)."""
    from ..ranking.baselines import CurrentServer          # imported here: ranking imports this module
    srv = _SERVERS.get(id(cat))
    if srv is None or srv.cat is not cat:
        srv = _SERVERS[id(cat)] = CurrentServer(cat)
    have = crowd is not None and crowd.n == cat.n
    return srv.raw_scores(state, rows, now, crowd if have else None, aff)


def columns(names_keep: list[str]) -> list[int]:
    """Column indices of the given feature names."""
    return [NAMES.index(n) for n in names_keep]


def names_without(*groups: str) -> list[str]:
    """Every feature name except those in the given groups (for ablations)."""
    drop = {n for g in groups for n in GROUPS[g]}
    return [n for n in NAMES if n not in drop]
