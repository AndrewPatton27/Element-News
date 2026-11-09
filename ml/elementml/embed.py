"""Compatibility name for saved models only: embedder.pkl files refer to `elementml.embed.Embedder`.

New code imports `elementml.features.embed`. Do not delete this file while old model folders exist.
"""
from .features.embed import Embedder

__all__ = ["Embedder"]
