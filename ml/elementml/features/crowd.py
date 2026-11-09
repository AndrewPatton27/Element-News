"""Crowd tables: a Python mirror of core.refresh_trending (20261017080000_collab.sql).

Input: a CrowdLedger with one record per (reader, card): viewed / liked / detail / source / long look /
disliked flags and the last event time, plus each reader's follows. Output: CrowdTables with, per card,
the Trending buzz + quality boost (hours), distinct readers, smoothed positive rate, card-neighbour links,
and topic lifts per reader group. Why: today's server formula uses these numbers, and the ML ranker
reads them as stage-2 features. Counts only: every number needs >= CROWD_MIN_USERS distinct people.
"""
from __future__ import annotations

import math
from collections import defaultdict

import numpy as np
from scipy import sparse

from .. import config as C
from ..data.catalog import Catalog
from .uservec import long_look_ms

POS_RATE_PRIOR, POS_RATE_PRIOR_VIEWS = 0.15, 2     # pos_rate is smoothed toward 0.15 over 2 pseudo-views
TOPIC_PRIOR_FLOOR = 0.02                           # floor of the per-topic positive rate (quality baseline)

class CrowdLedger:
    """One record per (user, card). Holds only user id, card row, flags and the last event time."""

    def __init__(self, catalog: Catalog):
        self.cat = catalog
        self.rec: dict[tuple[str, int], list] = {}      # [viewed, liked, detail, src, long, dis, last_t]
        self.follows: dict[str, list[str]] = {}

    def add(self, uid: str, row: int, events, now: float) -> None:
        """Record one impression's events for reader uid on catalog row `row`."""
        r = self.rec.setdefault((uid, row), [0, 0, 0, 0, 0, 0, now])
        words = int(self.cat.words[row])
        for kind, ms in events:
            if kind == "view": r[0] = 1
            elif kind == "like": r[1] = 1
            elif kind == "open_detail": r[2] = 1
            elif kind == "open_source": r[3] = 1
            elif kind == "dislike": r[5] = 1
            elif kind == "dwell" and ms is not None and ms <= C.DWELL_WALKAWAY_MS and ms >= long_look_ms(words):
                r[4] = 1
        r[6] = now

    def refresh(self, now: float) -> "CrowdTables":
        """Build the tables from everything recorded so far."""
        return CrowdTables.build(self, now)


