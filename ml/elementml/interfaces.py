"""The one interface shared by the simulator and every ranker.

It lives outside both sub-packages so a ranker can implement it without importing the simulator.
Input to `rank`: a reader state, candidate catalog rows, the time (hours) and the crowd tables (or None).
Output: catalog rows, best first.
"""
from __future__ import annotations

import numpy as np


class Policy:
    """A ranker as the simulator sees it: ordered catalog rows, best first, for one reader at one time."""
    name = "policy"

    def rank(self, state, rows: np.ndarray, now: float, crowd) -> np.ndarray:
        raise NotImplementedError
