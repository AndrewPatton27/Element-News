"""The simulator: hidden-taste personas and the behaviour model that grades rankings.

SEPARATION RULE: this package may import data/, features/ and interfaces (to feed a ranker the events it
would really see) but nothing in data/, features/, ranking/ or serving/ imports it. A ranker only ever
receives ("view" | "like" | ..., dwell_ms) events, exactly like core.user_events. World.L (card topic
mixtures) and Persona.taste never leave this package except through the functions that grade a ranking.
"""
from .cohort import ndcg_at, run_cohort
from .personas import KINDS, Persona, make_persona
from .world import World, sigmoid

__all__ = ["KINDS", "Persona", "World", "make_persona", "ndcg_at", "run_cohort", "sigmoid"]
