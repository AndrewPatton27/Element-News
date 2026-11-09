"""Stage 1: which cards may be shown, and a cheap shortlist of about 150 for the expensive stage 2.

Input: a reader state, the Catalog and candidate rows (usually the 72 h freshness window).
Output: `eligible_rows` drops cards the reader has seen or disliked and hidden topics / sources;
`candidates` keeps the cosine top K_COS to the reader vector plus the best K_BASE by the stored base
score (the importance backstop, so a major story always reaches stage 2). Order: cosine picks first.
"""
from __future__ import annotations

import numpy as np

from .. import config as C
from ..data.catalog import Catalog
from ..features.uservec import UserState


def eligible_rows(state: UserState, cat: Catalog, rows: np.ndarray) -> np.ndarray:
    """Rows the reader has not viewed or disliked and whose category and source are not hidden."""
    blocked = {i for i, s in state.sigs.items() if s.viewed or s.disliked}
    out = []
    for r in rows:
        c = cat.cards[r]
        if c.id in blocked or c.category in state.hidden_cats or (c.source and c.source in state.hidden_srcs):
            continue
        out.append(r)
    return np.array(out, dtype=int)


def candidates(state: UserState, cat: Catalog, elig: np.ndarray, k_cos: int = C.K_COS, k_base: int = C.K_BASE) -> np.ndarray:
    """Cosine top-k_cos (skipped while the reader vector is zero) plus base-score top-k_base, without repeats."""
    if len(elig) == 0:
        return elig
    v = state.vec
    nv = np.linalg.norm(v)
    cos = cat.emb[elig] @ (v / nv) if nv > 1e-9 else np.zeros(len(elig))
    by_cos = elig[np.argsort(-cos, kind="stable")[:k_cos]] if nv > 1e-9 else elig[:0]
    by_base = elig[np.argsort(-cat.base[elig], kind="stable")[:k_base]]
    seen, out = set(), []
    for r in list(by_cos) + list(by_base):
        if r not in seen:
            seen.add(r); out.append(r)
    return np.array(out, dtype=int)
