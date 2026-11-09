"""Expected utility: the one number per card that the four head predictions are combined into.

    U = W_LIKE p_like + W_TIME min(completion, 1.2) / 1.2 + W_DETAIL p_detail - W_DISLIKE p_dislike
        + W_BASE clip(base_rel / 24 h, -1.5, 1)

Input: head predictions and each card's base score relative to now (hours). Output: U per card.
Why this shape: the time term is relative to the card's own length and capped, so long cards and
engagement bait are not rewarded (never optimise raw time on feed); the last term keeps importance and
freshness in play.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .. import config as C

BASE_TERM_RANGE = (-1.5, 1.0)   # the importance/freshness term, in days of base score, is clipped here


@dataclass
class Weights:
    like: float = C.W_LIKE
    time: float = C.W_TIME
    detail: float = C.W_DETAIL
    dislike: float = C.W_DISLIKE
    base: float = C.W_BASE


def utility(pred: dict[str, np.ndarray], base_rel: np.ndarray, w: Weights | None = None) -> np.ndarray:
    """Expected utility per card from the head predictions (see module docstring)."""
    w = w or Weights()
    comp = np.clip(pred["time"], 0, C.COMPLETION_CAP)
    base_term = np.clip(base_rel / C.DAY, *BASE_TERM_RANGE)
    return (w.like * pred["like"] + w.time * np.minimum(comp, C.TIME_CAP) / C.TIME_CAP
            + w.detail * pred["detail"] - w.dislike * pred["dislike"] + w.base * base_term)
