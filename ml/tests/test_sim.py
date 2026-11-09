import numpy as np

from elementml import config as C
from elementml.evaluation.policies import RankerPolicy, state_factory
from elementml.serving import Ranker, Variant
from elementml.simulator import make_persona, ndcg_at, run_cohort


def test_persona_prefers_own_subtopic_and_shift_changes_taste(env):
    emb, cat, world = env
    p = make_persona(11, "t", shift=True, kind="picky_sub")
    p.shift_day = 5
    rows = np.arange(0, cat.n, 7)
    now = float(cat.sort_at.max())
    g = world.gain(p, rows, now)
    liked = np.argmax(p.taste)
    on = world.sub_main[rows] == liked
    assert g[on].mean() > g[~on].mean() * 1.5
    t_before, t_after = world.taste_of(p, 4.0), world.taste_of(p, 6.0)
    assert not np.allclose(t_before, t_after)


def test_behaviour_signs_and_position_bias(env):
    emb, cat, world = env
    p = make_persona(12, "t", kind="casual")
    now = float(cat.sort_at.max())
    rows = np.arange(0, cat.n, 3)
    z = world.z(p, rows, now)
    hi, lo = rows[np.argmax(z)], rows[np.argmin(z)]
    _, pl_hi, pd_hi, *_ = world.probs(p, np.array([hi]), now)
    _, pl_lo, pd_lo, *_ = world.probs(p, np.array([lo]), now)
    assert pl_hi[0] > pl_lo[0] and pd_hi[0] < pd_lo[0]
    _, pl_top, *_ = world.probs(p, np.array([hi]), now, exam=1.0)
    _, pl_deep, *_ = world.probs(p, np.array([hi]), now, exam=1 / (1 + 0.07 * 20))
    assert pl_deep[0] < pl_top[0]


def test_dwell_scales_with_words_and_skips_are_short(env):
    emb, cat, world = env
    p = make_persona(13, "t", kind="skimmer")
    now = float(cat.sort_at.max())
    long_rows = [r for r in range(cat.n) if cat.words[r] >= 55][:200]
    short_rows = [r for r in range(cat.n) if cat.words[r] <= 25][:200]
    def mean_dwell(rows):
        d = []
        for r in rows:
            ev, out = world.behave(p, r, 0, now)
            if not out["skipped"] and out["dwell"] < C.DWELL_WALKAWAY_MS:
                d.append(out["dwell"])
        return np.mean(d)
    assert mean_dwell(long_rows) > 1.4 * mean_dwell(short_rows)
    skips = [out["dwell"] for r in range(300) for ev, out in [world.behave(p, r, 0, now)] if out["skipped"] and out["dwell"] < C.DWELL_WALKAWAY_MS]
    assert skips and max(skips) <= C.DWELL_SKIP_MS


def test_ndcg_basics():
    g = np.array([3.0, 2.0, 1.0, 0.0])
    assert abs(ndcg_at(g, g, 4) - 1.0) < 1e-12
    assert ndcg_at(g[::-1], g, 4) < 0.7


def test_cohort_run_is_deterministic(env, tiny_heads):
    emb, cat, world = env
    personas = [make_persona(40 + i, "t") for i in range(4)]
    def run():
        pol = RankerPolicy(Ranker(tiny_heads, Variant()), cat, "x")
        out = run_cohort(world, personas, lambda p: pol, state_factory(emb), 2)
        return [(s["user"], s["day"], round(s["ndcg10"], 9), s["n_cards"], round(s["dwell_total"], 3)) for s in out["sessions"]]
    a, b = run(), run()
    assert a == b and len(a) > 0


def test_simulator_events_are_only_kinds_and_dwell(env, tiny_heads):
    emb, cat, world = env
    p = make_persona(77, "t")
    ev, out = world.behave(p, 10, 0, float(cat.sort_at.max()))
    assert ev[0] == ("view", None) and ev[-1][0] == "dwell"
    assert {k for k, _ in ev} <= {"view", "like", "dislike", "open_detail", "open_source", "dwell"}
