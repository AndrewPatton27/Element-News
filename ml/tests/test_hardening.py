"""Tests for the hardening pieces: Kalman/Huber user-vector update, evidence gate, calibration,
monotone heads, domain randomisation, propensity curve and the third test world's knobs."""
import numpy as np

from elementml import features as F
from elementml.features import UserState, VecCfg
from elementml.ranking.baselines import CurrentServer
from elementml.ranking.heads import ece, platt_apply, platt_fit, train_heads
from elementml.serving import Ranker, Variant, evidence_gate, pct_rank
from elementml.simulator import World, make_persona
from elementml.training.train import propensity, world_params

K = VecCfg(update="kalman", p0=1.0, r=3.0, q_per_day=0.25)


def unit(rng, d=32):
    x = rng.normal(size=d)
    return x / np.linalg.norm(x)


def card(env, i=0):
    emb, cat, world = env
    return cat.cards[i], cat.emb[i]


def test_kalman_first_step_is_p0_over_p0_plus_r_and_shrinks(env):
    c, x = card(env)
    s = UserState("u", 32, vcfg=K)
    s.observe(c, x, [("view", None), ("like", None)], 1.0)
    assert np.allclose(s.vec, (1.0 / 4.0) * x)                    # k = 1 / (1 + 3)
    k1 = s.gain(1.0)
    c2, x2 = card(env, 1)
    s.observe(c2, x2, [("view", None), ("like", None)], 1.0)
    assert s.gain(1.0) < k1 < 0.25                                 # evidence makes later steps smaller


def test_kalman_variance_grows_without_evidence_so_it_can_follow_drift(env):
    c, x = card(env)
    s = UserState("u", 32, vcfg=K, now=0.0)
    for i in range(10):
        ci, xi = card(env, i)
        s.observe(ci, xi, [("view", None), ("like", None)], 1.0)
    k_now = s.gain(1.0)
    s.advance(1.0 + 24.0 * 10)                                    # ten quiet days
    assert s.gain(1.0) > k_now


def test_huber_guard_shrinks_an_outlier_like_once_evidence_is_high(env):
    emb, cat, world = env
    rng = np.random.default_rng(0)
    a = unit(rng)
    far = -a                                                       # points away from the reader's taste
    def after_outlier(cfg):
        s = UserState("u", 32, vcfg=cfg)
        s.vec = 0.8 * a; s.n_ev = 20.0; s.P = 0.3
        s._nudge(far, 1.0)
        return s.vec
    plain = after_outlier(VecCfg(update="kalman", r=3.0))
    guarded = after_outlier(VecCfg(update="kalman", r=3.0, huber_cos=0.0, huber_floor=0.35))
    assert float(guarded @ a) > float(plain @ a)                   # the guarded vector stays closer to the taste


def test_dwell_mult_weakens_dwell_nudges(env):
    c, x = card(env)
    ms = max(8000.0, c.word_count * 150.0) + 10
    s1 = UserState("u", 32, vcfg=VecCfg(update="kalman", r=3.0))
    s2 = UserState("u", 32, vcfg=VecCfg(update="kalman", r=3.0, dwell_mult=0.4))
    for s in (s1, s2):
        s.observe(c, x, [("view", None), ("dwell", ms)], 1.0)
    assert 0 < np.linalg.norm(s2.vec) < np.linalg.norm(s1.vec)


def test_default_vec_cfg_is_the_original_update(env):
    c, x = card(env)
    s = UserState("u", 32)
    s.observe(c, x, [("view", None), ("like", None)], 1.0)
    assert np.allclose(s.vec, 0.55 * x)


def test_pct_rank_is_deterministic_and_bounded():
    r = pct_rank(np.array([3.0, 1.0, 3.0, 2.0]))
    assert r.min() == 0.0 and r.max() == 1.0 and len(set(r)) == 4
    assert np.array_equal(r, pct_rank(np.array([3.0, 1.0, 3.0, 2.0])))


def test_evidence_gate_hands_over_with_evidence():
    s = UserState("u", 32)
    assert evidence_gate(s, 5.0) == 0.0
    s.n_strong = 5
    assert abs(evidence_gate(s, 5.0) - 0.5) < 1e-12
    assert evidence_gate(s, 0.0) == 1.0


def test_gate_with_no_evidence_follows_the_server_formula(env, tiny_heads):
    emb, cat, world = env
    now = float(cat.sort_at.max())
    rows = cat.fresh_rows(now)
    s = UserState("u", emb.k, follows=["tech"], now=now - 1)
    r = Ranker(tiny_heads, Variant(use_mmr=False, use_explore=False, gate_k=5.0))
    out = r.rank_rows(s, cat, rows, now, None)
    srv = CurrentServer(cat).raw_scores(s, rows, now, None)
    best = rows[np.argsort(-srv, kind="stable")[:10]]
    assert list(out[:10]) == list(best)


def test_platt_recovers_a_known_miscalibration():
    rng = np.random.default_rng(1)
    z = rng.normal(size=20000)
    y = (rng.random(20000) < 1 / (1 + np.exp(-z))).astype(float)
    raw = 1 / (1 + np.exp(-(2.0 * z + 1.0)))                       # overconfident and shifted
    a, b = platt_fit(raw, y)
    assert abs(a - 0.5) < 0.05 and abs(b + 0.5) < 0.08
    assert ece(platt_apply(raw, a, b), y) < ece(raw, y)


