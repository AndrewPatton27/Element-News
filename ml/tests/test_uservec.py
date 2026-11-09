import numpy as np

from elementml import config as C
from elementml.features import UserState, make_prior


def unit(rng, d=32):
    v = rng.normal(size=d)
    return v / np.linalg.norm(v)


def card(env, i=0):
    return env[1].cards[i]


def test_like_moves_toward_card_and_dislike_away(env):
    emb, cat, _ = env
    rng = np.random.default_rng(1)
    x = unit(rng, emb.k)
    s = UserState("u", emb.k)
    s.vec = unit(rng, emb.k) * 0.3
    before = float(s.vec @ x)
    s.observe(cat.cards[0], x, [("view", None), ("like", None)], 10.0)
    assert float(s.vec @ x) > before
    after_like = float(s.vec @ x)
    s.observe(cat.cards[1], x, [("view", None), ("dislike", None)], 10.0)
    assert float(s.vec @ x) < after_like


def test_step_shrinks_with_evidence(env):
    emb, cat, _ = env
    rng = np.random.default_rng(2)
    s = UserState("u", emb.k)
    moves = []
    for i in range(12):
        x = unit(rng, emb.k)
        v0 = s.vec.copy()
        s.observe(cat.cards[i], x, [("view", None), ("like", None)], 10.0)
        moves.append(np.linalg.norm(s.vec - v0) / (np.linalg.norm(x - v0) + 1e-9))   # fraction of the way to x
    assert moves[0] > 0.4 and moves[-1] < moves[0] * 0.55


def test_signal_weights_start_from_live_weights():
    assert C.SIGNAL["like"] == 1.0 and C.SIGNAL["dislike"] == -1.0 and C.SIGNAL["open_detail"] == 0.5
    assert C.SIGNAL["open_source"] == 0.5 and C.SIGNAL["long_look"] == 0.25 and C.SIGNAL["quick_skip"] == -0.15


def test_quick_skip_negative_and_walkaway_ignored(env):
    emb, cat, _ = env
    x = unit(np.random.default_rng(3), emb.k)
    s = UserState("u", emb.k, now=5.0)
    s.vec = x * 0.5
    c = cat.cards[2]
    s.observe(c, x, [("view", None), ("dwell", 600.0)], 5.0)
    assert float(s.vec @ x) < 0.5                       # quick skip pushed away a little
    assert float(s.vec @ x) > 0.4                       # ... but only a little (-0.15)
    s2 = UserState("u2", emb.k, now=5.0)
    s2.vec = x * 0.5
    s2.observe(c, x, [("view", None), ("dwell", 130000.0)], 5.0)
    assert np.allclose(s2.vec, x * 0.5) and s2.n_ev == 0   # walked away: no look, no signal


def test_long_look_is_positive(env):
    emb, cat, _ = env
    x = unit(np.random.default_rng(4), emb.k)
    s = UserState("u", emb.k)
    s.observe(cat.cards[3], x, [("view", None), ("dwell", 20000.0)], 5.0)
    assert float(s.vec @ x) > 0


def test_decay_toward_prior_and_cold_start_prior(env):
    emb, cat, _ = env
    prior = make_prior(emb, ["tech"])
    assert abs(np.linalg.norm(prior) - C.UV_PRIOR_NORM) < 1e-9
    cos = float(prior @ emb.centroids["tech"]) / np.linalg.norm(prior)
    assert cos > 0.99
    s = UserState("u", emb.k, follows=["tech"], prior=prior, now=0.0)
    x = unit(np.random.default_rng(5), emb.k)
    s.observe(cat.cards[0], x, [("view", None), ("like", None)], 0.0)
    far = s.vec.copy()
    s.advance(24.0 * 140)                               # ten half-lives
    assert np.linalg.norm(s.vec - prior) < 0.01 * np.linalg.norm(far - prior) + 1e-3


def test_uncertainty_falls_on_touched_directions(env):
    emb, cat, _ = env
    x = unit(np.random.default_rng(6), emb.k)
    s = UserState("u", emb.k)
    u0 = s.uncertainty().copy()
    s.observe(cat.cards[0], x, [("view", None), ("like", None)], 0.0)
    u1 = s.uncertainty()
    assert (u1 <= u0).all() and u1.sum() < u0.sum()
    big = np.argmax(np.abs(x))
    assert u1[big] < u1[np.argmin(np.abs(x))]


def test_affinity_matches_live_rules(env):
    emb, cat, _ = env
    c = cat.cards[0]
    x = unit(np.random.default_rng(8), emb.k)
    s = UserState("u", emb.k)
    s.observe(c, x, [("view", None), ("like", None), ("dwell", 9000.0)], 10.0)
    a = s.affinity(10.0)
    # one like (+1) and a long look (+0.25) = 1.25, confidence 1/(1+0.25) = 0.8 -> 1.0 hour
    assert abs(a["c"][c.category] - 0.8 * 1.25) < 1e-6
    s.observe(cat.cards[1], x, [("view", None), ("dislike", None), ("dwell", 500.0)], 10.0)
    d = s.affinity(10.0)
    c1 = cat.cards[1].category
    if c1 != c.category:
        assert d["c"][c1] < 0