class CrowdTables:
    """The hourly crowd numbers, one array entry per catalog row (zeros when nobody has read anything)."""

    def __init__(self, n: int):
        self.n = n
        self.boost = np.zeros(n)         # trending buzz + quality (hours)
        self.quality = np.zeros(n)
        self.users = np.zeros(n)         # distinct users with a record on the card (14 d)
        self.pos_rate = np.zeros(n)      # smoothed positive rate
        self.engaged = np.zeros(n)       # distinct users positive on the card (14 d)
        self.links = sparse.csr_matrix((n, n))
        self.lift = np.zeros((len(C.CATEGORIES) + 1, len(C.CATEGORIES)))   # last row = everyone
        self.lift_users = np.zeros_like(self.lift)
        self.ledger_n = 0

    @staticmethod
    def empty(n: int) -> "CrowdTables":
        """Tables for a catalog of n cards with no crowd data."""
        return CrowdTables(n)

    @staticmethod
    def build(led: CrowdLedger, now: float) -> "CrowdTables":
        """Rebuild every table from the ledger as of `now` (what the live job does about hourly)."""
        cat = led.cat
        t = CrowdTables(cat.n)
        uids = sorted({u for u, _ in led.rec})
        uix = {u: i for i, u in enumerate(uids)}
        t.ledger_n = len(led.rec)
        if not led.rec:
            return t
        keys = list(led.rec)
        rows = np.array([r for _, r in keys])
        ui = np.array([uix[u] for u, _ in keys])
        a = np.array([led.rec[k] for k in keys], dtype=float)         # viewed liked detail src long dis last_t
        viewed, liked, detail, src, long_, dis, last = (a[:, i] for i in range(7))
        pos = ((liked + detail + src + long_) > 0) & (dis == 0)
        win14 = last > now - C.COLLAB_WINDOW_DAYS * C.DAY
        win48 = last > now - C.TREND_WINDOW_H
        w = C.TREND_W
        # --- buzz points (distinct users inside the 48 h window)
        pts = np.zeros(cat.n); cnt = np.zeros(cat.n)
        m = win48
        np.add.at(pts, rows[m], w["like"] * liked[m] + w["open_detail"] * detail[m] + w["open_source"] * src[m]
                  + w["long"] * long_[m] + w["view"] * viewed[m] - w["dislike"] * dis[m])
        np.add.at(cnt, rows[m], 1)
        pp, pn = np.maximum(pts, 0.0), np.maximum(-pts, 0.0)
        buzz = np.where(cnt >= C.TREND_MIN_USERS, C.TREND_MAX_H * pp / (pp + C.TREND_HALF_POINTS)
                        - C.TREND_MAX_NEG_H * pn / (pn + C.TREND_HALF_POINTS), 0.0)
        # --- quality (smoothed positive rate vs topic prior, 14 d)
        m = win14
        pos_n = np.zeros(cat.n); dis_n = np.zeros(cat.n); tot = np.zeros(cat.n)
        np.add.at(pos_n, rows[m], pos[m]); np.add.at(dis_n, rows[m], dis[m]); np.add.at(tot, rows[m], 1)
        pk = np.full(len(C.CATEGORIES), TOPIC_PRIOR_FLOOR)
        for c in range(len(C.CATEGORIES)):
            mm = m & (cat.cat[rows] == c)
            if mm.sum() > 0:
                pk[c] = max((pos[mm].sum() - dis[mm].sum()) / mm.sum(), TOPIC_PRIOR_FLOOR)
        pkc = pk[np.clip(cat.cat, 0, None)]
        q = np.where(tot >= C.CROWD_MIN_USERS,
                     np.clip(C.COLLAB_QUALITY_HOURS * np.log2(np.maximum((pos_n - dis_n + C.COLLAB_QUALITY_PRIOR_N * pkc)
                                                                         / (tot + C.COLLAB_QUALITY_PRIOR_N), 1e-3) / pkc),
                             -C.COLLAB_QUALITY_HOURS, C.COLLAB_QUALITY_HOURS), 0.0)
        t.quality = q
        t.boost = np.clip(buzz + q, -C.TREND_MAX_NEG_H, C.TREND_MAX_H)
        t.users = tot
        t.engaged = pos_n
        t.pos_rate = (pos_n + POS_RATE_PRIOR_VIEWS * POS_RATE_PRIOR) / (tot + POS_RATE_PRIOR_VIEWS)
        # --- card neighbours (positive pairs, 14 d, fade 7 d, <= 50 newest per user)
        pm = win14 & pos
        if pm.sum() > 0:
            ii, rr, ll = ui[pm], rows[pm], last[pm]
            order = np.lexsort((-ll, ii))
            ii, rr, ll = ii[order], rr[order], ll[order]
            keep = np.zeros(len(ii), dtype=bool)
            seen_n: dict[int, int] = defaultdict(int)
            for k, u in enumerate(ii):
                if seen_n[u] < C.COLLAB_MAX_PER_USER:
                    keep[k] = True
                seen_n[u] += 1
            ii, rr, ll = ii[keep], rr[keep], ll[keep]
            wt = 0.5 ** ((now - ll) / C.DAY / C.COLLAB_HALF_LIFE_DAYS)
            W = sparse.csr_matrix((wt, (ii, rr)), shape=(len(uids), cat.n))
            B = sparse.csr_matrix((np.ones_like(wt), (ii, rr)), shape=(len(uids), cat.n))
            dot = (W.T @ W).tocoo()
            cn = (B.T @ B).tocsr()
            nn = np.asarray(W.multiply(W).sum(axis=0)).ravel()
            ent: dict[int, list] = defaultdict(list)
            cnv = np.asarray(cn[dot.row, dot.col]).ravel() if dot.nnz else np.zeros(0)   # vectorised lookup (same values)
            okm = (dot.row != dot.col) & (cnv >= C.CROWD_MIN_USERS)
            for i, j, d in zip(dot.row[okm], dot.col[okm], dot.data[okm]):
                ent[i].append((d / (math.sqrt(nn[i] * nn[j]) + C.COLLAB_CARD_SHRINK), j))
            R, Cc, V = [], [], []
            for i, lst in ent.items():
                lst.sort(key=lambda x: (-x[0], x[1]))
                for s, j in lst[:C.COLLAB_CARD_NEIGHBORS]:
                    R.append(i); Cc.append(j); V.append(s)
            t.links = sparse.csr_matrix((V, (R, Cc)), shape=(cat.n, cat.n))
        # --- topic lifts per reader group
        ncat = len(C.CATEGORIES)
        cats = cat.cat[rows]
        likes: dict[int, set] = defaultdict(set)
        mp = win14 & pos & (cats >= 0)
        if mp.any():
            key = ui[mp] * ncat + cats[mp]
            uk, cn_ = np.unique(key, return_counts=True)
            for k_, n_ in zip(uk, cn_):
                if n_ >= C.COLLAB_TOPIC_MIN_POS:
                    likes[int(k_ % ncat)].add(int(k_ // ncat))
        for uid, f in led.follows.items():
            if uid in uix:
                for k in f:
                    if k in C.CATEGORIES:
                        likes[C.CATEGORIES.index(k)].add(uix[uid])
        def group(users):
            mm = win14 & (cats >= 0)
            if users is not None:
                mm = mm & np.isin(ui, list(users))
            shown = np.bincount(cats[mm], minlength=ncat).astype(float)
            posc = np.bincount(cats[mm], weights=pos[mm].astype(float), minlength=ncat)
            if mm.any():
                uk = np.unique(ui[mm] * ncat + cats[mm])
                nu = np.bincount(uk % ncat, minlength=ncat).astype(float)
            else:
                nu = np.zeros(ncat)
            return shown, posc, nu, mm
        for gi, users in [(ncat, None)] + [(k, likes[k]) for k in range(ncat) if likes.get(k)]:
            shown, posc, nu, mm = group(users)
            tot_shown = shown.sum()
            if tot_shown == 0:
                continue
            rate = max(posc.sum() / tot_shown, 0.01)
            for l in range(ncat):
                if nu[l] >= C.CROWD_MIN_USERS and gi != l:
                    t.lift[gi, l] = np.clip(((posc[l] + C.COLLAB_TOPIC_PRIOR_N * rate) / (shown[l] + C.COLLAB_TOPIC_PRIOR_N)) / rate - 1, -1, 1)
                    t.lift_users[gi, l] = nu[l]
        return t

    # ---- per-user lookups -------------------------------------------------------------
    def link_x(self, state, catalog: Catalog, now: float) -> np.ndarray:
        """x[j] = sum over my positive cards i of fade_i * sim(i, j)."""
        w = np.zeros(self.n)
        for cid, sg in state.sigs.items():
            if sg.disliked or not (sg.liked or sg.detail or sg.srcopen or
                                   (sg.max_dwell is not None and sg.max_dwell >= long_look_ms(sg.words))):
                continue
            r = catalog.index.get(cid)
            if r is None:
                continue
            age = (now - sg.last_t) / C.DAY
            if age <= C.COLLAB_WINDOW_DAYS:
                w[r] = 0.5 ** (age / C.SIGNAL_HALF_LIFE_DAYS)
        if not w.any() or self.links.nnz == 0:
            return np.zeros(self.n)
        return np.asarray(self.links.T @ w).ravel()

    def topic_prior(self, state, aff) -> np.ndarray:
        """crowd guess per topic (-1..1) from my follows and liked topics, else the everyone row."""
        ncat = len(C.CATEGORIES)
        wk = np.zeros(ncat)
        for f in state.follows:
            if f in C.CATEGORIES:
                wk[C.CATEGORIES.index(f)] = 1.0
        for k, h in aff["c"].items():
            if h > 0 and k in C.CATEGORIES:
                i = C.CATEGORIES.index(k)
                wk[i] = max(wk[i], min(h / C.AFF_CAP["category"], 1.0))
        out = self.lift[ncat].copy()
        for l in range(ncat):
            num = den = 0.0
            for k in range(ncat):
                if k != l and wk[k] > 0 and self.lift_users[k, l] >= C.CROWD_MIN_USERS:
                    num += wk[k] * self.lift[k, l]; den += wk[k]
            if den > 0:
                out[l] = num / den
        return out
