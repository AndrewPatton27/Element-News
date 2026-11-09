"""Ranking v3 prototype: today's formula plus a bounded per-reader residual (see v3/policy.py)."""
from .policy import V3Config, ResidualPolicy, reader_weights, residual_hours

__all__ = ["V3Config", "ResidualPolicy", "reader_weights", "residual_hours"]
