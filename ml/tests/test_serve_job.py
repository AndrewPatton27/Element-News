"""Serve job: hours rows (shape, cap, eligibility, bounds, determinism), write path and dry run (offline, fake client)."""
from datetime import datetime, timedelta, timezone

import pytest

from elementml.serving import serve_job as V
from elementml.serving import shadow_job as S

from test_shadow_job import T0, CATS, ISO, model  # noqa: F401  (fixtures: the trained toy model + cards)

NOW = T0 + timedelta(hours=1)


def _events(uid, cards, n=8, kinds=("view", "like"), last_minutes=30):
    ev, k = [], 0
    for i, cid in enumerate(cards[:n]):
        for kind in kinds:
            k += 1
            ev.append({"id": k, "user_id": uid, "blurb_id": cid, "kind": kind, "dwell_ms": None,
                       "created_at": ISO(NOW - timedelta(minutes=last_minutes + n - i)), "page_id": f"p{uid}", "slot": i, "surface": "for_you"})
    return ev


def _cards_of(model, cat):
    _, meta, text = model
    return [m["id"] for m in meta if m["category"] == cat]


def _compute(model, events, prefs=(), **kw):
    m, meta, text = model
    return V.compute_hours(events, list(prefs), S.build_cards(meta, text), m, NOW, **kw)


def test_rows_shape_cap_and_bounds(model):
    rows, summary = _compute(model, _events("u1", _cards_of(model, "markets")), cap=4.0, top_pos=10, top_neg=5)
    assert rows and summary["readers"] == 1 and summary["eligible"] == 1
    assert all(set(r) == {"user_id", "blurb_id", "hours"} for r in rows)
    assert all(abs(r["hours"]) <= 4.0 + 1e-9 and abs(r["hours"]) >= V.MIN_HOURS for r in rows)
    assert sum(r["hours"] > 0 for r in rows) <= 10 and sum(r["hours"] < 0 for r in rows) <= 5
    assert len({r["blurb_id"] for r in rows}) == len(rows)                     # one row per card
    known = {m["id"] for m in model[1]}
    assert {r["blurb_id"] for r in rows} <= known


def test_liked_category_gets_more_hours_than_others(model):
    rows, _ = _compute(model, _events("u1", _cards_of(model, "markets")))
    cat_of = {m["id"]: m["category"] for m in model[1]}
    mean = lambda c: sum(r["hours"] for r in rows if cat_of[r["blurb_id"]] == c) / max(1, sum(cat_of[r["blurb_id"]] == c for r in rows))
    others = [mean(c) for c in CATS if c != "markets" and any(cat_of[r["blurb_id"]] == c for r in rows)]
    assert mean("markets") > max(others)                                       # a reader who likes markets is pushed toward markets


def test_seen_cards_get_no_row(model):
    liked = _cards_of(model, "markets")[:8]
    rows, _ = _compute(model, _events("u1", liked))
    assert not ({r["blurb_id"] for r in rows} & set(liked))


def test_deterministic_and_reader_independent(model):
    ev1 = _events("u1", _cards_of(model, "markets"))
    ev2 = _events("u2", _cards_of(model, "policy"))
    a, _ = _compute(model, ev1 + ev2)
    b, _ = _compute(model, ev2 + ev1)
    assert sorted(a, key=lambda r: (r["user_id"], r["blurb_id"])) == sorted(b, key=lambda r: (r["user_id"], r["blurb_id"]))
    alone, _ = _compute(model, ev1)
    assert [r for r in a if r["user_id"] == "u1"] == alone                     # reader u1 does not depend on reader u2


def test_eligibility(model):
    few = _events("few", _cards_of(model, "markets"), n=3)                      # 3 likes < 5 explicit events
    old = _events("old", _cards_of(model, "markets"), last_minutes=60 * 24 * 10)  # last event 10 days ago > 7
    viewer = _events("viewer", _cards_of(model, "markets"), kinds=("view",))   # views only: no explicit events
    rows, summary = _compute(model, few + old + viewer)
    assert rows == [] and summary["eligible"] == 0
    rows, summary = _compute(model, few, min_events=3)
    assert summary["eligible"] == 1


def test_future_events_ignored(model):
    base = _events("u1", _cards_of(model, "markets"))
    later = [dict(e, id=1000 + e["id"], created_at=ISO(NOW + timedelta(minutes=5))) for e in base]
    a, _ = _compute(model, base)
    b, _ = _compute(model, base + later)
    assert a == b


def test_max_readers_keeps_the_most_recent(model):
    ev = _events("a", _cards_of(model, "markets"), last_minutes=200) + _events("b", _cards_of(model, "policy"), last_minutes=20)
    rows, summary = _compute(model, ev, max_readers=1)
    assert {r["user_id"] for r in rows} == {"b"} and summary["eligible"] == 1


class FakeSupa:
    def __init__(self, model, events):
        _, self.meta, self.text = model
        self.events, self.writes = events, []

    def export(self, what, since): return {"events": self.events, "prefs": []}[what]
    def export_cards(self, since): return self.meta
    def export_card_text(self, since): return list(self.text.values())

    def write_serve_hours(self, batch_at, version, rows):
        self.writes.append((batch_at, version, rows)); return {"written": len(rows), "skipped": 0}


def test_run_dry_writes_nothing(model):
    src = FakeSupa(model, _events("u1", _cards_of(model, "markets")))
    out = V.run(src, model[0], dry_run=True, now=NOW, log=lambda *_: None)
    assert out["rows"] > 0 and src.writes == []


def test_run_writes_in_chunks_stamped_with_now(model, monkeypatch):
    monkeypatch.setattr(V, "WRITE_CHUNK", 7)
    src = FakeSupa(model, _events("u1", _cards_of(model, "markets")))
    out = V.run(src, model[0], now=NOW, log=lambda *_: None)
    assert out["written"] == out["rows"] and all(len(w[2]) <= 7 for w in src.writes) and len(src.writes) > 1
    assert {w[0] for w in src.writes} == {ISO(NOW)} and {w[1] for w in src.writes} == {"test:v1"}


def test_nothing_eligible_writes_nothing(model):
    src = FakeSupa(model, [])
    out = V.run(src, model[0], now=NOW, log=lambda *_: None)
    assert out["rows"] == 0 and src.writes == []
