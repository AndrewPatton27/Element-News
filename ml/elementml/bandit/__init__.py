"""Ranking v2 for For you: Thompson sampling over card features with a weekly population prior.

    params.py    every setting, same keys as core.rank_params
    features.py  card features (topic, type, source, tags); TAG_RULES = the core.tag_rules seed
    policy.py    the scoring math, a mirror of core.v2_scores, and BanditPolicy for the simulator
    prior.py     weekly empirical-Bayes fit (mu0, lambda per group, tau, slot propensities)
    gate.py      go / no-go: synthetic criteria and the real-data replay
    supa.py      service-role REST client (export, publish); job.py the weekly steps
Nothing here imports the simulator.
"""
from .features import TAG_RULES, card_features
from .params import DEFAULTS, LEAN_TAGS, params
from .policy import BanditPolicy, Event, Model, RefCard, normal_draw, score_reference

__all__ = ["BanditPolicy", "DEFAULTS", "Event", "LEAN_TAGS", "Model", "RefCard", "TAG_RULES", "card_features",
           "normal_draw", "params", "score_reference"]
