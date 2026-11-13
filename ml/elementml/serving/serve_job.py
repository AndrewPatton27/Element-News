"""Serve job: turn the vector + LightGBM model's view of each reader into per-card hours for the For you feed.

What it does: for every reader with enough explicit events, replay their history into a `UserState`, score every
recent card with the heads, and convert the model's utility into HOURS: the card's utility minus the reader's median
utility, divided by the spread, times `scale`, clipped to +-`cap`. Only the strongest `top_pos` positive and `top_neg`
negative cards per reader are kept (the rest are 0), which bounds the table. One batch is written with
`api.ml_write_serve_hours`; `core.v3_scores` (the For you formula) adds the hours when `ml_serve_pct` > 0
(see supabase/migrations/20261211000000_ml_serve_hours.sql). With `ml_serve_pct` = 0 the rows are never read.

Why hours: the formula's score is in hours of freshness (a card that is 8 h older ranks like half the importance), so a
+3 h hour term moves a card up roughly like 3 hours of freshness. The cap keeps the model a nudge on top of the formula,
never able to override importance, follows or dislikes (the formula's own personal term goes up to 30 h).

Run (service-role key in the environment, never in a file):
  python -m elementml.cli serve-run --model models/real_prod [--dry-run] [--scale 1.5] [--cap 6]
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

import numpy as np

from .. import features as F
from ..bandit.supa import Supa, iso_to_hours
from ..data.cards import Card
from ..data.catalog import Catalog
from ..features.uservec import UserState, make_prior
from ..ranking.utility import utility
from .shadow_job import Model, _observe_events, build_cards

EXPLICIT = {"like", "dislike", "open_detail", "open_source"}    # what core.v3_scores counts against ml_serve_min_events
WRITE_CHUNK = 5000                                               # rows per api.ml_write_serve_hours call (accepts 20000)
MIN_SPREAD = 1e-6                                                # a reader whose utilities are all equal gets no hours
MIN_HOURS = 0.05                                                 # smaller hours are dropped (they would not change an order)


def compute_hours(events: list[dict], prefs: list[dict], cards: list[Card], model: Model, now: datetime,
                  scale: float = 1.5, cap: float = 6.0, min_events: int = 5, active_days: float = 7.0,
                  top_pos: int = 150, top_neg: int = 50, max_readers: int = 2000) -> tuple[list[dict], dict]:
    """Rows [{user_id, blurb_id, hours}] for every eligible reader, plus a summary. Pure: no network."""
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    now_iso = iso(now)
    now_h = iso_to_hours(now_iso)
    cat = Catalog.build(cards, model.embedder)
    follows = {p["user_id"]: [c for c in (p.get("followed_categories") or []) if c in model.embedder.centroids] for p in prefs}
    ev_by = defaultdict(list)
    for e in events:
        if e["created_at"] < now_iso:
            ev_by[e["user_id"]].append(e)
    recent_cut = iso(now - timedelta(days=active_days))
    eligible = []
    for uid, evs in ev_by.items():
        n_explicit = sum(1 for e in evs if e["kind"] in EXPLICIT)
        last = max(e["created_at"] for e in evs)
        if n_explicit >= min_events and last >= recent_cut:
            eligible.append((last, uid))
    eligible = [u for _, u in sorted(eligible, reverse=True)[:max_readers]]
    rows, flat, skipped = [], 0, 0
    if cat.n == 0:
        return rows, {"readers": 0, "eligible": len(eligible), "rows": 0, "flat": 0, "cards": 0}
    idx = np.arange(cat.n)
    for uid in eligible:
        evs = sorted(ev_by[uid], key=lambda e: (e["created_at"], e["id"]))
        fl = follows.get(uid, [])
        state = UserState(uid, model.embedder.k, follows=fl, prior=make_prior(model.embedder, fl),
                          now=iso_to_hours(evs[0]["created_at"]) - 1.0)
        _observe_events(state, cat, evs)
        X = F.build(state, cat, idx, now_h, None, state.affinity(now_h), position=0.0)
        u = utility(model.heads.predict(X), X[:, F.NAMES.index("base_rel")])
        seen = {e["blurb_id"] for e in evs}                  # cards the reader already met: the formula handles them (seen penalty / exclusion)
        fresh = np.array([cat.cards[i].id not in seen for i in idx])
        u = np.where(np.isfinite(u), u, np.nanmedian(u) if np.isfinite(u).any() else 0.0)
        if fresh.sum() < 2:
            flat += 1
            continue
        sd = float(np.std(u[fresh]))
        if sd < MIN_SPREAD:
            flat += 1
            continue
        h = np.clip(scale * (u - np.median(u[fresh])) / sd, -cap, cap)
        h[~fresh] = 0.0
        order = np.argsort(-h, kind="stable")
        keep = [int(i) for i in order[:top_pos] if h[i] >= MIN_HOURS] + [int(i) for i in order[::-1][:top_neg] if h[i] <= -MIN_HOURS]
        for i in keep:
            rows.append({"user_id": uid, "blurb_id": cat.cards[i].id, "hours": round(float(h[i]), 3)})
    return rows, {"readers": len({r["user_id"] for r in rows}), "eligible": len(eligible), "rows": len(rows), "flat": flat,
                  "cards": cat.n, "skipped": skipped}


def run(src: Supa, model: Model, scale: float = 1.5, cap: float = 6.0, min_events: int = 5, history_days: float = 30.0,
        dry_run: bool = False, now: Optional[datetime] = None, log=print, **kw) -> dict:
    """Export, compute, write one batch (stamped `now`)."""
    now = now or datetime.now(timezone.utc)
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    since = iso(now - timedelta(days=history_days))
    events = src.export("events", since)
    prefs = src.export("prefs", "1970-01-01T00:00:00Z")
    meta = src.export_cards(since)
    text = {r["id"]: r for r in src.export_card_text(since)}
    cards = build_cards(meta, text)
    log(f"events: {len(events)}, readers with prefs: {len(prefs)}, cards: {len(cards)}")
    rows, summary = compute_hours(events, prefs, cards, model, now, scale=scale, cap=cap, min_events=min_events, **kw)
    summary["written"] = summary["skipped_rows"] = 0
    if dry_run or not rows:
        log(f"dry run or nothing to write: {summary}")
        return summary
    for i in range(0, len(rows), WRITE_CHUNK):
        r = src.write_serve_hours(iso(now), model.version, rows[i:i + WRITE_CHUNK])
        summary["written"] += int(r.get("written", 0)); summary["skipped_rows"] += int(r.get("skipped", 0))
    log(f"done: {summary}")
    return summary
