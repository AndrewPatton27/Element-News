"""Catalog: a card list as numpy columns, with its embedding matrix.

Input: cards plus their item vectors (or an Embedder to compute them). Output: a Catalog whose rows
are sorted by (sort_at, id), with columns for time, importance, words, category / type / source codes
and the stored base score. Why: the rankers and the simulator work on row numbers and arrays, which is
much faster than walking Card objects. Ranker-visible fields only.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np

from .. import config as C
from .cards import Card

if TYPE_CHECKING:                                    # type only: avoids a data <-> features import cycle
    from ..features.embed import Embedder


class Catalog:
    def __init__(self, cards: list[Card], emb: np.ndarray):
        order = sorted(range(len(cards)), key=lambda i: (cards[i].sort_at, cards[i].id))
        self.cards = [cards[i] for i in order]
        self.emb = np.asarray(emb)[order]
        self.index = {c.id: i for i, c in enumerate(self.cards)}
        n = len(self.cards)
        self.sort_at = np.array([c.sort_at for c in self.cards])
        self.importance = np.array([max(c.importance, 1.0) for c in self.cards])
        self.words = np.array([c.word_count for c in self.cards], dtype=float)
        self.cat = np.array([C.CATEGORIES.index(c.category) if c.category in C.CATEGORIES else -1 for c in self.cards])
        self.typ = np.array([C.EVENT_TYPES.index(c.event_type or "none") if (c.event_type or "none") in C.EVENT_TYPES
                             else C.EVENT_TYPES.index("none") for c in self.cards])
        self.src = np.array([C.SOURCES.index(c.source or "none") for c in self.cards])
        self.is_data = np.array([c.kind == "data" for c in self.cards], dtype=float)
        self.base = self.sort_at + C.HALF_LIFE_H * np.log2(self.importance)       # stored rank_score
        self.n = n

    @staticmethod
    def build(cards: list[Card], embedder: "Embedder") -> "Catalog":
        """Embed the cards with `embedder` and build the catalog."""
        return Catalog(cards, embedder.transform(cards))

    def fresh_rows(self, now: float, window: float = C.WINDOW_H) -> np.ndarray:
        """Rows published in (now - window, now], oldest first."""
        lo = np.searchsorted(self.sort_at, now - window, side="right")
        hi = np.searchsorted(self.sort_at, now, side="right")
        return np.arange(lo, hi)

    def rows_of(self, ids) -> np.ndarray:
        """Row numbers of the given card ids."""
        return np.array([self.index[i] for i in ids], dtype=int)
