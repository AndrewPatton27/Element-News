"""Python ports of the formulas that rank the live feeds today, plus two simple baselines.

Input: a reader state, catalog rows, the time and the crowd tables (the same inputs as the ML ranker).
Output: catalog rows, best first (each class implements interfaces.Policy).
Why: the ML ranker is only worth anything if it beats what readers get today, so the evaluation needs
faithful copies. CurrentServer.raw_scores is also a stage-2 feature (srv_score) of the hardened heads.

a1 CurrentServer : port of api.feed_for_you v4 (20261018010000_algo_v2.sql) incl. crowd boosts.
a2 CurrentDevice : port of lib/forYouRank.ts + lib/localRank.ts (signed-out / device path).
b  RecencyImportance : stored rank_score (importance x recency), unseen only.
c  Popularity : distinct readers who engaged (crowd table), ties by rank_score.
d  VectorsOnly : stage 1 cosine order (no GBDT, no MMR, no exploration) -- built in evaluation/policies.py.

All of them see exactly what the ML ranker sees (cards + events), nothing from the simulator.
"""
from __future__ import annotations

import numpy as np

from .. import config as C
from ..data.catalog import Catalog
from ..features.crowd import CrowdTables
from ..features.uservec import UserState, long_look_ms
from ..interfaces import Policy

DIVERSIFY_HEAD = 40             # the server re-orders only its first 40 cards for topic variety
DEVICE_TRENDING_POOL, DEVICE_LATEST_POOL = 60, 30   # device formula pool: Trending top 60 + Latest top 30
DIVERSIFY_MAX_JUMP = 6          # diversify never moves a card more than 6 places down


# ---------------------------------------------------------------------------------------
def diversify_feed(cats: list[int], max_run: int = 2, window: int = 5) -> list[int]:
    """Port of lib/diversify.ts diversifyFeed on a list of category ids; returns the new index order."""
    window = max(max_run + 1, window)
    remaining = [(i, c) for i, c in enumerate(cats)]
    out: list[tuple[int, int]] = []
    while remaining:
        pos = len(out)
        start = max(0, pos - window + 1)
        def win_ok(c):
            return sum(1 for _, oc in out[start:] if oc == c) < max_run
        def eligible(x):
            idx, c = x
            if pos - idx > DIVERSIFY_MAX_JUMP:
                return False
            if pos and out[pos - 1][1] == c:
                return False
            return win_ok(c)
        j = next((k for k, x in enumerate(remaining) if eligible(x)), -1)
        if j < 0:
            j = next((k for k, (idx, c) in enumerate(remaining) if win_ok(c) and not (pos and out[pos - 1][1] == c)), -1)
        if j < 0:
            j = 0
        out.append(remaining.pop(j))
    return [i for i, _ in out]


def cap_topics(cats: list[int], window: int, cap: int) -> list[int]:
    """Port of the device topic cap: at most `cap` cards per category in the first `window`; held cards follow."""
    head, held, rest, n = [], [], [], {}
    for i, c in enumerate(cats):
        if len(head) >= window:
            rest.append(i); continue
        if n.get(c, 0) >= cap:
            held.append(i); continue
        n[c] = n.get(c, 0) + 1
        head.append(i)
    return head + held + rest


def _unseen_filter(state: UserState, cat: Catalog, rows: np.ndarray, drop_seen: bool) -> np.ndarray:
    """Rows without disliked cards and hidden topics / sources (and without seen cards if drop_seen)."""
    dis = state.disliked_ids
    seen = state.seen_ids if drop_seen else set()
    out = [r for r in rows if cat.cards[r].id not in dis and cat.cards[r].id not in seen
           and cat.cards[r].category not in state.hidden_cats and not (cat.cards[r].source and cat.cards[r].source in state.hidden_srcs)]
    return np.array(out, dtype=int)


# ---------------------------------------------------------------------------------------
class RecencyImportance(Policy):
    """b: the stored rank_score alone (importance x recency), unseen cards only."""
    name = "b_recency_importance"

    def __init__(self, cat: Catalog):
        self.cat = cat

    def rank(self, state, rows, now, crowd):
        e = _unseen_filter(state, self.cat, rows, True)
        return e[np.argsort(-self.cat.base[e], kind="stable")]


class Popularity(Policy):
    """c: most distinct readers who engaged first (crowd table), ties by rank_score."""
    name = "c_popularity"

    def __init__(self, cat: Catalog):
        self.cat = cat

    def rank(self, state, rows, now, crowd):
        e = _unseen_filter(state, self.cat, rows, True)
        pop = crowd.engaged[e] if crowd is not None and crowd.n == self.cat.n else np.zeros(len(e))
        key = np.lexsort((-self.cat.base[e], -pop))
        return e[key]