def test_robust_heads_are_monotone_in_cos_user():
    rng = np.random.default_rng(2)
    n = 4000
    X = rng.normal(size=(n, len(F.NAMES)))
    for c, k in (("event_code", 9), ("cat_code", 12), ("src_code", 9)):
        X[:, F.NAMES.index(c)] = rng.integers(0, k, n)
    cu = F.NAMES.index("cos_user")
    noise = rng.normal(size=n)
    y = {"like": ((X[:, cu] + np.sin(4 * X[:, cu]) + noise) > 0.8).astype(float),
         "dislike": ((-X[:, cu] + noise) > 1.0).astype(float),
         "detail": ((X[:, cu] + noise) > 1.2).astype(float),
         "comp": np.clip(0.5 + 0.2 * X[:, cu] + 0.1 * noise, 0, 2), "comp_ok": np.ones(n, bool)}
    h = train_heads(X, y, list(F.NAMES), robust=True)
    grid = np.tile(X[:1], (41, 1)); grid[:, cu] = np.linspace(-3, 3, 41)
    p = h.predict(grid)
    assert np.all(np.diff(p["like"]) >= -1e-12) and np.all(np.diff(p["dislike"]) <= 1e-12)


def test_domain_randomisation_is_seeded_and_excludes_the_third_world_knobs():
    a, b = world_params(5100, "dr"), world_params(5100, "dr")
    assert a == b and world_params(5101, "dr") != a
    assert set(a) == {"noise_mult", "taste_scale", "pos_decay"}
    assert 0.8 <= a["noise_mult"] <= 2.4 and 0.5 <= a["taste_scale"] <= 1.1
    assert world_params(1, "normal") == {}


def test_propensity_curve_starts_at_one_and_never_rises():
    rng = np.random.default_rng(3)
    n = 30000
    X = np.zeros((n, len(F.NAMES)))
    pos = rng.integers(0, 40, n)
    X[:, F.NAMES.index("position")] = pos
    y = {"like": (rng.random(n) < 0.2 / (1 + 0.1 * pos)).astype(float), "random_arm": np.ones(n, bool)}
    c = propensity(y, X, "like")
    assert c[0] == 1.0 and np.all(np.diff(c) <= 0) and c[-1] < 0.5


def test_third_world_knobs_are_off_by_default_and_change_behaviour_when_on(env):
    emb, cat, world = env
    p = make_persona(901, "t")
    now = float(cat.sort_at.max())
    rows = cat.fresh_rows(now)
    plain = World(cat, {c.id: world.L[i] for i, c in enumerate(cat.cards)})
    assert np.allclose(plain.z(p, rows, now), world.z(p, rows, now))
    wild = World(cat, {c.id: world.L[i] for i, c in enumerate(cat.cards)}, mood_sd=0.45, session_gain_sd=0.35,
                 drift=0.6, bursty=True, pos_form="exp")
    assert not np.allclose(wild.z(p, rows, now), world.z(p, rows, now))
    slots = [wild.session_slots(p, d) for d in range(30)]
    assert any(len(s) == 0 for s in slots) and slots == [wild.session_slots(p, d) for d in range(30)]


def test_rls_learns_from_plain_views_and_likes(env):
    emb, cat, world = env
    s = UserState("u", emb.k, now=0.0)
    tech = [i for i, c in enumerate(cat.cards) if c.category == "tech"][:12]
    other = [i for i, c in enumerate(cat.cards) if c.category == "energy"][:12]
    for i in tech[:6]:
        s.observe(cat.cards[i], cat.emb[i], [("view", None), ("like", None), ("dwell", 9000.0)], 1.0)
    for i in other[:6]:
        s.observe(cat.cards[i], cat.emb[i], [("view", None), ("dwell", 700.0)], 1.0)        # quick skips
    sc, se = s.rls_scores(cat.emb[tech[6:] + other[6:]])
    assert sc[:6].mean() > sc[6:].mean()
    assert np.all(se > 0)


def test_rls_reward_rules():
    s = UserState("u", 4)
    c = type("C", (), {"word_count": 40})()
    assert s.rls_reward(c, [("view", None), ("dwell", 3000.0)]) == 0.0                   # looked, did nothing
    assert s.rls_reward(c, [("view", None), ("dwell", 800.0)]) == -0.15                  # quick skip
    assert s.rls_reward(c, [("view", None), ("like", None), ("dwell", 9000.0)]) == 1.25
    assert s.rls_reward(c, [("view", None), ("dwell", 200000.0)]) is None                # walked away: no information
    assert s.rls_reward(c, [("view", None), ("like", None), ("open_detail", None), ("open_source", None)]) == 1.5  # capped


def test_rls_uncertainty_falls_with_evidence_and_decays_back(env):
    emb, cat, world = env
    s = UserState("u", emb.k, now=0.0)
    x = cat.emb[:1]
    _, se0 = s.rls_scores(x)
    for i in range(20):
        s.observe(cat.cards[i], cat.emb[i], [("view", None), ("dwell", 3000.0)], 1.0)
    _, se1 = s.rls_scores(x)
    s.advance(1.0 + 24.0 * 60)
    _, se2 = s.rls_scores(x)
    assert se1[0] < se0[0] and se1[0] < se2[0] <= se0[0] + 1e-9
