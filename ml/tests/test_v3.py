"""Ranking v3 (formula + per-reader residual): direction, no-evidence identity, bounds, centering, solvers,
determinism, no simulator imports, method parsing."""
import ast
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from elementml.bandit.policy import Agg
from elementml.features.uservec import UserState
from elementml.ranking.baselines import CurrentServer
from elementml.v3 import ResidualPolicy, V3Config, reader_weights, residual_hours
from elementml.v3.methods import parse

ROOT = Path(__file__).resolve().parents[1] / "elementml"
FEATS = {"a": ["c:tech", "g:ai", "s:sec"], "b": ["c:tech", "s:sec"], "m": ["c:markets", "g:markets", "s:fred"],
         "n": ["c:markets", "s:fred"]}
WORDS = {k: 60 for k in FEATS}


def _agg(liked=False, disliked=False, dwell=None, t=100.0):
    return Agg(liked=liked, disliked=disliked, viewed=True, max_dwell=dwell, last_at=t)


def test_like_raises_and_dislike_lowers_the_liked_features():
    aggs = {"a": _agg(liked=True, dwell=9000), "m": _agg(disliked=True, dwell=800)}
    b, n, rbar = reader_weights(aggs, FEATS, WORDS, 101.0, V3Config())
    assert b["c:tech"] > 0 and b["g:ai"] > 0 and b["c:markets"] < 0 and b["g:markets"] < 0
    cfg = V3Config()
    assert residual_hours(FEATS["a"], b, n, cfg) > 0 > residual_hours(FEATS["m"], b, n, cfg)


def test_no_evidence_means_exactly_the_formula(env):
    _, cat, _ = env
    now = 5 * 24.0 + 12
    rows = cat.fresh_rows(now)
    st = UserState("u", cat.emb.shape[1], follows=["tech"], now=now - 1)
    pol = ResidualPolicy(cat)
    assert np.all(pol.hours(st, rows, now) == 0.0)
    assert list(pol.rank(st, rows, now, None)) == list(CurrentServer(cat).rank(st, rows, now, None))


def test_centering_removes_the_long_look_drift():
    """Every card read to the end (+0.25 each) is this reader's usual card: no topic looks special."""
    aggs = {k: _agg(dwell=9000) for k in FEATS}
    b, _, rbar = reader_weights(aggs, FEATS, WORDS, 101.0, V3Config(k0=0.0))
    assert rbar == pytest.approx(0.25)
    assert all(abs(v) < 1e-12 for v in b.values())


def test_residual_is_bounded_and_grows_with_evidence():
    cfg = V3Config(hours_per_reward=500.0, cap_hours=24.0)
    many = {f"x{i}": _agg(liked=True, dwell=9000) for i in range(40)}
    many.update({f"y{i}": _agg(dwell=800) for i in range(40)})
    feats = {**{f"x{i}": ["c:tech"] for i in range(40)}, **{f"y{i}": ["c:world"] for i in range(40)}}
    b, n, _ = reader_weights(many, feats, {k: 60 for k in feats}, 101.0, cfg)
    assert residual_hours(["c:tech"], b, n, cfg) == 24.0 and residual_hours(["c:world"], b, n, cfg) == -24.0
    small = V3Config()
    one = reader_weights({"x0": many["x0"], "y0": many["y0"]}, feats, {k: 60 for k in feats}, 101.0, small)
    lots = reader_weights(many, feats, {k: 60 for k in feats}, 101.0, small)
    assert 0 < one[0]["c:tech"] < lots[0]["c:tech"]


def test_ridge_and_diag_agree_on_direction():
    aggs = {"a": _agg(liked=True, dwell=9000), "b": _agg(dwell=9000), "m": _agg(disliked=True), "n": _agg(dwell=800)}
    bd, _, _ = reader_weights(aggs, FEATS, WORDS, 101.0, V3Config())
    br, _, _ = reader_weights(aggs, FEATS, WORDS, 101.0, V3Config(solver="ridge"))
    for j in ("c:tech", "c:markets", "g:ai"):
        assert np.sign(bd[j]) == np.sign(br[j]) != 0


def test_deterministic_including_draws(env):
    _, cat, world = env
    now = 5 * 24.0 + 12
    rows = cat.fresh_rows(now)
    st = UserState("u", cat.emb.shape[1], follows=[], now=now - 2)
    for r in rows[:15]:
        st.observe(cat.cards[r], cat.emb[r], [("view", None), ("like", None), ("dwell", 9000.0)] if r % 3 == 0
                   else [("view", None), ("dwell", 700.0)], now - 1)
    pol = ResidualPolicy(cat, V3Config(explore=1.0))
    a, b = pol.rank(st, rows, now, None), pol.rank(st, rows, now, None)
    assert list(a) == list(b) and sorted(a) == sorted(set(a))


def test_method_parsing():
    cfg = parse("v3:H=36,cap=30,step_extra=1.5,solver=ridge")
    assert (cfg.hours_per_reward, cfg.cap_hours, cfg.step_extra, cfg.solver) == (36.0, 30.0, 1.5, "ridge")
    assert parse("v3") == V3Config()
    with pytest.raises(KeyError):
        parse("v3:nope=1")


def test_v3_never_imports_the_simulator():
    for p in (ROOT / "v3").glob("*.py"):
        tree = ast.parse(p.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                assert "simulator" not in (node.module or "").split("."), p
            if isinstance(node, ast.Import):
                assert not any("simulator" in a.name.split(".") for a in node.names), p
    out = subprocess.run([sys.executable, "-I", "-c", "import sys; sys.path.insert(0, r'%s'); import elementml.v3;"
                          "print(any(m.startswith('elementml.simulator') for m in sys.modules))" % ROOT.parent],
                         capture_output=True, text=True)
    assert out.stdout.strip() == "False", out.stderr
