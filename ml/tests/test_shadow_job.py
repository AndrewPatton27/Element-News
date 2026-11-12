"""Shadow replay job: row shape, no future leakage, state matters, write / dry-run / failure paths (all offline, fake client)."""
import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from elementml import config as C
from elementml import features as F
from elementml.bandit.supa import iso_to_hours
from elementml.data.cards import Card
from elementml.data.catalog import Catalog
from elementml.features.embed import Embedder
from elementml.features.uservec import UserState
from elementml.ranking.heads import Heads, train_heads
from elementml.serving import shadow_job as S

T0 = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
ISO = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
CATS = ["markets", "earnings", "economy", "policy", "deals", "safety"]


def _cards(n=60):
    out = []
    for i in range(n):
        out.append({"id": f"00000000-0000-0000-0000-{i:012d}", "category": CATS[i % len(CATS)], "typ": "earnings" if i % 3 == 0 else "summary",
                    "skey": "sec" if i % 4 == 0 else None, "word_count": 40 + i % 30, "sort_at": ISO(T0 - timedelta(hours=i % 40)),
                    "published_at": ISO(T0 - timedelta(hours=i % 40)),
                    "headline": f"{CATS[i % len(CATS)]} story {i} about topic{i % 7}", "body": f"body text {i} word{i % 5} {CATS[i % len(CATS)]}"})
    meta = [{k: v for k, v in m.items() if k not in ("headline", "body")} for m in out]
    for m in meta:
        m["rank_score"] = iso_to_hours(m["sort_at"]) + C.HALF_LIFE_H * math.log2(1.0 + (int(m["id"][-3:]) % 5))
    text = {m["id"]: {"id": m["id"], "headline": o["headline"], "body": o["body"]} for m, o in zip(meta, out)}
    return meta, text


@pytest.fixture(scope="module")
def model():
    meta, text = _cards()
    cards = S.build_cards(meta, text)
    emb = Embedder().fit(cards)
    cat = Catalog.build(cards, emb)
    rng = np.random.default_rng(0)
    rows, ys = [], {"like": [], "dislike": [], "detail": [], "comp": [], "comp_ok": []}
    now_h = iso_to_hours(ISO(T0))
    for r in range(60):
        st = UserState(f"u{r}", emb.k, now=now_h - 5)
        fav = CATS[r % len(CATS)]
        seen = [i for i in range(cat.n) if cat.cards[i].category == fav][:5]
        for k, i in enumerate(seen):                                 # the reader likes one category, so state carries signal
            st.observe(cat.cards[i], cat.emb[i], [("view", None), ("like", None)], now_h - 4 + 0.1 * k)
        idx = np.array([i for i in range(cat.n) if i not in seen][:24])
        X = F.build(st, cat, idx, now_h, None, st.affinity(now_h), position=np.arange(len(idx)))
        rows.append(X)
        ys["like"] += [float(cat.cards[i].category == fav and rng.random() < 0.8) for i in idx]
        ys["dislike"] += list((rng.random(len(idx)) < 0.1).astype(float))
        ys["detail"] += list((rng.random(len(idx)) < 0.05).astype(float)); ys["comp"] += list(rng.random(len(idx)))   # noqa
        ys["comp_ok"] += [True] * len(idx)
    X = np.vstack(rows)
    y = {k: np.array(v, dtype=float if k != "comp_ok" else bool) for k, v in ys.items()}
    saved = dict(C.LGB_ROUNDS)
    C.LGB_ROUNDS.update({k: 40 for k in saved})
    try:
        heads = train_heads(X, y, F.names_without("crowd"))
    finally:
        C.LGB_ROUNDS.update(saved)
    return S.Model(emb, heads, "test:v1"), meta, text


def _page(i, user="u1", n=12, shown=T0):
    ids = [f"00000000-0000-0000-0000-{(i * 3 + k):012d}" for k in range(n)]
    return {"page_id": f"11111111-0000-0000-0000-{i:012d}", "user_id": user, "surface": "for_you", "shown_at": ISO(shown), "card_ids": ids}


def _score(model, pages, events, prefs=()):
    m, meta, text = model
    return S.score_pages(pages, events, list(prefs), S.build_cards(meta, text), m)