# ---------------------------------------------------------------------------------------
class CurrentServer(Policy):
    """api.feed_for_you v4. Score (hours) = rank_score + trend boost
         + 3 * (follow + learned affinity + explore + topic hint) + card-link boost - seen penalty
         - step * (better same-topic cards ahead), then diversify. All constants from config.SQL."""
    name = "a1_current_server"

    def __init__(self, cat: Catalog):
        self.cat = cat

    def raw_scores(self, state: UserState, rows: np.ndarray, now: float, crowd: CrowdTables, aff=None) -> np.ndarray:
        """Score in hours for each row, before the same-topic step and diversify (rows already filtered)."""
        cat, S = self.cat, C.SQL
        if len(rows) == 0:
            return np.zeros(0)
        aff = aff if aff is not None else state.affinity(now)
        nev = state.n_rows
        have = crowd is not None and crowd.n == cat.n
        prior = crowd.topic_prior(state, aff) if have else np.zeros(len(C.CATEGORIES))
        link = crowd.link_x(state, cat, now) if have else np.zeros(cat.n)
        sig_cats = {sg.cat for sg in state.sigs.values() if (now - sg.last_t) / C.DAY <= S["affinity_days"]}
        s0 = np.zeros(len(rows))
        for i, r in enumerate(rows):
            c = cat.cards[r]
            h = (S["boost_followed_hours"] if c.category in state.follows else 0.0) + aff["c"].get(c.category, 0.0)
            h += aff["t"].get(c.event_type or c.kind, 0.0)
            if c.source:
                h += aff["s"].get(c.source, 0.0)
            expl = S["explore_hours"] if (nev >= S["explore_min_events"] and c.category not in state.follows
                                          and c.category not in sig_cats) else 0.0
            ci = cat.cat[r]
            hint = C.COLLAB_TOPIC_HOURS * (prior[ci] if ci >= 0 else 0.0) * (1 - aff["k"].get(c.category, 0.0))
            sg = state.sigs.get(c.id)
            pen = 0.0
            if sg is not None and sg.viewed:
                was_read = sg.detail or (sg.max_dwell is not None and sg.max_dwell >= long_look_ms(sg.words))
                pen = S["seen_penalty"] if was_read else S["seen_view_penalty"]
            boost = crowd.boost[r] if have else 0.0
            lk = C.COLLAB_CARD_HOURS * link[r] / (link[r] + C.COLLAB_CARD_HALF) if link[r] > 0 else 0.0
            s0[i] = cat.base[r] - now + boost + S["personal_scale"] * (h + expl + hint) + lk - pen
        return s0

    def rank(self, state: UserState, rows: np.ndarray, now: float, crowd: CrowdTables, extra=None):
        """Full feed order: raw score, minus `step` hours per better same-topic card ahead (bigger for a cold
        reader with no follows), then diversify the first 40.
        extra: optional callable(rows) -> hours added to the score (used by the hardened vector term)."""
        cat, S = self.cat, C.SQL
        rows = _unseen_filter(state, cat, rows, False)
        if len(rows) == 0:
            return rows
        nev = state.n_rows
        step = S["category_step"]
        if not state.follows:
            step += S["cold_step"] * max(1 - nev / max(S["cold_events"], 1), 0)
        s0 = self.raw_scores(state, rows, now, crowd)
        if extra is not None:
            s0 = s0 + extra(rows)
        order = np.argsort(-s0, kind="stable")
        rows, s0 = rows[order], s0[order]
        depth: dict[int, int] = {}
        ps = np.zeros(len(rows))
        for i, r in enumerate(rows):
            d = depth.get(int(cat.cat[r]), 0)
            depth[int(cat.cat[r])] = d + 1
            ps[i] = s0[i] - step * d
        order = np.argsort(-ps, kind="stable")
        rows = rows[order]
        head = rows[:DIVERSIFY_HEAD]
        idx = diversify_feed([int(cat.cat[r]) for r in head])
        return np.concatenate([head[idx], rows[DIVERSIFY_HEAD:]]).astype(int)


