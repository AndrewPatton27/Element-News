"""Weekly training for ranking v2: the population prior (empirical Bayes) and slot propensities.

Input: exported events (core.user_events rows: user, card, kind, dwell ms, time, slot), card features and
word counts, each reader's follows, the training time `asof` and the settings.
Output: a `Model` (fewer than 300 core.ml_weights rows) plus a report of counts and the chosen values.

What is fitted, in plain words:
  * propensity(slot): how much less often a card is acted on at slot s than at slot 0 (engagement rate at s
    divided by the rate at slot 0, never rising with s, kept within 1/cap .. 1). Readers act more on top
    slots partly because those cards are better, so this over-states the position effect a little.
  * mu0_j: the average reward of feature j across readers. Each reader's own average counts with weight
    min(their evidence, v2_reader_weight_cap), so no single heavy reader sets a population number, and a
    feature needs at least v2_min_readers readers (else it is left out and the feed uses the hand prior 0).
  * tau: the spread of card rewards (weighted standard deviation), floor 0.05.
  * lambda_g per group (topic, type, source, tag): chosen from a grid by how well beliefs built on all but the
    last 7 days predict the rewards of the last 7 days (Gaussian predictive log-likelihood), one group at a
    time, two passes. With too little held-out data the default stays.
With fewer than v2_min_readers readers in total, the model is the hand prior (no feature rows).
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Iterable

import numpy as np

from . import features as FT
from .params import SLOT_BUCKETS
from .policy import (HOUR_PER_DAY, Event, Model, aggregate, card_reward, fade, lean_tags_from,
                     posterior, propensity_weight)

LAMBDA_GRID = (1.0, 2.0, 3.0, 5.0, 8.0, 13.0, 21.0, 34.0)
VALIDATION_DAYS = 7.0
MIN_VALIDATION_CARDS = 200        # fewer held-out (reader, card) rows than this: keep the default lambdas
TAU_FLOOR = 0.05


def fit_propensity(events_by_user: dict[str, list[Event]], words_of: dict[str, int], asof: float, P: dict) -> tuple[dict[int, float], dict]:
    """slot bucket -> propensity, from view slots and whether the reader acted on that card."""
    n = np.zeros(SLOT_BUCKETS + 1); pos = np.zeros(SLOT_BUCKETS + 1)
    readers = [set() for _ in range(SLOT_BUCKETS + 1)]
    for u, evs in events_by_user.items():
        aggs = aggregate(evs, asof, P, None)
        for cid, a in aggs.items():
            if a.slot is None:
                continue
            b = min(a.slot, SLOT_BUCKETS)
            n[b] += 1
            pos[b] += card_reward(a, words_of.get(cid, 0), P) > 0
            readers[b].add(u)
    cap = P["v2_propensity_cap"]
    minr = P["v2_min_readers"]
    out: dict[int, float] = {}
    if n[0] == 0 or len(readers[0]) < minr or pos[0] == 0:
        return out, {"slot_views": int(n.sum())}
    rate0 = pos[0] / n[0]
    prev = 1.0
    for b in range(SLOT_BUCKETS + 1):
        if len(readers[b]) < minr or n[b] == 0:
            continue                                   # unknown bucket: the feed uses propensity 1 there
        p = min(max((pos[b] / n[b]) / rate0, 1.0 / cap), 1.0)
        p = min(p, prev)                               # never rises with the slot
        out[b] = round(p, 6)
        prev = p
    return out, {"slot_views": int(n.sum()), "slot_rate0": round(float(rate0), 4)}


def _reader_rows(evs: list[Event], feats_of, words_of, model: Model, asof: float, P: dict):
    """(card, features, x, w, r) for each card the reader has events on before asof (30-day window)."""
    aggs = aggregate(evs, asof, P, P["affinity_days"])
    out = []
    for cid, a in aggs.items():
        fs = feats_of.get(cid)
        if not fs:
            continue
        w = fade(asof - a.last_at, P) * propensity_weight(a.slot, model, P)
        out.append((cid, fs, FT.x_of(fs), w, card_reward(a, words_of.get(cid, 0), P)))
    return out


def fit_mu0(rows_by_user: dict[str, list], P: dict) -> tuple[dict[str, float], dict[str, int], float]:
    """Population mean reward per feature (reader-capped weights, privacy floor) and tau."""
    cap, minr = P["v2_reader_weight_cap"], P["v2_min_readers"]
    num: dict[str, float] = defaultdict(float); den: dict[str, float] = defaultdict(float)
    nread: dict[str, int] = defaultdict(int)
    sw = swr = swr2 = 0.0
    for u, rows in rows_by_user.items():
        n_u: dict[str, float] = defaultdict(float); s_u: dict[str, float] = defaultdict(float)
        for _, fs, x, w, r in rows:
            sw += w; swr += w * r; swr2 += w * r * r
            for j in fs:
                n_u[j] += w * x * x
                s_u[j] += w * x * r
        for j, nj in n_u.items():
            if nj <= 0:
                continue
            m = s_u[j] / nj                              # this reader's mean reward per unit of feature j
            cw = min(nj, cap)
            num[j] += cw * m; den[j] += cw; nread[j] += 1
    mu0 = {j: num[j] / den[j] for j in num if nread[j] >= minr and den[j] > 0}
    var = swr2 / sw - (swr / sw) ** 2 if sw > 0 else 0.0
    tau = max(math.sqrt(max(var, 0.0)), TAU_FLOOR) if sw > 0 else None
    return mu0, {j: nread[j] for j in mu0}, tau


def _loglik(model: Model, train_rows, val_rows, follows, P: dict) -> float:
    """Sum of Gaussian predictive log-likelihoods of held-out card rewards (per reader beliefs)."""
    lean = lean_tags_from(P)
    tau = model.tau if model.tau is not None else P["v2_tau_default"]
    tot = 0.0
    for u, vrows in val_rows.items():
        stats = _stats_from_rows(train_rows.get(u, []), follows.get(u, []), P)
        for _, fs, x, _, r in vrows:
            mean = var = 0.0
            for j in fs:
                mu, sg = posterior(j, stats, model, P, lean)
                mean += x * mu
                var += x * x * sg * sg
            var += tau * tau
            tot += -0.5 * (math.log(2 * math.pi * var) + (r - mean) ** 2 / var)
    return tot


def _stats_from_rows(rows, follows, P):
    st: dict[str, list[float]] = {}
    for _, fs, x, w, r in rows:
        for j in fs:
            s = st.setdefault(j, [0.0, 0.0])
            s[0] += w * x * x
            s[1] += w * x * r
    for c in set(follows):
        s = st.setdefault("c:" + c, [0.0, 0.0])
        s[0] += P["v2_follow_pseudo"]
        s[1] += P["v2_follow_pseudo"] * P["v2_follow_reward"]
    return st


def fit(events_by_user: dict[str, list[Event]], feats_of: dict[str, list[str]], words_of: dict[str, int],
        follows: dict[str, list[str]], asof: float, P: dict, version: str = "ts-v2") -> tuple[Model, dict]:
    """The full weekly fit. Returns (model, report). Deterministic for the same input."""
    readers = sorted(u for u, evs in events_by_user.items() if evs)
    report = {"readers": len(readers), "events": int(sum(len(events_by_user[u]) for u in readers))}
    model = Model(version=version)
    if len(readers) < P["v2_min_readers"]:
        report["fallback"] = "hand prior: fewer than v2_min_readers readers"
        return model, report
    model.prop, rp = fit_propensity({u: events_by_user[u] for u in readers}, words_of, asof, P)
    report.update(rp)
    # held-out split: beliefs from events before asof - 7 days, graded on cards first touched after it
    cut = asof - VALIDATION_DAYS * HOUR_PER_DAY
    train_rows, val_rows = {}, {}
    for u in readers:
        evs = events_by_user[u]
        train_rows[u] = _reader_rows(evs, feats_of, words_of, model, cut, P)
        seen_before = {r[0] for r in train_rows[u]}
        late = [e for e in evs if e.t >= cut]
        val_rows[u] = [r for r in _reader_rows(late, feats_of, words_of, model, asof, P) if r[0] not in seen_before]
    mu0_tr, nr_tr, tau_tr = fit_mu0(train_rows, P)
    n_val = sum(len(v) for v in val_rows.values())
    report["validation_cards"] = n_val
    lam = {g: P["v2_lambda_default"] for g in FT.GROUPS}
    if n_val >= MIN_VALIDATION_CARDS and mu0_tr:
        probe = Model(mu0=mu0_tr, n_readers=nr_tr, lam=dict(lam), tau=tau_tr, prop=model.prop)
        for _ in range(2):
            for g in FT.GROUPS:
                best = None
                for v in LAMBDA_GRID:
                    probe.lam[g] = v
                    ll = _loglik(probe, train_rows, val_rows, follows, P)
                    if best is None or ll > best[0] + 1e-9:
                        best = (ll, v)
                probe.lam[g] = best[1]
        lam = dict(probe.lam)
        report["validation_loglik"] = round(_loglik(probe, train_rows, val_rows, follows, P), 3)
    else:
        report["lambda"] = "default (too little held-out data)"
    # final population prior on everything up to asof
    all_rows = {u: _reader_rows(events_by_user[u], feats_of, words_of, model, asof, P) for u in readers}
    model.mu0, model.n_readers, model.tau = fit_mu0(all_rows, P)
    model.lam = lam
    report.update(features=len(model.mu0), lam=lam, tau=None if model.tau is None else round(model.tau, 4),
                  rows=len(model.rows()))
    return model, report


def events_from_export(rows: Iterable[dict], to_hours) -> dict[str, list[Event]]:
    """api.ml_export('events') rows -> events per reader (times converted with to_hours(iso))."""
    out: dict[str, list[Event]] = defaultdict(list)
    for r in rows:
        out[r["user_id"]].append(Event(card=r["blurb_id"], kind=r["kind"], ms=r.get("dwell_ms"),
                                       t=to_hours(r["created_at"]), slot=r.get("slot")))
    return dict(out)
