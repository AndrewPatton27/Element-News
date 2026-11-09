"""Tests for ranking v2 (elementml.bandit): the belief update, shrinkage, draws, paging stability, training,
the gate, and parity with the SQL in supabase/migrations/*_ranking_v2.sql.

The PGlite parity test runs only when PGLITE_PACKAGE_JSON points at a package.json whose node_modules has
@electric-sql/pglite (and node is on PATH); otherwise it is skipped with a message.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import numpy as np
import pytest

ML = Path(__file__).resolve().parents[1]
REPO = ML.parent
sys.path.insert(0, str(ML))

from elementml.bandit import features as FT  # noqa: E402
from elementml.bandit import gate as G  # noqa: E402
from elementml.bandit import prior as PR  # noqa: E402
from elementml.bandit.params import DEFAULTS, LEAN_TAGS, params  # noqa: E402
from elementml.bandit.policy import (Agg, BanditPolicy, Event, Model, RefCard, bandit_hours, card_prior,  # noqa: E402
                                     card_reward, feature_stats, holdout_u, keyset_page, lean_tags_from,
                                     normal_draw, posterior, propensity_weight, score_reference,
                                     trend_boost_hours, trend_points_v2)

MIGRATION = next((REPO / "supabase" / "migrations").glob("*_ranking_v2.sql"))
P = params()
NOW = 500000.0                                    # hours since epoch (any fixed time)
U = "11111111-2222-4333-8444-555555555555"


def card(i, cat="tech", typ="earnings", skey="sec", head="Company news", age=2.0, imp_h=0.0, words=40, series=()):
    t = NOW - age
    return RefCard(id=f"00000000-0000-4000-8000-{i:012d}", category=cat, typ=typ, skey=skey, headline=head,
                   series=tuple(series), rank_score=t + imp_h, sort_at=t, published_at=t, words=words)


# ---- rewards and weights ---------------------------------------------------------------------
def test_reward_uses_live_weights_and_caps():
    assert card_reward(Agg(liked=True), 40, P) == 1.0
    assert card_reward(Agg(disliked=True), 40, P) == -1.0
    assert card_reward(Agg(detail=True, src=True), 40, P) == 1.0
    assert card_reward(Agg(liked=True, detail=True, src=True, max_dwell=9000), 40, P) == 1.5     # capped
    assert card_reward(Agg(viewed=True, max_dwell=8000), 40, P) == 0.25                           # long look (40 words -> 6 s)
    assert card_reward(Agg(viewed=True, max_dwell=900), 40, P) == pytest.approx(-0.15)            # quick skip
    assert card_reward(Agg(viewed=True, liked=True, max_dwell=900), 40, P) == 1.0                 # a tap is not a skip
    assert card_reward(Agg(viewed=True), 40, P) == 0.0                                            # ignored


def test_walkaway_dwell_is_ignored():
    from elementml.bandit.policy import aggregate
    a = aggregate([Event("x", "view", None, NOW - 1), Event("x", "dwell", 150000.0, NOW - 1)], NOW, P, 30)["x"]
    assert a.max_dwell is None and card_reward(a, 40, P) == 0.0


def test_propensity_weight_is_capped():
    m = Model(prop={0: 1.0, 5: 0.5, 20: 0.1})
    assert propensity_weight(None, m, P) == 1.0
    assert propensity_weight(5, m, P) == 2.0
    assert propensity_weight(30, m, P) == DEFAULTS["v2_propensity_cap"]                # 1/0.1 = 10 -> cap 3
    assert propensity_weight(7, m, P) == 1.0                                           # unknown bucket


# ---- the belief ----------------------------------------------------------------------------------
def _stats(events, cards, follows=()):
    from elementml.bandit.policy import aggregate
    aggs = aggregate(events, NOW, P, 30)
    return feature_stats(aggs, {c.id: c.features for c in cards}, {c.id: c.words for c in cards}, follows, Model(), NOW, P)


def test_update_direction():
    cs = [card(i) for i in range(6)]
    up = _stats([Event(c.id, "like", None, NOW - 1) for c in cs], cs)
    down = _stats([Event(c.id, "dislike", None, NOW - 1) for c in cs], cs)
    mu_up, _ = posterior("c:tech", up, Model(), P, set())
    mu_dn, _ = posterior("c:tech", down, Model(), P, set())
    assert mu_up > 0 > mu_dn
    assert posterior("c:world", up, Model(), P, set())[0] == 0.0                         # untouched feature stays at prior


def test_shrinkage_and_uncertainty():
    m = Model(mu0={"c:tech": 0.2}, lam={"c": 5.0}, tau=0.5)
    mu0, sd0 = posterior("c:tech", {}, m, P, set())
    assert mu0 == pytest.approx(0.2) and sd0 == pytest.approx(0.5 / math.sqrt(5))
    few = {"c:tech": [1.0, 1.0]}                                                         # n = 1, mean reward 1
    many = {"c:tech": [50.0, 50.0]}
    mu_f, sd_f = posterior("c:tech", few, m, P, set())
    mu_m, sd_m = posterior("c:tech", many, m, P, set())
    assert 0.2 < mu_f < mu_m < 1.0 and mu_m > 0.9                                       # evidence pulls away from the prior
    assert sd0 > sd_f > sd_m                                                             # and narrows the draw
    strong = Model(mu0={"c:tech": 0.2}, lam={"c": 34.0}, tau=0.5)
    assert posterior("c:tech", few, strong, P, set())[0] < mu_f                          # bigger lambda = more shrinkage


def test_follow_is_three_pseudo_rewards():
    st = _stats([], [card(1)], follows=["tech", "tech"])
    assert st["c:tech"] == [3.0, 1.5]


def test_lean_is_a_prior_that_signals_overcome():
    lean = lean_tags_from(P)
    assert lean == set(LEAN_TAGS)
    assert posterior("g:rates", {}, Model(), P, lean)[0] == pytest.approx(0.15)
    assert posterior("g:rates", {}, Model(), params({"v2_prior_lean": 0}), lean)[0] == 0.0
    cs = [card(i, cat="economy", typ="macro_release", skey="fred", head="Fed holds rates") for i in range(12)]
    st = _stats([Event(c.id, "dislike", None, NOW - 1) for c in cs], cs)
    assert posterior("g:rates", st, Model(), P, lean)[0] < 0                             # an anti-macro reader turns it negative
    off = lean_tags_from({**P, "v2_lean_tag_rates": 0, "v2_lean_tag_jobs": 1})
    assert "rates" not in off and "jobs" in off


def test_features_and_tags():
    f = FT.card_features("economy", "macro_release", "fred", "Inflation cools as CPI slows", ["CPIAUCSL"])
    assert f == ["c:economy", "g:growth", "g:inflation", "s:fred", "t:macro_release"]
    assert "g:ai" not in FT.card_features("tech", None, None, "Said again")          # 'ai' only as a whole word
    assert "g:ai" in FT.card_features("tech", None, None, "New AI chips")
    assert "g:rates" in FT.card_features("policy", "fed", "fed", "Statement")
    assert FT.x_of(f) == pytest.approx(1 / math.sqrt(5))
    assert all(FT.KEYWORD_PATTERN.match(p) for k, p, _ in FT.TAG_RULES if k == "keyword")


# ---- draws, seeds and paging ----------------------------------------------------------------------
def test_same_seed_same_draw():
    assert normal_draw(U, "c:tech", 42) == normal_draw(U, "c:tech", 42)
    assert normal_draw(U, "c:tech", 42) != normal_draw(U, "c:tech", 43)
    assert normal_draw(U, "c:tech", 42) != normal_draw(U, "c:world", 42)
    z = np.array([normal_draw(U, f"c:{i}", 7) for i in range(4000)])
    assert abs(z.mean()) < 0.06 and abs(z.std() - 1) < 0.05
    assert 0 < holdout_u(U) < 1


def _world(n=40):
    cats = ["tech", "world", "markets", "economy", "science"]
    return [card(i, cat=cats[i % 5], typ=["earnings", "world_event", None, "macro_release", "science"][i % 5],
                 skey=["sec", "wikipedia", "fed", "fred", "nasa"][i % 5], head=["AI chips", "Storm", "Stocks rally", "Jobs report", "Rocket"][i % 5],
                 age=1 + i * 0.7, imp_h=(i * 37 % 11) * 0.5) for i in range(n)]


def test_same_cursor_same_page_and_no_repeats():
    cs = _world()
    ev = [Event(cs[0].id, "view", None, NOW - 3, 0), Event(cs[0].id, "like", None, NOW - 3),
          Event(cs[3].id, "view", None, NOW - 2, 1), Event(cs[3].id, "dwell", 900.0, NOW - 2)]
    a = score_reference(U, cs, ev, [], [], [], Model(), P, NOW, 99)
    later = ev + [Event(cs[5].id, "view", None, NOW + 0.1, 0), Event(cs[6].id, "like", None, NOW + 0.2)]
    b = score_reference(U, cs, later, [], [], [], Model(), P, NOW, 99)                # events after as of: same scores
    assert a == b
    pages, key, kid = [], 1e12, "ffffffff-ffff-ffff-ffff-ffffffffffff"
    while True:
        pg = keyset_page(b, key, kid, 10)
        if not pg:
            break
        pages += [s.id for s in pg]
        key, kid = pg[-1].ps, pg[-1].id
    assert len(pages) == len(set(pages)) == len(a)
    assert score_reference(U, cs, ev, [], [], [], Model(), P, NOW, 100) != a              # a new scroll draws again


def test_cold_start_and_bounds():
    cs = _world()
    s = score_reference(U, cs, [], ["tech"], [], [], Model(), P, NOW, 5)
    assert len(s) == len(cs)
    assert all(abs(x.bandit) <= P["v2_cap_hours"] for x in s)
    no_explore = score_reference(U, cs, [], [], [], [], Model(), params({"v2_explore": 0, "v2_prior_lean": 0}), NOW, 5)
    assert all(x.bandit == 0 for x in no_explore)                                        # no prior, no draw: formula order
    hidden = score_reference(U, cs, [Event(cs[1].id, "dislike", None, NOW - 1)], [], ["science"], [], Model(), P, NOW, 5)
    ids = {x.id for x in hidden}
    assert cs[1].id not in ids and not any(x.category == "science" for x in hidden)


def test_follow_raises_topic_on_average():
    cs = _world()
    gain = []
    for seed in range(40):
        a = {x.id: x.bandit for x in score_reference(U, cs, [], ["tech"], [], [], Model(), P, NOW, seed)}
        b = {x.id: x.bandit for x in score_reference(U, cs, [], [], [], [], Model(), P, NOW, seed)}
        gain.append(np.mean([a[c.id] - b[c.id] for c in cs if c.category == "tech"]))
    assert np.mean(gain) > 1.0                                                           # hours


def test_trending_shrink_two_lucky_likes():
    lucky = trend_points_v2(6.0, 2, 0.0, P)
    fed = trend_points_v2(20.0, 20, 0.15, P)
    assert lucky == pytest.approx(1.0)
    assert trend_boost_hours(lucky, P) < trend_boost_hours(6.0, P) / 2
    assert trend_boost_hours(fed, P) > 0.85 * trend_boost_hours(20.0, P)
    assert card_prior(["c:markets", "g:markets"], Model(), P, set(LEAN_TAGS)) == pytest.approx(0.15 / math.sqrt(2))


# ---- training -----------------------------------------------------------------------------------
def _population(n_readers, rng, days=21, tech_like=0.6):
    cs = [card(i, cat=["tech", "world"][i % 2], typ=None, skey=None, head="", age=rng.uniform(1, days * 24))
          for i in range(300)]
    ev = {}
    for r in range(n_readers):
        u = f"u{r:03d}"
        out = []
        for c in rng.choice(len(cs), 40, replace=False):
            cc = cs[c]
            t = cc.sort_at + 0.5
            out.append(Event(cc.id, "view", None, t, int(rng.integers(0, 10))))
            if cc.category == "tech" and rng.random() < tech_like:
                out.append(Event(cc.id, "like", None, t))
        ev[u] = out
    return cs, ev


def test_fit_falls_back_to_hand_prior_under_min_readers():
    rng = np.random.default_rng(1)
    cs, ev = _population(12, rng)
    m, rep = PR.fit(ev, {c.id: c.features for c in cs}, {c.id: c.words for c in cs}, {}, NOW, P)
    assert not m.mu0 and not m.prop and "fallback" in rep
    assert m.rows() == []


def test_fit_recovers_population_means():
    rng = np.random.default_rng(2)
    cs, ev = _population(40, rng)
    m, rep = PR.fit(ev, {c.id: c.features for c in cs}, {c.id: c.words for c in cs}, {}, NOW, P)
    assert m.mu0["c:tech"] > m.mu0["c:world"] + 0.3
    assert all(m.n_readers[k] >= P["v2_min_readers"] for k in m.mu0)
    assert set(m.lam) == set(FT.GROUPS) and all(v in PR.LAMBDA_GRID for v in m.lam.values())
    assert m.tau and m.tau > 0.05
    assert len(m.rows()) < 300
    again, _ = PR.fit(ev, {c.id: c.features for c in cs}, {c.id: c.words for c in cs}, {}, NOW, P)
    assert again.rows() == m.rows()                                                     # deterministic


def test_fit_one_reader_cannot_set_the_prior():
    rng = np.random.default_rng(3)
    cs, ev = _population(25, rng, tech_like=0.0)
    heavy = []
    for c in cs:
        if c.category == "tech":
            heavy += [Event(c.id, "view", None, c.sort_at + 0.5, 0), Event(c.id, "like", None, c.sort_at + 0.5)]
    ev["heavy"] = heavy
    m, _ = PR.fit(ev, {c.id: c.features for c in cs}, {c.id: c.words for c in cs}, {}, NOW, P)
    assert m.mu0["c:tech"] < 0.25                                                        # 1 of 26 readers, capped weight


def test_fit_privacy_floor():
    rng = np.random.default_rng(4)
    cs, ev = _population(30, rng)
    rare = card(999, cat="safety", typ=None, skey=None, head="")
    for u in list(ev)[:19]:                                                              # only 19 readers saw it
        ev[u].append(Event(rare.id, "view", None, rare.sort_at + 0.1, 0))
    cs.append(rare)
    m, _ = PR.fit(ev, {c.id: c.features for c in cs}, {c.id: c.words for c in cs}, {}, NOW, P)
    assert "c:safety" not in m.mu0


def test_model_rows_round_trip():
    m = Model(mu0={"c:tech": 0.1}, n_readers={"c:tech": 25}, lam={"c": 3.0}, tau=0.4, prop={0: 1.0, 3: 0.7})
    assert Model.from_rows(m.rows()).rows() == m.rows()


# ---- the gate -------------------------------------------------------------------------------------
def _runs(world="normal", d_ndcg=0.02, d_dis=0.0, d_cats=0.0, d_rec=0.0, macro=0.1, macro_true=0.1, wins=5):
    out = []
    for s in range(1, 6):
        base = dict(world=world, seed=s, ndcg10=0.4, exp_dis10=0.1, cats10=6.0, recovery_days=3.0, macro_anti=0.1, macro_anti_true=0.1)
        out.append(dict(base, method="a1_current_server"))
        out.append(dict(base, method="ts_v2", ndcg10=0.4 + (d_ndcg if s <= wins else -0.01), exp_dis10=0.1 + d_dis,
                        cats10=6.0 + d_cats, recovery_days=3.0 + d_rec, macro_anti=macro, macro_anti_true=macro_true))
    return out


def test_synthetic_gate_logic():
    ok = _runs("normal") + _runs("stress") + _runs("wild")
    assert G.synthetic_gate(ok)["passed"]
    assert G.synthetic_gate(_runs("normal") + _runs("stress", wins=4) + _runs("wild"))["passed"]
    for bad in (dict(wins=3), dict(d_dis=0.006), dict(d_cats=-0.31), dict(d_rec=1.01), dict(macro=0.13, macro_true=0.1)):
        res = G.synthetic_gate(_runs("normal") + _runs("stress", **bad) + _runs("wild"))
        assert not res["passed"] and not res["worlds"]["stress"]["passed"], bad
        assert res["worlds"]["normal"]["passed"]
    assert not G.synthetic_gate([])["passed"]


def test_replay_ignores_what_happens_after_the_page():
    cs = _world(12)
    m = Model(prop={b: 1.0 / (1 + 0.1 * b) for b in range(21)})
    page = {"user_id": U, "surface": "for_you", "as_of": NOW, "shown_at": NOW, "card_ids": [c.id for c in cs]}
    hist = [card(100 + i, cat="world", head="Storm") for i in range(30)]              # evidence off the page
    base = [Event(cs[11].id, "view", None, NOW + 0.1, 11), Event(cs[11].id, "like", None, NOW + 0.1)]
    base += [Event(c.id, "like", None, NOW - 5) for c in hist]
    later = base + [Event(c.id, "dislike", None, NOW + 3) for c in cs[:6]]            # after the page and its window
    cards = {c.id: c for c in cs + hist}
    P0 = params({"v2_explore": 0})
    g1 = G.replay_gains([page], {U: base}, cards, {}, m, P0)[U][0]
    g2 = G.replay_gains([page], {U: later}, cards, {}, m, P0)[U][0]
    assert g1 == g2
    no_hist = G.replay_gains([page], {U: base[:2]}, cards, {}, m, P0)[U][0]
    assert no_hist != g1                                                                 # off-page evidence counts


def test_refcard_uses_exported_features():
    c = RefCard(id="x", category="tech", typ=None, skey=None, headline="", tags=("g:ai", "c:tech"))
    assert c.features == ["c:tech", "g:ai"]
    assert FT.card_features("", None, None, "") == []                                    # null category: no c: feature


def test_replay_gate_needs_data_and_a_positive_lower_bound():
    pages = [{"surface": "for_you", "shown_at": NOW + d * 24} for d in range(20)]
    few = G.replay_gate(pages, {f"u{i}": [0.1] for i in range(50)})
    assert not few["passed"] and "needs" in few["why"]
    many = {f"u{i}": [0.05 + 0.01 * (i % 3)] for i in range(250)}
    assert G.replay_gate(pages, many)["passed"]
    noisy = {f"u{i}": [(-1) ** i * 0.5] for i in range(250)}
    assert not G.replay_gate(pages, noisy)["passed"]
    assert not G.decide({"passed": True}, {"passed": False}) and G.decide({"passed": True}, {"passed": True})


def test_replay_moves_rewarded_cards_up():
    cs = _world(12)
    m = Model(prop={b: 1.0 / (1 + 0.1 * b) for b in range(21)})      # mild: slots 9 and 11 differ above the cap
    liked = cs[11]                                                                       # logged at the last slot
    ev = {U: [Event(liked.id, "view", None, NOW + 0.1, 11), Event(liked.id, "like", None, NOW + 0.1)]}
    # a reader whose history makes v2 rank that topic first
    hist = [c for c in _world(40) if c.category == liked.category][:6]
    ev[U] += [Event(c.id, "like", None, NOW - 5) for c in hist]
    page = {"user_id": U, "surface": "for_you", "as_of": NOW, "shown_at": NOW, "card_ids": [c.id for c in cs]}
    cards = {c.id: c for c in cs + hist}
    g = G.replay_gains([page], ev, cards, {}, m, params({"v2_explore": 0}))
    assert g[U][0] > 0


# ---- the SQL file agrees with Python ------------------------------------------------------------------
def test_tag_rules_match_migration():
    sql = MIGRATION.read_text(encoding="utf-8")
    seed = sql.split("insert into core.tag_rules (match_kind, pattern, tag) values", 1)[1].split("on conflict", 1)[0]
    rows = re.findall(r"\('(category|event_type|series|keyword)', '([^']+)', '([^']+)'\)", seed)
    assert rows == FT.TAG_RULES


def test_rank_params_match_migration():
    sql = MIGRATION.read_text(encoding="utf-8")
    vals = dict((k, float(v)) for k, v in re.findall(r"\('(v2_[a-z_]+)',\s*([0-9.]+)\)", sql))
    for k, v in DEFAULTS.items():
        if k.startswith("v2_"):
            assert vals.get(k) == v, k
    assert {k[len("v2_lean_tag_"):] for k in vals if k.startswith("v2_lean_tag_")} == set(LEAN_TAGS)


def test_bandit_does_not_import_simulator():
    for f in (ML / "elementml" / "bandit").glob("*.py"):
        imports = re.findall(r"^\s*(?:from|import)\s+(\S+)", f.read_text(encoding="utf-8"), flags=re.M)
        assert not any("simulator" in m for m in imports), f


def test_bandit_policy_ranks_eligible_rows():
    from elementml.data.catalog import Catalog
    from elementml.data.generator import generate_cards
    from elementml.features.uservec import UserState
    cards, _ = generate_cards(3, days=2)
    cat = Catalog(cards, np.zeros((len(cards), 4)))
    pol = BanditPolicy(cat, Model(), P)
    st = UserState("reader-1", 4, follows=["tech"])
    rows = cat.fresh_rows(cat.sort_at[-1])
    first = cat.cards[rows[0]]
    st.observe(first, np.zeros(4), [("view", None), ("dislike", None)], cat.sort_at[-1] - 1)
    out = pol.rank(st, rows, cat.sort_at[-1], None)
    assert set(out.tolist()) == set(rows.tolist()) - {rows[0]}
    assert (pol.rank(st, rows, cat.sort_at[-1], None) == out).all()                       # same session: same order


# ---- PGlite parity ----------------------------------------------------------------------------------
SOURCE_NAMES = {"sec": "SEC", "fed": "Federal Reserve Board", "wikipedia": "Wikipedia", "nasa": "NASA", "usgs": "U.S. Geological Survey"}


def _iso(h):
    from elementml.bandit.supa import hours_to_iso
    return hours_to_iso(h)


def _parity_fixture(rng):
    cats = ["tech", "world", "markets", "economy", "science", "policy"]
    heads = ["AI chips lift Nvidia", "Storm hits coast", "Stocks rally on Wall Street", "Jobs report shows hiring",
             "NASA rocket launch", "Fed holds interest rates", "Inflation cools, CPI slows", "Oil prices fall"]
    user = str(uuid.UUID(int=int(rng.integers(1, 2**62))))
    cards = []
    for i in range(36):
        kind = "data" if i % 9 == 4 else "summary"
        cat = cats[i % len(cats)]
        src = None if kind == "data" or i % 7 == 3 else list(SOURCE_NAMES)[i % 5]
        t = NOW - float(rng.uniform(0.5, 400))
        cards.append(dict(id=str(uuid.UUID(int=10**6 + i)), kind=kind, category=cat,
                          event_type=None if i % 5 == 2 else ["earnings", "fed", "macro_release", "deal", "science"][i % 5],
                          headline=heads[i % len(heads)] + f" {i}", body=" ".join(["word"] * int(rng.integers(10, 70))),
                          source_name=SOURCE_NAMES.get(src), series=["CPIAUCSL"] if kind == "data" else [],
                          rank_score=round(t + float(rng.uniform(0, 16)), 6), sort_at=_iso(t), published_at=_iso(t + 0.1),
                          status="hidden" if i == 35 else "published", t=t))
    events = []
    for i in rng.choice(36, 22, replace=False):
        c = cards[int(i)]
        t = min(c["t"] + float(rng.uniform(0.2, 30)), NOW - 0.01)
        events.append(dict(blurb_id=c["id"], kind="view", dwell_ms=None, created_at=_iso(t), slot=int(rng.integers(0, 25))))
        k = rng.random()
        if k < 0.3:
            events.append(dict(blurb_id=c["id"], kind="like", dwell_ms=None, created_at=_iso(t + 0.001), slot=None))
        elif k < 0.4:
            events.append(dict(blurb_id=c["id"], kind="dislike", dwell_ms=None, created_at=_iso(t + 0.001), slot=None))
        elif k < 0.55:
            events.append(dict(blurb_id=c["id"], kind="open_detail", dwell_ms=None, created_at=_iso(t + 0.001), slot=None))
        if rng.random() < 0.7:
            ms = float(rng.choice([700, 1400, 5000, 7500, 9000, 200000]))
            events.append(dict(blurb_id=c["id"], kind="dwell", dwell_ms=int(ms), created_at=_iso(t + 0.002), slot=None))
    events.append(dict(blurb_id=cards[0]["id"], kind="like", dwell_ms=None, created_at=_iso(NOW + 1), slot=None))  # after as of
    model = Model(mu0={"c:tech": 0.21, "c:world": -0.05, "g:rates": 0.1, "t:earnings": 0.07, "s:sec": 0.02},
                  n_readers={"c:tech": 25, "c:world": 30, "g:rates": 22, "t:earnings": 40, "s:sec": 21},
                  lam={"c": 3.0, "g": 8.0, "t": 5.0, "s": 13.0}, tau=0.42, prop={0: 1.0, 1: 0.8, 5: 0.6, 20: 0.25})
    rows = model.rows() + [{"kind": "feature", "key": "c:safety", "value": 0.9, "n_readers": 3}]   # under the floor: skipped
    return dict(user=user, asof=_iso(NOW), seed=int(rng.integers(1, 2**31 - 1)),
                prefs=dict(followed=["science"], hidden_categories=["policy"], hidden_sources=[]),
                cards=cards, events=events, model_rows=rows, params={}, normal_features=["c:tech", "g:rates", "s:nasa"]), model


@pytest.mark.parametrize("variant", ["follows", "cold", "hidden_source", "unslotted"])
def test_pglite_parity(variant, tmp_path):
    pj = os.environ.get("PGLITE_PACKAGE_JSON")
    if not pj or not shutil.which("node"):
        if os.environ.get("REQUIRE_PGLITE"):
            pytest.fail("REQUIRE_PGLITE is set but PGLITE_PACKAGE_JSON or node is missing")
        pytest.skip("PGLITE_PACKAGE_JSON not set or node missing: SQL parity not run")
    from elementml.bandit.supa import iso_to_hours
    rng = np.random.default_rng({"follows": 11, "cold": 12, "hidden_source": 13, "unslotted": 14}[variant])
    fx, model = _parity_fixture(rng)
    if variant == "cold":
        fx["prefs"]["followed"] = []
        fx["events"] = [e for e in fx["events"] if e["kind"] != "like"][:3]
    if variant == "hidden_source":
        fx["prefs"]["hidden_sources"] = ["sec"]
    if variant == "unslotted":                         # views with no slot, and likes with no view at all
        for e in fx["events"][::2]:
            e["slot"] = None
        fx["events"] = [e for e in fx["events"] if not (e["kind"] == "view" and e["blurb_id"] in
                                                        {x["blurb_id"] for x in fx["events"] if x["kind"] == "like"}
                                                        and int(e["blurb_id"][-1], 16) % 2 == 0)]
        fx["events"].append(dict(blurb_id=fx["cards"][7]["id"], kind="like", dwell_ms=None,
                                 created_at=_iso(NOW - 3), slot=None))
    (tmp_path / "fx.json").write_text(json.dumps(fx), encoding="utf-8")
    run = subprocess.run(["node", str(ML / "tests" / "pglite_parity.mjs"), str(REPO), str(tmp_path / "fx.json")],
                         capture_output=True, text=True, timeout=600)
    assert run.returncode == 0, run.stderr[-2000:]
    sql = json.loads(run.stdout)
    assert sql["written"] == len(model.rows())                                           # the under-floor row was refused
    assert [tuple(r.values()) for r in sql["tag_rules"]] == FT.TAG_RULES
    db = {c["id"]: c for c in sql["cards"]}
    for c in fx["cards"]:                                                                # same tags as Python
        py = FT.card_features(c["category"], c["event_type"] or c["kind"], db[c["id"]]["skey"], c["headline"], c["series"])
        assert sorted(db[c["id"]]["features"]) == py, c["headline"]
    for r in sql["normals"]:
        assert r["z"] == pytest.approx(normal_draw(fx["user"], r["f"], fx["seed"]), abs=1e-12)
    assert sql["holdout"] == (100 * holdout_u(fx["user"]) < P["v2_holdout_pct"])
    refs = [RefCard(id=c["id"], category=c["category"], typ=c["event_type"] or c["kind"], skey=db[c["id"]]["skey"],
                    headline=c["headline"], series=tuple(c["series"]), rank_score=c["rank_score"],
                    sort_at=iso_to_hours(c["sort_at"]), published_at=iso_to_hours(c["published_at"]),
                    words=db[c["id"]]["word_count"], status=c["status"]) for c in fx["cards"]]
    evs = [Event(e["blurb_id"], e["kind"], e["dwell_ms"], iso_to_hours(e["created_at"]), e["slot"]) for e in fx["events"]]
    py = score_reference(fx["user"], refs, evs, fx["prefs"]["followed"], fx["prefs"]["hidden_categories"],
                         fx["prefs"]["hidden_sources"], model, P, iso_to_hours(fx["asof"]), fx["seed"])
    assert len(sql["scores"]) == len(py) > 10
    for a, b in zip(sql["scores"], py):
        assert a["id"] == b.id
        assert a["bandit"] == pytest.approx(b.bandit, abs=2e-6)
        assert a["s0"] == pytest.approx(b.s0, abs=2e-5)
        assert a["ps"] == pytest.approx(b.ps, abs=2e-5)
    assert any(abs(b.bandit) > 0.5 for b in py)                                          # the personal term is not trivially 0


# ---- the weekly job on an offline data folder ------------------------------------------------------------
def test_job_steps_offline(tmp_path, capsys, monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    from elementml.bandit import job
    from elementml.bandit.supa import Supa, SupaError, hours_to_iso
    rng = np.random.default_rng(5)
    cs, ev = _population(30, rng)
    flat = [(u, e) for u, es in ev.items() for e in es]
    events = [{"id": k, "user_id": u, "blurb_id": e.card, "kind": e.kind, "dwell_ms": e.ms, "created_at": hours_to_iso(e.t),
               "page_id": None, "slot": e.slot, "surface": "for_you" if e.slot is not None else None}
              for k, (u, e) in enumerate(flat)]
    cards = [{"id": c.id, "category": c.category, "typ": c.typ, "skey": c.skey, "features": c.features, "word_count": c.words,
              "rank_score": c.rank_score, "sort_at": hours_to_iso(c.sort_at), "published_at": hours_to_iso(c.published_at)} for c in cs]
    files = {"events": events, "pages": [], "prefs": [{"user_id": "u000", "followed_categories": ["tech"]}], "cards": cards,
             "params": dict(DEFAULTS), "meta": {"asof": hours_to_iso(NOW)}}
    for k, v in files.items():
        (tmp_path / f"{k}.json").write_text(json.dumps(v), encoding="utf-8")
    rep = job.train(tmp_path)
    assert rep["readers"] == 30 and rep["features"] >= 2
    synth = tmp_path / "synthetic.json"
    synth.write_text(json.dumps({"runs": _runs("normal") + _runs("stress") + _runs("wild")}), encoding="utf-8")
    g = job.gate(tmp_path, synth)
    assert g["synthetic"]["passed"] and not g["replay"]["passed"] and g["gate_passed"] is False   # no real pages yet
    printed = capsys.readouterr().out
    assert "u000" not in printed and "00000000-0000" not in printed                                # counts only, no ids
    with pytest.raises(SupaError):
        Supa(url="", key="")
    assert "secret" not in repr(Supa(url="https://example.invalid", key="secret"))