# ---------------------------------------------------------------------------------------
class CurrentDevice(Policy):
    """lib/forYouRank.ts rankForYou on the device pool (Trending top 60 + Latest top 30 here; live loads fewer
    per page). Reactions = likes and dislikes only: dwell, detail and source taps are invisible to it."""
    name = "a2_current_device"

    def __init__(self, cat: Catalog):
        self.cat = cat

    def rank(self, state: UserState, rows: np.ndarray, now: float, crowd: CrowdTables):
        cat, FY, RK = self.cat, C.FY, C.RANK
        rows = np.array([r for r in rows], dtype=int)
        have = crowd is not None and crowd.n == cat.n
        trend_key = cat.base[rows] - now + (crowd.boost[rows] if have else 0.0)
        trending = rows[np.argsort(-trend_key, kind="stable")]
        latest = rows[np.argsort(-cat.sort_at[rows] - 1e-9 * rows, kind="stable")]
        pool = list(dict.fromkeys(list(trending[:DEVICE_TRENDING_POOL]) + list(latest[:DEVICE_LATEST_POOL])))
        trend_top = list(trending[:10])
        trank = {r: i for i, r in enumerate(trend_top)}
        react = {i: sg for i, sg in state.sigs.items() if sg.liked or sg.disliked}
        # drop disliked / hidden
        pool = [r for r in pool if not (cat.cards[r].id in react and react[cat.cards[r].id].disliked)
                and cat.cards[r].category not in state.hidden_cats]
        if not pool:
            return np.array([], dtype=int)
        like_t, dis_t, like_s, dis_s = {}, {}, {}, {}
        for sg in react.values():
            (like_t if sg.liked else dis_t)[sg.cat] = (like_t if sg.liked else dis_t).get(sg.cat, 0) + 1
            if sg.src:
                (like_s if sg.liked else dis_s)[sg.src] = (like_s if sg.liked else dis_s).get(sg.src, 0) + 1
        by_at = sorted(react.items(), key=lambda kv: -kv[1].last_t)
        last3 = {sg.cat for _, sg in by_at[:FY["spillLast"]] if sg.disliked}
        per_topic: dict[str, list] = {}
        for _, sg in by_at:
            per_topic.setdefault(sg.cat, []).append(sg)
        m3 = lambda n: min(n, RK["maxCount"])
        taste: dict[str, float] = {}
        for k, lst in per_topic.items():
            d = 0.0
            for sg in lst[:3]:
                dec = 0.5 ** (max(0.0, now - sg.last_t) / (FY["likeHalfLifeDays"] * C.DAY))
                d += (FY["tasteWeight"] if sg.liked else -FY["tasteWeight"]) * (dec - 1)
            taste[k] = d
        sc = []
        for r in pool:
            c = cat.cards[r]
            base = c.published_at + C.HALF_LIFE_H * np.log2(max(c.importance, 1.0)) - now
            loc = (RK["favorite"] if c.category in state.follows else 0.0)
            loc += RK["likeTopic"] * m3(like_t.get(c.category, 0)) + (RK["likeSource"] * m3(like_s.get(c.source, 0)) if c.source else 0)
            loc -= RK["dislikeTopic"] * m3(dis_t.get(c.category, 0)) + (RK["dislikeSource"] * m3(dis_s.get(c.source, 0)) if c.source else 0)
            tr = trank.get(r)
            overlap = 0.0 if tr is None else (FY["overlapTop3"] if tr < 3 else FY["overlapTop10"])
            reacted = c.id in react
            sg = state.sigs.get(c.id)
            pen = FY["reactedPenalty"] if reacted else (FY["seenPenalty"] if (sg is not None and sg.viewed) else 0)
            spill = -FY["dislikeSpill"] if c.category in last3 else 0.0
            sc.append(base + loc - pen - overlap + taste.get(c.category, 0.0) + spill)
        order = np.argsort(-np.array(sc), kind="stable")
        ordered = [pool[i] for i in order]
        cold = not state.follows and len(react) < FY["coldReactions"]
        if cold:
            depth: dict[str, int] = {}
            tmp = []
            for i, r in enumerate(ordered):
                d = depth.get(cat.cards[r].category, 0)
                depth[cat.cards[r].category] = d + 1
                tmp.append((d, i, r))
            ordered = [r for _, _, r in sorted(tmp)]
        seen_ids = state.seen_ids
        if not cold and len(react) >= FY["exploreMinReactions"]:
            known = set(state.follows) | {sg.cat for sg in react.values()}
            slot = FY["exploreFirst"] - 1
            while slot < len(ordered):
                j = next((i for i, r in enumerate(ordered) if i > slot and cat.cards[r].category not in known
                          and cat.cards[r].id not in seen_ids), -1)
                if j < 0 or any(cat.cards[r].category not in known and cat.cards[r].id not in seen_ids for r in ordered[:slot + 1]):
                    slot += FY["exploreEvery"]; continue
                ordered = ordered[:slot] + [ordered[j]] + ordered[slot:j] + ordered[j + 1:]
                slot += FY["exploreEvery"]
        # finishForYou: cap topics, spread from Trending, first-card guard, diversify, cap, diversify
        cats = [int(cat.cat[r]) for r in ordered]
        idx = cap_topics(cats, FY["topicCapWindow"], FY["topicCap"])
        ordered = [ordered[i] for i in idx]
        tset = set(trend_top)
        head, held, rest = [], [], []
        shared = 0
        for r in ordered:
            if len(head) >= FY["overlapWindow"]:
                rest.append(r); continue
            if r in tset:
                if shared >= FY["overlapMax"]:
                    held.append(r); continue
                shared += 1
            head.append(r)
        ordered = head + held + rest
        if len(ordered) > 1 and trend_top and ordered[0] == trend_top[0]:
            ordered = [ordered[1], ordered[0]] + ordered[2:]
        top = ordered[:60]
        tail = ordered[60:]
        c1 = [int(cat.cat[r]) for r in top]
        top = [top[i] for i in diversify_feed(c1)]
        c2 = [int(cat.cat[r]) for r in top]
        top = [top[i] for i in cap_topics(c2, FY["topicCapWindow"], FY["topicCap"])]
        c3 = [int(cat.cat[r]) for r in top]
        top = [top[i] for i in diversify_feed(c3)]
        return np.array(top + tail, dtype=int)
