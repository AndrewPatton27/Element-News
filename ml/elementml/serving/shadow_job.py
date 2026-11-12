"""Shadow replay job: what would the vector + LightGBM ranker have done with the pages readers were served?

Input: the logged For you pages, the readers' events and follows (api.ml_export), the cards (api.ml_export_cards for
tags and numbers, api.ml_export_card_text for headline and body) and a saved model folder (embedder.pkl + heads).
Output: one row per page for `api.ml_write_shadow` (core.ml_shadow): the model's rank, utility and head
predictions for the SAME cards the reader was shown. Readers never see these rows and no feed reads them: the
feed is still ranked by the SQL formula. This is the evidence step before any mode that changes a feed.

How: each reader's earlier events are replayed in time order into a `UserState` (so the state at a page is a pure
function of what happened before it), the page's cards are turned into the stage-2 feature matrix, the heads
predict, `utility` combines them. Position is held at 0, as when serving. No crowd tables (a cross-reader signal
that needs 3 or more people); no simulator code is imported.

`why` codes (smallint per card): 0 = fresh and important, 1 = a topic the reader follows or engages with,
2 = similar to cards the reader liked.

Run (service-role key in the environment, never in a file):
  python -m elementml.cli shadow-run --model models/real_dev [--hours 48] [--dry-run]
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Optional

import numpy as np

from .. import config as C
from .. import features as F
from ..bandit.supa import Supa, iso_to_hours
from ..data.cards import Card
from ..data.catalog import Catalog
from ..features.embed import Embedder
from ..features.uservec import UserState, make_prior
from ..ranking.heads import Heads
from ..ranking.utility import utility

COLD_EVENTS = 5.0               # foryou_cold_events: conf = n_strong / (n_strong + 5)
TOP_IDS = 10                    # ml_top_ids length (the model's ten best cards of the page)
WRITE_CHUNK = 500               # rows per api.ml_write_shadow call (the function accepts 5000)
LIKE_SIMILAR = 0.6              # max cosine to a liked card that earns the "similar to what you liked" code
EVENT_KINDS = {"view", "dwell", "like", "dislike", "open_detail", "open_source"}   # "clear" carries no state
WHY_FRESH, WHY_TOPIC, WHY_SIMILAR = 0, 1, 2


@dataclass
class Model:
    """A saved model folder: the fitted embedder, the trained heads and a version string for core.ml_shadow."""
    embedder: Embedder
    heads: Heads
    version: str

    @staticmethod
    def load(folder: Path, tag: str = "full") -> "Model":
        folder = Path(folder)
        return Model(Embedder.load(folder / "embedder.pkl"), Heads.load(folder, tag), f"vecgbt:{folder.name}:{tag}")


# ---- cards ---------------------------------------------------------------------------------------------------
def build_cards(meta: Iterable[dict], text: dict[str, dict]) -> list[Card]:
    """Contract Cards from api.ml_export_cards rows + api.ml_export_card_text rows.
    importance is recovered from rank_score = sort_at_hours + 8 * log2(importance) (it is not exported)."""
    cards = []
    for m in meta:
        t = text.get(m["id"])
        if t is None:
            continue                                            # no text: cannot be embedded, page is skipped later
        sort_at = iso_to_hours(m["sort_at"])
        imp = 2.0 ** ((float(m["rank_score"]) - sort_at) / C.HALF_LIFE_H)
        typ = m.get("typ")
        skey = m.get("skey")
        cards.append(Card(
            id=m["id"], kind="data" if skey == "fred" else "summary", headline=t.get("headline") or "", body=t.get("body") or "",
            category=m["category"], event_type=typ if typ in C.EVENT_TYPES else None,
            source=skey if skey in C.SOURCES else None, importance=max(imp, 1.0), source_count=1,
            sort_at=sort_at, published_at=iso_to_hours(m["published_at"]), word_count=int(m.get("word_count") or 0)))
    return cards


# ---- replay and scoring ---------------------------------------------------------------------------------------
def _why(X: np.ndarray) -> np.ndarray:
    cols = {n: X[:, F.NAMES.index(n)] for n in ("followed", "cat_aff", "max_cos_liked")}
    code = np.full(len(X), WHY_FRESH, dtype=int)
    code[(cols["followed"] > 0) | (cols["cat_aff"] > 0.5)] = WHY_TOPIC
    code[cols["max_cos_liked"] >= LIKE_SIMILAR] = WHY_SIMILAR
    return code


def _observe_events(state: UserState, cat: Catalog, events: list[dict]) -> None:
    """Feed a time-ordered list of one reader's events into the state: consecutive events of one card on one page
    are one observation."""
    i = 0
    while i < len(events):
        e = events[i]
        j = i
        while j + 1 < len(events) and events[j + 1]["blurb_id"] == e["blurb_id"] and events[j + 1].get("page_id") == e.get("page_id"):
            j += 1
        grp = [x for x in events[i:j + 1] if x["kind"] in EVENT_KINDS]
        idx = cat.index.get(e["blurb_id"])
        if grp and idx is not None:
            ev = [(x["kind"], float(x["dwell_ms"]) if x.get("dwell_ms") is not None else None) for x in grp]
            state.observe(cat.cards[idx], cat.emb[idx], ev, iso_to_hours(grp[-1]["created_at"]))
        i = j + 1


def score_pages(pages: list[dict], events: list[dict], prefs: list[dict], cards: list[Card], model: Model) -> tuple[list[dict], dict]:
    """Shadow rows for the For you pages (api.ml_write_shadow format) and a small count summary."""
    cat = Catalog.build(cards, model.embedder)
    follows = {p["user_id"]: [c for c in (p.get("followed_categories") or []) if c in model.embedder.centroids] for p in prefs}
    ev_by = defaultdict(list)
    for e in events:
        ev_by[e["user_id"]].append(e)
    pg_by = defaultdict(list)
    for p in pages:
        if p.get("surface") == "for_you":
            pg_by[p["user_id"]].append(p)
    rows, skipped_unknown_card = [], 0
    for uid, upages in pg_by.items():
        fl = follows.get(uid, [])
        upages = sorted(upages, key=lambda p: (p["shown_at"], p["page_id"]))
        uev = sorted(ev_by.get(uid, []), key=lambda e: (e["created_at"], e["id"]))
        state = UserState(uid, model.embedder.k, follows=fl, prior=make_prior(model.embedder, fl),
                          now=iso_to_hours(min(upages[0]["shown_at"], uev[0]["created_at"] if uev else upages[0]["shown_at"])) - 1.0)
        done = 0
        for p in upages:
            t_iso = p["shown_at"]
            upto = done
            while upto < len(uev) and uev[upto]["created_at"] < t_iso:
                upto += 1
            _observe_events(state, cat, uev[done:upto])
            done = upto
            if any(c not in cat.index for c in p["card_ids"]):
                skipped_unknown_card += 1
                continue
            now = iso_to_hours(t_iso)
            idx = cat.rows_of(p["card_ids"])
            X = F.build(state, cat, idx, now, None, state.affinity(now), position=0.0)
            pred = model.heads.predict(X)
            u = utility(pred, X[:, F.NAMES.index("base_rel")])
            rank = np.argsort(np.argsort(-u, kind="stable"), kind="stable")
            top = np.argsort(-u, kind="stable")[:min(TOP_IDS, len(u))]
            fin = lambda a: [float(x) if math.isfinite(float(x)) else 0.0 for x in a]
            rows.append({
                "page_id": p["page_id"], "model_version": model.version, "ml_rank": [int(r) for r in rank],
                "utility": fin(u), "p_like": fin(pred["like"]), "p_dislike": fin(pred["dislike"]), "p_detail": fin(pred["detail"]),
                "completion": fin(np.clip(pred["time"], 0.0, C.COMPLETION_CAP)),
                "conf": float(state.n_strong / (state.n_strong + COLD_EVENTS)),
                "why": [int(w) for w in _why(X)], "ml_top_ids": [p["card_ids"][int(k)] for k in top]})
    return rows, {"pages_scored": len(rows), "pages_skipped_unknown_card": skipped_unknown_card, "readers": len(pg_by)}


# ---- the job ---------------------------------------------------------------------------------------------------
def run(src: Supa, model: Model, hours: float = 48.0, history_days: float = 30.0, dry_run: bool = False,
        now: Optional[datetime] = None, log=print) -> dict:
    """Export, score, write. Pages of the last `hours`; reader history of the last `history_days` (the v3 evidence window)."""
    now = now or datetime.now(timezone.utc)
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    pages = src.export("pages", iso(now - timedelta(hours=hours)))
    pages = [p for p in pages if p.get("surface") == "for_you"]
    log(f"pages: {len(pages)}")
    if not pages:
        return {"pages_scored": 0, "written": 0, "skipped": 0}
    since = iso(now - timedelta(days=history_days))
    events = src.export("events", since)
    prefs = src.export("prefs", "1970-01-01T00:00:00Z")
    meta = src.export_cards(iso(now - timedelta(days=history_days + 4)))
    text = {r["id"]: r for r in src.export_card_text(iso(now - timedelta(days=history_days + 4)))}
    cards = build_cards(meta, text)
    log(f"events: {len(events)}, readers with prefs: {len(prefs)}, cards: {len(cards)}")
    rows, summary = score_pages(pages, events, prefs, cards, model)
    summary["written"] = summary["skipped"] = 0
    if dry_run or not rows:
        log(f"dry run: {summary}")
        return summary
    run_id = src.begin_run("shadow", model.version, {"hours": hours, "history_days": history_days, "pages": len(rows)})
    try:
        for i in range(0, len(rows), WRITE_CHUNK):
            r = src.write_shadow(rows[i:i + WRITE_CHUNK])
            summary["written"] += int(r.get("written", 0)); summary["skipped"] += int(r.get("skipped", 0))
        src.finish_run(run_id, "ok", summary["readers"], len(rows))
    except Exception:
        src.finish_run(run_id, "failed", summary["readers"], len(rows))
        raise
    log(f"done: {summary}")
    return summary