def test_row_shape_and_validity(model):
    rows, summary = _score(model, [_page(1)], [])
    r = rows[0]
    n = 12
    assert summary["pages_scored"] == 1 and len(rows) == 1
    for k in ("ml_rank", "utility", "p_like", "p_dislike", "p_detail", "completion", "why"):
        assert len(r[k]) == n, k
    assert sorted(r["ml_rank"]) == list(range(n))                       # a permutation, 0 = best
    assert all(math.isfinite(x) for k in ("utility", "p_like", "p_dislike", "p_detail", "completion") for x in r[k])
    assert all(0.0 <= p <= 1.0 for p in r["p_like"] + r["p_dislike"] + r["p_detail"])
    assert 0.0 <= r["conf"] <= 1.0 and set(r["why"]) <= {0, 1, 2}
    assert len(r["ml_top_ids"]) == min(S.TOP_IDS, n) and set(r["ml_top_ids"]) <= set(_page(1)["card_ids"])
    assert r["ml_top_ids"][0] == _page(1)["card_ids"][int(np.argmin(r["ml_rank"]))]


def test_deterministic(model):
    a, _ = _score(model, [_page(1)], [])
    b, _ = _score(model, [_page(1)], [])
    assert a == b


def test_future_events_do_not_leak(model):
    ids = _page(9)["card_ids"]
    later = [{"id": 1, "user_id": "u1", "blurb_id": ids[0], "kind": "like", "dwell_ms": None, "created_at": ISO(T0 + timedelta(minutes=5)), "page_id": "x", "slot": 0, "surface": "for_you"}]
    a, _ = _score(model, [_page(1)], [])
    b, _ = _score(model, [_page(1)], later)
    assert a == b                                                        # an event AFTER the page never changes its row


def test_earlier_events_change_the_state(model):
    prior = _page(2, shown=T0 - timedelta(hours=1))
    ev = []
    for k, cid in enumerate(prior["card_ids"][:6]):
        for kind in ("view", "like"):
            ev.append({"id": 10 * k + len(ev), "user_id": "u1", "blurb_id": cid, "kind": kind, "dwell_ms": None,
                       "created_at": ISO(T0 - timedelta(minutes=50 - k)), "page_id": prior["page_id"], "slot": k, "surface": "for_you"})
    a, _ = _score(model, [_page(1)], [])
    b, _ = _score(model, [_page(1)], ev)
    assert a[0]["utility"] != b[0]["utility"] and a[0]["conf"] == 0.0 and b[0]["conf"] > 0.0


def test_unknown_card_page_is_skipped_not_guessed(model):
    p = _page(1)
    p["card_ids"][3] = "99999999-0000-0000-0000-000000000000"
    rows, summary = _score(model, [p], [])
    assert rows == [] and summary["pages_skipped_unknown_card"] == 1


def test_trending_pages_are_ignored(model):
    p = _page(1); p["surface"] = "trending"
    rows, summary = _score(model, [p], [])
    assert rows == [] and summary["readers"] == 0


class FakeSupa:
    def __init__(self, model, fail=False):
        _, self.meta, self.text = model
        self.writes, self.runs, self.fail = [], [], fail

    def export(self, what, since):
        return {"pages": [_page(i, shown=T0 - timedelta(minutes=i)) for i in range(1, 8)], "events": [], "prefs": []}[what]

    def export_cards(self, since): return self.meta
    def export_card_text(self, since): return list(self.text.values())
    def begin_run(self, kind, version, params=None): self.runs.append(["begin", kind, version]); return 7

    def write_shadow(self, rows):
        if self.fail:
            raise RuntimeError("boom")
        self.writes.append(rows); return {"written": len(rows), "skipped": 0}

    def finish_run(self, run, status, n_users, n_rows): self.runs.append(["finish", run, status, n_rows]); return {}


def test_run_dry_writes_nothing(model):
    src = FakeSupa(model)
    out = S.run(src, model[0], dry_run=True, now=T0 + timedelta(hours=1), log=lambda *_: None)
    assert out["pages_scored"] == 7 and src.writes == [] and src.runs == []


def test_run_writes_in_chunks_and_closes_the_run(model, monkeypatch):
    monkeypatch.setattr(S, "WRITE_CHUNK", 3)
    src = FakeSupa(model)
    out = S.run(src, model[0], now=T0 + timedelta(hours=1), log=lambda *_: None)
    assert out["written"] == 7 and [len(w) for w in src.writes] == [3, 3, 1]
    assert src.runs[0][:2] == ["begin", "shadow"] and src.runs[-1][2] == "ok"


def test_run_marks_failed_and_reraises(model):
    src = FakeSupa(model, fail=True)
    with pytest.raises(RuntimeError):
        S.run(src, model[0], now=T0 + timedelta(hours=1), log=lambda *_: None)
    assert src.runs[-1][2] == "failed"
