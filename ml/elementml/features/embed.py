"""Item embeddings: TF-IDF(headline + body) + one-hot category / event_type / source -> SVD -> unit length.

Input: a list of Cards (fit once on a corpus, then `transform` any card). Output: an (n, 32) array of
unit vectors, plus one centroid per category (used for the follow prior of a new reader).
Why: a cheap, free, local text representation (scikit-learn) that puts similar stories close together.
"""
from __future__ import annotations

import pickle
from pathlib import Path

import numpy as np
from scipy import sparse
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import OneHotEncoder, normalize

from .. import config as C
from ..data.cards import Card

SVD_ITERATIONS = 7              # randomized-SVD power iterations


class Embedder:
    def __init__(self, dims: int = C.EMB_DIMS, onehot_weight: float = C.EMB_ONEHOT_WEIGHT, seed: int = 0):
        self.dims, self.onehot_weight, self.seed = dims, onehot_weight, seed
        self.tfidf = TfidfVectorizer(sublinear_tf=True, min_df=2, max_features=C.EMB_MAX_FEATURES,
                                     stop_words="english", dtype=np.float64)
        self.onehot = OneHotEncoder(handle_unknown="ignore")
        self.svd: TruncatedSVD | None = None
        self.centroids: dict[str, np.ndarray] = {}

    @staticmethod
    def _cats(cards: list[Card]):
        return [[c.category, c.event_type or "none", c.source or "none"] for c in cards]

    def _matrix(self, cards: list[Card], fit: bool):
        texts = [c.text for c in cards]
        t = self.tfidf.fit_transform(texts) if fit else self.tfidf.transform(texts)
        o = self.onehot.fit_transform(self._cats(cards)) if fit else self.onehot.transform(self._cats(cards))
        return sparse.hstack([t, o * self.onehot_weight]).tocsr()

    def fit(self, cards: list[Card]) -> "Embedder":
        """Fit TF-IDF, one-hot and SVD on `cards` and store one unit centroid per category."""
        x = self._matrix(cards, fit=True)
        k = max(2, min(self.dims, x.shape[1] - 1, len(cards) - 1))     # small corpora get fewer dimensions
        self.svd = TruncatedSVD(n_components=k, random_state=self.seed, algorithm="randomized", n_iter=SVD_ITERATIONS)
        z = normalize(self.svd.fit_transform(x))
        for cat in sorted({c.category for c in cards}):
            m = np.array([c.category == cat for c in cards])
            v = z[m].mean(axis=0)
            self.centroids[cat] = v / (np.linalg.norm(v) + 1e-12)
        return self

    def transform(self, cards: list[Card]) -> np.ndarray:
        """Unit item vectors for `cards` (fit first)."""
        assert self.svd is not None, "fit first"
        return normalize(self.svd.transform(self._matrix(cards, fit=False)))

    @property
    def k(self) -> int:
        """Number of dimensions actually used (32, or fewer for a tiny corpus)."""
        return self.svd.n_components

    def save(self, path: Path) -> None:
        Path(path).write_bytes(pickle.dumps(self))

    @staticmethod
    def load(path: Path) -> "Embedder":
        return pickle.loads(Path(path).read_bytes())


# Saved files (models/**/embedder.pkl) name this class "elementml.embed.Embedder", its path before the
# package was split into folders. Keeping that name lets old files load (elementml/embed.py re-exports it)
# and keeps newly saved files byte-identical to the old ones.
Embedder.__module__ = "elementml.embed"
