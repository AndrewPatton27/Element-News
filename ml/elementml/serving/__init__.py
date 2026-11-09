"""Serving: the assembled For you pipeline, `rank_for_you(user_state, candidate_cards, ranker, embedder)`.

On the website the model runs only offline, in shadow mode: an hourly job on the laptop replays the
pages readers were served through `rank_for_you` and writes the model's would-have-ranked scores back to
Postgres. That job is not in this folder yet; it will call this entry point. Nothing here imports the
simulator.
"""
from .for_you import Ranked, Ranker, Variant, evidence_gate, pct_rank, rank_for_you

__all__ = ["Ranked", "Ranker", "Variant", "evidence_gate", "pct_rank", "rank_for_you"]
