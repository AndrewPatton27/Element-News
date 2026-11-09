"""Ranking v3 SQL port (supabase/migrations/*_ranking_v3.sql) against the Python mirror (elementml.v3.reference).

PGlite parity: the reader's b_j, n_j and usual reward, every candidate's v3 hours and page key, the defaults,
v7 = v5 for a cold reader and with H = 0. Runs only when PGLITE_PACKAGE_JSON points at a package.json whose
node_modules has @electric-sql/pglite (and node is on PATH); otherwise skipped (REQUIRE_PGLITE makes it fail).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import numpy as np
import pytest

ML = Path(__file__).resolve().parents[1]
REPO = ML.parent
sys.path.insert(0, str(ML))

from elementml.bandit.policy import Event  # noqa: E402
from elementml.bandit.supa import hours_to_iso, iso_to_hours  # noqa: E402
from elementml.v3 import reference as R  # noqa: E402
from elementml.v3.methods import FINAL, parse  # noqa: E402
from elementml.v3.policy import V3Config  # noqa: E402

MIGRATION = next((REPO / "supabase" / "migrations").glob("*_ranking_v3.sql"))
SOURCE_NAMES = {"sec": "SEC", "fed": "Federal Reserve Board", "wikipedia": "Wikipedia", "nasa": "NASA", "usgs": "U.S. Geological Survey"}


def test_sql_defaults_match_python_and_the_tuned_config():
    sql = MIGRATION.read_text(encoding="utf-8")
    rows = dict(re.findall(r"\('(v3_[a-z0-9_]+)',\s*([0-9.]+)\)", sql))
    assert {k: float(v) for k, v in rows.items()} == R.SQL_DEFAULTS
    cfg = R.sql_config(R.sql_params())
    tuned = parse(FINAL)
    assert tuned.step_extra == 2.5
    for f in ("hours_per_reward", "cap_hours", "lam", "k0", "g_c", "g_t", "g_s", "g_g", "neg_mult", "step_extra",
              "window_days", "half_life_days", "explore", "solver", "base"):
        assert getattr(cfg, f) == getattr(tuned, f), f
    assert cfg.step_extra_cold == 0 and V3Config().step_extra_cold == 1      # SQL: cold readers get exactly v5
    assert "'foryou_ml_mode'" not in sql.split("-- B. SETTINGS")[1].split("-- D.")[0]   # ships off: mode not touched


def test_reference_cold_and_cap():
    P = R.sql_params({"v3_max_evidence_cards": 1})
    feats = {"a": ["c:tech", "g:ai"], "b": ["c:markets"]}
    words = {"a": 50, "b": 50}
    assert R.weights([], feats, words, 100.0, P) == ({}, {}, 0.0)
    assert R.card_hours(["c:tech"], {}, {}, P) == 0.0
    ev = [Event("a", "view", None, 90.0, 0), Event("a", "like", None, 90.0), Event("b", "view", None, 95.0, 1),
          Event("b", "dislike", None, 95.0)]
    b, n, _ = R.weights(ev, feats, words, 100.0, P)
    assert set(n) == {"c:markets"} and b["c:markets"] < 0                # only the latest card counts
    P0 = R.sql_params({"v3_lambda": 0, "v3_k0": 0})                       # no division by zero
    b, n, rbar = R.weights(ev, feats, words, 100.0, P0)
    assert all(np.isfinite(list(b.values()))) and np.isfinite(rbar)


def _fixture(rng, now):
    cats = ["tech", "world", "markets", "economy", "science", "policy"]
    heads = ["AI chips lift Nvidia", "Storm hits coast", "Stocks rally on Wall Street", "Jobs report shows hiring",
             "NASA rocket launch", "Fed holds interest rates", "Inflation cools, CPI slows", "Oil prices fall"]
    user = str(uuid.UUID(int=int(rng.integers(1, 2**62))))
    cards = []
    for i in range(40):
        kind = "data" if i % 9 == 4 else "summary"
        src = None if kind == "data" or i % 7 == 3 else list(SOURCE_NAMES)[i % 5]
        t = now - float(rng.uniform(0.5, 600))
        cards.append(dict(id=str(uuid.UUID(int=10**6 + i)), kind=kind, category=cats[i % len(cats)],
                          event_type=None if i % 5 == 2 else ["earnings", "fed", "macro_release", "deal", "science"][i % 5],
                          headline=heads[i % len(heads)] + f" {i}", body=" ".join(["word"] * int(rng.integers(10, 70))),
                          source_name=SOURCE_NAMES.get(src), series=["CPIAUCSL"] if kind == "data" else [],
                          rank_score=round(t + float(rng.uniform(0, 16)), 6), sort_at=hours_to_iso(t),
                          published_at=hours_to_iso(t + 0.1), status="hidden" if i == 39 else "published", t=t))
    for i, head in enumerate(["Storm hits the coast", "Court hears the case"]):    # untagged cards (no g: tag)
        t = now - 3.0 - i
        cards.append(dict(id=str(uuid.UUID(int=10**6 + 40 + i)), kind="summary", category="world", event_type="deal",
                          headline=head, body="word " * 30, source_name="NASA", series=[],
                          rank_score=round(t + 10, 6), sort_at=hours_to_iso(t), published_at=hours_to_iso(t + 0.1),
                          status="published", t=t))
    events = []
    for i in rng.choice(40, 26, replace=False):
        c = cards[int(i)]
        t = min(c["t"] + float(rng.uniform(0.2, 30)), now - 0.01)
        if int(i) % 6 != 5:                                              # some reactions without a view
            events.append(dict(blurb_id=c["id"], kind="view", dwell_ms=None, created_at=hours_to_iso(t), slot=int(rng.integers(0, 25))))
        k = rng.random()
        if k < 0.3:
            events.append(dict(blurb_id=c["id"], kind="like", dwell_ms=None, created_at=hours_to_iso(t + 0.001), slot=None))
        elif k < 0.42:
            events.append(dict(blurb_id=c["id"], kind="dislike", dwell_ms=None, created_at=hours_to_iso(t + 0.001), slot=None))
        elif k < 0.55:
            events.append(dict(blurb_id=c["id"], kind="open_detail", dwell_ms=None, created_at=hours_to_iso(t + 0.001), slot=None))
        elif k < 0.6:
            events.append(dict(blurb_id=c["id"], kind="open_source", dwell_ms=None, created_at=hours_to_iso(t + 0.001), slot=None))
        if rng.random() < 0.7:
            ms = float(rng.choice([700, 1400, 5000, 7500, 9000, 200000]))
            events.append(dict(blurb_id=c["id"], kind="dwell", dwell_ms=int(ms), created_at=hours_to_iso(t + 0.002), slot=None))
    events.append(dict(blurb_id=cards[0]["id"], kind="view", dwell_ms=None, created_at=hours_to_iso(now - 40 * 24), slot=0))  # out of window
    events.append(dict(blurb_id=cards[1]["id"], kind="like", dwell_ms=None, created_at=hours_to_iso(now + 0.5), slot=None))  # after as of
    return dict(user=user, asof=hours_to_iso(now), cards=cards, events=events, params={},
                prefs=dict(followed=["science"], hidden_categories=["policy"], hidden_sources=[]))


@pytest.mark.parametrize("variant", ["follows", "cold", "cold_step", "few", "hidden_source", "edge"])
def test_pglite_parity_v3(variant, tmp_path):
    pj = os.environ.get("PGLITE_PACKAGE_JSON")
    if not pj or not shutil.which("node"):
        if os.environ.get("REQUIRE_PGLITE"):
            pytest.fail("REQUIRE_PGLITE is set but PGLITE_PACKAGE_JSON or node is missing")
        pytest.skip("PGLITE_PACKAGE_JSON not set or node missing: SQL parity not run")
    rng = np.random.default_rng({"follows": 21, "cold": 22, "cold_step": 22, "few": 23, "hidden_source": 24, "edge": 25}[variant])
    now = float(int(time.time() // 3600) - 1)                           # in the past: the feed clips as of to now
    fx = _fixture(rng, now)
    if variant in ("cold", "cold_step"):
        fx["events"], fx["prefs"]["followed"] = [], []
    if variant == "cold_step":                                          # the Python behaviour: extra step when cold too
        fx["params"] = {"v3_step_extra_cold": 1}
    if variant == "few":
        fx["prefs"]["followed"] = []
        first = list(dict.fromkeys(e["blurb_id"] for e in fx["events"] if e["kind"] == "view"))[:3]
        fx["events"] = [e for e in fx["events"] if e["blurb_id"] in first]
    if variant == "hidden_source":
        fx["prefs"]["hidden_sources"] = ["sec"]
    if variant == "edge":
        fx["params"] = {"v3_lambda": 0, "v3_k0": 0, "v3_neg_mult": 2, "v3_cap_hours": 5, "v3_max_evidence_cards": 6,
                        "v3_window_days": 10, "v3_w_source": 0.2}
    (tmp_path / "fx.json").write_text(json.dumps(fx), encoding="utf-8")
    run = subprocess.run(["node", str(ML / "tests" / "pglite_parity_v3.mjs"), str(REPO), str(tmp_path / "fx.json")],
                         capture_output=True, text=True, timeout=600)
    assert run.returncode == 0, run.stderr[-2000:]
    sql = json.loads(run.stdout)
    assert sql["defaults"] == R.SQL_DEFAULTS

    P = R.sql_params(fx["params"])
    feats_of = {c["id"]: sorted(c["features"]) for c in sql["cards"]}
    words_of = {c["id"]: c["word_count"] for c in sql["cards"]}
    asof = iso_to_hours(fx["asof"])
    evs = [Event(e["blurb_id"], e["kind"], e["dwell_ms"], iso_to_hours(e["created_at"]), e["slot"]) for e in fx["events"]]
    b, n, rbar = R.weights(evs, feats_of, words_of, asof, P)
    assert sorted(r["j"] for r in sql["weights"]) == sorted(n)
    for r in sql["weights"]:
        assert r["n"] == pytest.approx(n[r["j"]], abs=1e-9)
        assert r["b"] == pytest.approx(b[r["j"]], abs=1e-9)
        assert r["rbar"] == pytest.approx(rbar, abs=1e-9)

    # every candidate's v3 hours, and the page key: (v5 score + hours) - step x better same-topic cards ahead
    nev = sum(1 for e in evs if asof - P["affinity_days"] * 24 < e.t < asof)
    step = P["foryou_category_step_hours"]
    if not fx["prefs"]["followed"]:
        step += max(P["foryou_cold_step_hours"], 0) * max(1 - nev / max(P["foryou_cold_events"], 1), 0)
    if n or P["v3_step_extra_cold"] > 0:
        step += P["v3_step_extra"]
    depth: dict[str, int] = {}
    for s in sorted(sql["scores"], key=lambda s: (round(s["s0"] + s["v3"], 6), s["id"]), reverse=True):
        assert s["v3"] == pytest.approx(R.card_hours(feats_of[s["id"]], b, n, P), abs=2e-6), s["id"]
        d = depth.get(s["category"], 0)
        depth[s["category"]] = d + 1
        assert s["ps"] == pytest.approx(s["s0"] + s["v3"] - step * d, abs=2e-5)
    assert all(abs(s["v3"]) <= P["v3_cap_hours"] + 1e-9 for s in sql["scores"])
    # untagged cards (no g: feature, ~71% of real headlines): no tag term at all, only topic/type/source
    untagged = [s for s in sql["scores"] if not any(j.startswith("g:") for j in feats_of[s["id"]])]
    assert untagged
    for s in untagged:
        raw = sum({"c": P["v3_w_topic"], "t": P["v3_w_type"], "s": P["v3_w_source"]}[j[0]] * b.get(j, 0.0)
                  for j in feats_of[s["id"]])
        h = P["v3_hours_per_reward"] * raw
        h = h * P["v3_neg_mult"] if h < 0 else h
        assert s["v3"] == pytest.approx(max(-P["v3_cap_hours"], min(P["v3_cap_hours"], h)) if n else 0.0, abs=2e-6)
    # a card none of whose features has evidence: exactly 0 hours (its v5 score)
    for s in sql["scores"]:
        if not any(j in n for j in feats_of[s["id"]]):
            assert s["v3"] == 0.0
    assert len(sql["v7"]) == len(set(sql["v7"])) == len(sql["scores"]) > 20      # a full scroll, no repeats
    assert sql["v7_off"] == sql["v5"]                                             # H = 0: the formula exactly
    if variant == "cold":
        assert not n and sql["v7"] == sql["v5"]                                   # cold start: v5 exactly
    elif variant == "cold_step":
        assert not n and all(s["v3"] == 0 for s in sql["scores"])
    else:
        assert any(abs(s["v3"]) > 0.5 for s in sql["scores"])                      # the term is not trivially 0
    if variant == "edge":
        assert max(abs(s["v3"]) for s in sql["scores"]) == pytest.approx(5, abs=1e-6)   # the cap binds
