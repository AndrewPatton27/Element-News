"""Unit tests for the real-impression evaluation helpers (no data files needed)."""
import numpy as np

from elementml import config as C
from elementml.evaluation import real_eval as R
from elementml.ranking import heads as heads_mod


def test_ndcg_perfect_and_reversed():
    rel = np.array([2.0, 1.0, 0.0, 0.0])
    assert R.ndcg_at_k(rel, np.array([4, 3, 2, 1.0])) == 1.0
    assert R.ndcg_at_k(rel, np.array([1, 2, 3, 4.0])) < 1.0
    assert np.isnan(R.ndcg_at_k(np.zeros(4), np.arange(4.0)))     # no relevant card: undefined, skipped by page_ndcg


def test_auc_one_class_is_nan():
    assert np.isnan(R.auc(np.zeros(5), np.arange(5.0)))
    assert R.auc(np.array([0, 0, 1, 1.0]), np.array([0.1, 0.2, 0.8, 0.9])) == 1.0


def test_card_weights_cap_each_card():
    # 1000 rows: card "a" has 600 rows, the other 400 rows are 40 cards x 10; cap = 1% of rows = 10 rows
    cards = np.array(["a"] * 600 + [f"c{i}" for i in range(40) for _ in range(10)])
    M = {"card": cards}
    w = R.card_weights(M, np.arange(len(cards)))["like"]
    assert abs(w[:600].sum() - 10.0) < 1e-9               # card a carries at most the cap
    assert np.all(w[600:] == 1.0)                         # small cards are untouched


def test_regularisation_restores_globals():
    r0, p0 = dict(C.LGB_ROUNDS), dict(heads_mod.LGB_ROBUST)
    with R.regularisation(dict(rounds_scale=0.5, min_leaf=900, l2=100.0, ff=0.5, leaves=5)):
        assert C.LGB_ROUNDS["like"] == max(10, int(r0["like"] * 0.5))
        assert heads_mod.LGB_ROBUST["min_data_in_leaf"] == 900
    assert dict(C.LGB_ROUNDS) == r0 and dict(heads_mod.LGB_ROBUST) == p0


def test_features_have_no_card_identity_columns():
    from elementml import features as F
    banned = ("id", "hash", "key", "headline")
    assert not [n for n in F.NAMES if any(b == n or n.startswith(b + "_") for b in banned)]
