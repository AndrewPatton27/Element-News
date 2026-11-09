"""Ranking components: stage 1 candidates, LightGBM heads, the utility formula, diversity and exploration,
and Python ports of today's live formulas (baselines). Assembled into one ranker in serving/.
Nothing here imports the simulator.

The stage-1 functions are reached through their module (`from elementml.ranking import candidates`, then
`candidates.eligible_rows(...)`), so the module name is not hidden by a function of the same name.
"""
from . import candidates, diversity
from .baselines import CurrentDevice, CurrentServer, Popularity, RecencyImportance, cap_topics, diversify_feed
from .heads import HEADS, LGB_ROBUST, MONOTONE, Heads, ece, platt_apply, platt_fit, train_heads
from .utility import Weights, utility

__all__ = ["candidates", "diversity", "CurrentDevice", "CurrentServer", "Popularity", "RecencyImportance",
           "cap_topics", "diversify_feed", "HEADS", "LGB_ROBUST", "MONOTONE", "Heads", "ece", "platt_apply",
           "platt_fit", "train_heads", "Weights", "utility"]
