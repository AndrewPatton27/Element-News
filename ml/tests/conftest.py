import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from elementml import features as F  # noqa: E402
from elementml.data import Catalog, generate_cards  # noqa: E402
from elementml.features import Embedder  # noqa: E402
from elementml.ranking.heads import train_heads  # noqa: E402
from elementml.simulator import World  # noqa: E402


@pytest.fixture(scope="session")
def env():
    cards, lat = generate_cards(7, days=8)
    emb = Embedder().fit(cards)
    cat = Catalog.build(cards, emb)
    world = World(cat, lat)
    return emb, cat, world


@pytest.fixture(scope="session")
def tiny_heads():
    """Heads trained on random data: enough to exercise the serving code, no claim about quality."""
    rng = np.random.default_rng(0)
    X = rng.normal(size=(600, len(F.NAMES)))
    X[:, F.NAMES.index("event_code")] = rng.integers(0, 9, 600)
    X[:, F.NAMES.index("cat_code")] = rng.integers(0, 12, 600)
    X[:, F.NAMES.index("src_code")] = rng.integers(0, 9, 600)
    y = {"like": (X[:, 0] > 0.5).astype(float), "dislike": (X[:, 0] < -1).astype(float),
         "detail": (X[:, 0] > 1).astype(float), "comp": rng.uniform(0, 1.5, 600), "comp_ok": np.ones(600, bool)}
    return train_heads(X, y, list(F.NAMES))
