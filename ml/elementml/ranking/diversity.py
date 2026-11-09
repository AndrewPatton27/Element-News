"""Page shaping after scoring: MMR diversity and optional exploration slots.

Input: candidate indices sorted by utility, their utilities, item vectors (MMR) or uncertainties (UCB).
Output: a new order of the same indices (and, for exploration, which ones were inserted).
Why: utility alone puts near-duplicates side by side; MMR trades a little utility for variety.
Exploration slots try the good-enough card the reader vector is least sure about (off in the hardened
pipeline: they cost a little and showed no learning benefit within two simulated weeks).
"""
from __future__ import annotations

import numpy as np

from .. import config as C

EXPLORE_POOL = 60               # exploration picks only from the best 60 by the current order


def _norm(x: np.ndarray) -> np.ndarray:
    lo, hi = float(np.min(x)), float(np.max(x))
    return (x - lo) / (hi - lo) if hi - lo > 1e-12 else np.zeros_like(x)


def mmr(order: np.ndarray, util: np.ndarray, emb: np.ndarray, pool: int = C.MMR_POOL, lam: float = C.MMR_LAMBDA) -> np.ndarray:
    """order: candidate indices (into util/emb) sorted by utility desc. Greedy MMR over the first `pool`."""
    head, tail = list(order[:pool]), list(order[pool:])
    u = _norm(util[head])
    chosen, left = [], list(range(len(head)))
    maxsim = np.zeros(len(head))
    E = emb[head]
    while left:
        sc = [lam * u[i] - (1 - lam) * maxsim[i] for i in left]
        j = left[int(np.argmax(sc))]
        chosen.append(j); left.remove(j)
        maxsim = np.maximum(maxsim, E @ E[j])
    return np.array([head[j] for j in chosen] + tail, dtype=int)


def explore_slots(order: np.ndarray, util: np.ndarray, unc: np.ndarray, slots=C.EXPLORE_SLOTS, beta: float = C.EXPLORE_BETA,
                  pool: int = EXPLORE_POOL) -> tuple[np.ndarray, set]:
    """Put into each reserved slot the good-enough card with the most uncertain user-vector direction (UCB).
    Good enough = utility at or above the pool median. Returns (new order, indices that were moved in)."""
    order = list(order)
    flagged: set = set()
    top = order[:pool]
    if len(top) <= max(slots):
        return np.array(order, dtype=int), flagged
    med = float(np.median(util[top]))
    for s in slots:
        pick, best = None, -1e9
        un = _norm(unc[top]); un_of = dict(zip(top, un))
        un_ = _norm(util[top]); u_of = dict(zip(top, un_))
        for c in top:
            if c in flagged or c in order[:s] or util[c] < med:
                continue
            v = u_of[c] + beta * un_of[c]
            if v > best:
                best, pick = v, c
        if pick is None:
            continue
        order.remove(pick)
        order.insert(s, pick)
        flagged.add(pick)
    return np.array(order, dtype=int), flagged
