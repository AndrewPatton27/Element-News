"""Reader state: the online user vector, the RLS reader model and the per-card signal ledger.

Input: one reader's events in time order, `observe(card, item_vector, [(kind, dwell_ms), ...], time)`,
with kinds as in core.user_events (view, like, dislike, open_detail, open_source, dwell).
Output: the reader vector and its uncertainty, RLS scores, affinities in hours (a port of
core.user_affinity_dims), seen / disliked ids and a few habit averages, all read by the features.
Why: the state is a pure function of the reader's earlier events plus card text, so it can be rebuilt
for any past moment from real event logs. Only things the real app could know: card ids, categories,
event kinds, dwell milliseconds, times. Privacy class is the same as core.user_events.

User vector update (per event, in order):
    step      eta = max(ETA_MIN, ETA0 / (1 + n / TAU)),  n = decayed evidence so far (sum of |signal|)
    positive  v += min(eta * |s|, 1) * (x - v)      move toward the card's vector x
    negative  v -= eta * |s| * x                    move away from it
    then clip |v| <= UV_MAX_NORM; n += |s|; per-dimension precision += GAIN * |s| * dims * x_d^2
Between events v decays toward the cold-start prior (built from followed topics) with a 14-day half-life.

Robust update (hardening, `update="kalman"`, tried and not adopted): the step is a scalar Kalman gain.
    variance P grows by Q per day without evidence (taste can drift), an event of weight a has noise R / a,
    gain k = P / (P + R / a), then P = (1 - k) P.  Positive: v += k (x - v).  Negative: v -= neg_mult * k * x.
    Huber-style outlier guard: once evidence is high, an event whose card points far from the current vector
    (cosine below huber_cos) gets its weight cut to huber_floor, so one stray like cannot swing the vector.
    Dwell-derived signals (long look, quick skip) are multiplied by dwell_mult (they are the noisiest).

RLS reader model (hardening, adopted): ridge regression of a per-impression reward on [item vector, 1],
updated on every view, so "viewed and did nothing" counts as reward 0. Prior = the follow vector.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Optional

import numpy as np

from .. import config as C
from ..data.cards import Card

RECENT_EMBS = 20                # liked / disliked item vectors kept for the max-similarity features
RECENT_CATS = 50                # categories of the last 50 views (exposure feature)
MAX_EVENT_WEIGHT = 1.5          # one event moves the vector with weight at most this
STRONG_KINDS = ("like", "dislike", "open_detail", "open_source")   # explicit events (n_strong)


@dataclass
class CardSig:
    """What one reader did with one card (the per-card row of the signal ledger)."""
    cat: str
    typ: str
    src: Optional[str]
    words: int
    viewed: bool = False
    liked: bool = False
    disliked: bool = False
    detail: bool = False
    srcopen: bool = False
    max_dwell: Optional[float] = None
    last_t: float = 0.0
    shown: int = 0


@dataclass(frozen=True)
class VecCfg:
    """How the user vector learns. Default = the original shrinking step."""
    update: str = "shrink"            # "shrink" (original) | "kalman" (hardened)
    p0: float = 1.0                    # kalman: prior variance (first-event gain = p0 / (p0 + r))
    r: float = 1.6                     # kalman: observation noise of a weight-1 event
    q_per_day: float = 0.08            # kalman: variance added per day (lets the vector follow drift)
    p_max: float = 1.0                 # kalman: variance never grows past this
    neg_mult: float = 1.0              # negative events step this much relative to positive ones
    dwell_mult: float = 1.0            # weight multiplier for long-look / quick-skip nudges
    huber_cos: float = -2.0            # outlier guard off by default (cosine can never be below -1)
    huber_floor: float = 0.35          # an outlier event keeps this share of its weight
    huber_min_ev: float = 6.0          # guard only once this much evidence exists


def long_look_ms(words: int) -> float:
    """Dwell that counts as a long look for a card of `words` words (live rule: words x 150 ms, 6 to 8 s)."""
    return min(C.DWELL_LONG_MS, max(C.DWELL_LONG_MIN_MS, words * C.DWELL_MS_PER_WORD))


class UserState:
    def __init__(self, uid: str, dims: int, follows=(), prior: Optional[np.ndarray] = None, now: float = 0.0,
                 static_step: bool = False, n_cap: Optional[float] = None, vcfg: Optional[VecCfg] = None):
        self.uid, self.dims, self.static_step, self.n_cap = uid, dims, static_step, n_cap
        self.vcfg = vcfg or VecCfg()
        self.P = self.vcfg.p0
        self.follows = list(follows)
        self.prior = np.zeros(dims) if prior is None else np.asarray(prior, dtype=float).copy()
        self.vec = self.prior.copy()
        self.prec = np.zeros(dims)
        self.n_ev = 0.0
        self.last_t = now
        self.sigs: dict[str, CardSig] = {}
        self.hidden_cats: set[str] = set()
        self.hidden_srcs: set[str] = set()
        self.liked_embs: deque = deque(maxlen=RECENT_EMBS)
        self.disliked_embs: deque = deque(maxlen=RECENT_EMBS)
        self.recent_cats: deque = deque(maxlen=RECENT_CATS)
        self.n_strong = 0                     # likes + dislikes + open_detail + open_source
        self.n_impr = 0
        self.n_rows = 0                       # all event rows (core.user_events rows), used by the cold-start rule
        self.comp_ema, self.like_ema, self.skip_ema = 0.5, 0.1, 0.3
        # RLS reader model on [x, 1]: every impression counts, including "viewed and did nothing" (reward 0)
        d1 = dims + 1
        self.rls_A0 = C.RLS_LAMBDA * np.eye(d1)
        self.rls_b0 = self.rls_A0 @ np.append(C.RLS_PRIOR_SCALE * self.prior, 0.0)
        self.rls_A, self.rls_b = self.rls_A0.copy(), self.rls_b0.copy()
        self._rls_cache = None

    # ---- helpers ---------------------------------------------------------------------
    @property
    def seen_ids(self) -> set[str]:
        return {i for i, s in self.sigs.items() if s.viewed}

    @property
    def disliked_ids(self) -> set[str]:
        return {i for i, s in self.sigs.items() if s.disliked}

    def advance(self, now: float) -> None:
        """Move the clock to `now`: fade the vector, evidence and RLS model toward their priors."""
        dt = now - self.last_t
        if dt > 0:
            f = 0.5 ** (dt / (C.DAY * C.UV_HALF_LIFE_DAYS))
            self.vec = self.prior + (self.vec - self.prior) * f
            self.prec *= f
            self.n_ev *= f
            fr = 0.5 ** (dt / (C.DAY * C.RLS_HALF_LIFE_DAYS))
            self.rls_A = self.rls_A0 + (self.rls_A - self.rls_A0) * fr
            self.rls_b = self.rls_b0 + (self.rls_b - self.rls_b0) * fr
            self._rls_cache = None
            if self.vcfg.update == "kalman":
                self.P = min(self.vcfg.p_max, self.P + self.vcfg.q_per_day * dt / C.DAY)
            self.last_t = now

    def gain(self, a: float) -> float:
        """Kalman gain for an event of weight a (kalman mode)."""
        cfg = self.vcfg
        return self.P / (self.P + cfg.r / max(a, 1e-6))

    def _nudge(self, x: np.ndarray, s: float, dwell: bool = False) -> None:
        """Move the vector for one signal of weight s toward (s > 0) or away from (s < 0) item vector x."""
        a = min(abs(s), MAX_EVENT_WEIGHT)
        cfg = self.vcfg
        if cfg.update == "kalman":
            if dwell:
                a *= cfg.dwell_mult
            nv = float(np.linalg.norm(self.vec))
            if self.n_ev >= cfg.huber_min_ev and nv > 1e-9:
                cosv = float(x @ self.vec) / nv
                outlier = cosv < cfg.huber_cos if s > 0 else cosv < -cfg.huber_cos
                if outlier:
                    a *= cfg.huber_floor
            if a <= 0:
                return
            k = self.gain(a)
            if s > 0:
                self.vec = self.vec + k * (x - self.vec)
            else:
                self.vec = self.vec - cfg.neg_mult * k * x
            self.P = (1.0 - k) * self.P
        else:
            n_eff = self.n_ev if self.n_cap is None else min(self.n_ev, self.n_cap)
            eta = C.STATIC_STEP if self.static_step else max(C.UV_ETA_MIN, C.UV_ETA0 / (1.0 + n_eff / C.UV_TAU))
            if s > 0:
                self.vec = self.vec + min(eta * a, 1.0) * (x - self.vec)
            else:
                self.vec = self.vec - eta * a * x
        nrm = np.linalg.norm(self.vec)
        if nrm > C.UV_MAX_NORM:
            self.vec *= C.UV_MAX_NORM / nrm
        self.n_ev += a
        self.prec += C.UV_PREC_GAIN * a * self.dims * x * x

    # ---- RLS reader model ---------------------------------------------------------------
    def rls_reward(self, card: Card, events) -> Optional[float]:
        """Reward of one impression from its events (live signal weights, capped like core.user_affinity).
        None when the reader walked away (no information)."""
        r, acted, ms_ = 0.0, False, None
        for kind, ms in events:
            if kind in STRONG_KINDS:
                r += C.SIGNAL[kind]
                acted = acted or kind != "dislike"
            elif kind == "dwell" and ms is not None:
                ms_ = ms
        if ms_ is not None:
            if ms_ > C.DWELL_WALKAWAY_MS:
                return None if r == 0 else max(min(r, C.CARD_CAP_POS), C.CARD_CAP_NEG)
            if ms_ >= long_look_ms(card.word_count):
                r += C.SIGNAL["long_look"]
            elif ms_ <= C.DWELL_SKIP_MS and not acted:
                r += C.SIGNAL["quick_skip"]
        return max(min(r, C.CARD_CAP_POS), C.CARD_CAP_NEG)

    def rls_update(self, emb: np.ndarray, r: float) -> None:
        """Add one (item vector, reward) observation to the ridge regression."""
        xt = np.append(emb, 1.0)
        self.rls_A += np.outer(xt, xt)
        self.rls_b += r * xt
        self._rls_cache = None

    def rls(self) -> tuple[np.ndarray, np.ndarray]:
        """(weights w on [x, 1], inverse of A) -- cached until the next update."""
        if self._rls_cache is None:
            Ainv = np.linalg.inv(self.rls_A)
            self._rls_cache = (Ainv @ self.rls_b, Ainv)
        return self._rls_cache

    def rls_scores(self, embs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Predicted reward and its standard error for each card vector."""
        w, Ainv = self.rls()
        Xt = np.hstack([embs, np.ones((len(embs), 1))])
        return Xt @ w, np.sqrt(np.maximum(np.einsum("ij,jk,ik->i", Xt, Ainv, Xt), 0.0))

    # ---- learning --------------------------------------------------------------------
    def observe(self, card: Card, emb: np.ndarray, events: list[tuple[str, Optional[float]]], now: float) -> None:
        """events: ordered (kind, dwell_ms) for ONE impression; kinds as in core.user_events."""
        self.advance(now)
        if any(k == "view" for k, _ in events):
            r = self.rls_reward(card, events)
            if r is not None:
                self.rls_update(emb, r)
        sig = self.sigs.get(card.id)
        if sig is None:
            sig = self.sigs[card.id] = CardSig(card.category, card.event_type or card.kind, card.source, card.word_count)
        sig.last_t = now
        self.n_rows += len(events)
        acted = any(k in ("like", "open_detail", "open_source") for k, _ in events)
        for kind, ms in events:
            if kind == "view":
                sig.viewed = True
                sig.shown += 1
                self.n_impr += 1
                self.recent_cats.append(card.category)
            elif kind == "like":
                sig.liked = True; self.n_strong += 1
                self.like_ema += 0.1 * (1 - self.like_ema)
                self._nudge(emb, C.SIGNAL["like"]); self.liked_embs.append(emb)
            elif kind == "dislike":
                sig.disliked = True; self.n_strong += 1
                self._nudge(emb, C.SIGNAL["dislike"]); self.disliked_embs.append(emb)
            elif kind == "open_detail":
                sig.detail = True; self.n_strong += 1
                self._nudge(emb, C.SIGNAL["open_detail"]); self.liked_embs.append(emb)
            elif kind == "open_source":
                sig.srcopen = True; self.n_strong += 1
                self._nudge(emb, C.SIGNAL["open_source"])
            elif kind == "dwell" and ms is not None:
                if ms > C.DWELL_WALKAWAY_MS:
                    continue                                   # walked away: no look
                sig.max_dwell = ms if sig.max_dwell is None else max(sig.max_dwell, ms)
                comp = min(ms / max(card.word_count * C.READ_MS_PER_WORD_REF, 1.0), C.COMPLETION_CAP)
                self.comp_ema += 0.15 * (comp - self.comp_ema)
                skip = ms <= C.DWELL_SKIP_MS and not (acted or sig.liked or sig.detail or sig.srcopen)
                self.skip_ema += 0.1 * ((1.0 if skip else 0.0) - self.skip_ema)
                if ms >= long_look_ms(card.word_count):
                    self._nudge(emb, C.SIGNAL["long_look"], dwell=True); self.liked_embs.append(emb)
                elif skip:
                    self._nudge(emb, C.SIGNAL["quick_skip"], dwell=True)

    # ---- affinities (port of core.user_affinity_dims + core.user_taste) ------------------
    def affinity(self, now: float) -> dict[str, dict[str, float]]:
        """{'c': topic -> hours, 't': type -> hours, 's': source -> hours, 'k': topic -> confidence}."""
        acc: dict[tuple[str, str], list[float]] = {}
        for sg in self.sigs.values():
            age_d = (now - sg.last_t) / C.DAY
            if age_d > C.SQL["affinity_days"]:
                continue
            s = 0.0
            s += C.SIGNAL["like"] if sg.liked else 0.0
            s += C.SIGNAL["dislike"] if sg.disliked else 0.0
            s += C.SIGNAL["open_detail"] if sg.detail else 0.0
            s += C.SIGNAL["open_source"] if sg.srcopen else 0.0
            md = sg.max_dwell
            if md is not None and md >= long_look_ms(sg.words):
                s += C.SIGNAL["long_look"]
            if md is not None and md <= C.DWELL_SKIP_MS and not (sg.liked or sg.detail or sg.srcopen):
                s += C.SIGNAL["quick_skip"]
            s = max(min(s, C.CARD_CAP_POS), C.CARD_CAP_NEG)
            f = 0.5 ** (max(age_d, 0.0) / C.SIGNAL_HALF_LIFE_DAYS)
            for dim, key in (("category", sg.cat), ("type", sg.typ), ("source", sg.src)):
                if key is None:
                    continue
                a = acc.setdefault((dim, key), [0.0, 0.0])
                a[0] += s * f
                if s != 0:
                    a[1] += f
        out = {"c": {}, "t": {}, "s": {}, "k": {}}
        for (dim, key), (tot, n) in acc.items():
            cap = C.AFF_CAP[dim]
            hours = max(min(tot, cap), -cap)
            conf = n / max(n + C.AFF_PRIOR_CARDS, 1e-6)
            h = conf * hours if hours >= 0 else max(conf * hours * C.NEG_SCALE, -cap)
            slot = {"category": "c", "type": "t", "source": "s"}[dim]
            out[slot][key] = h
            if dim == "category":
                out["k"][key] = conf
        return out

    def uncertainty(self) -> np.ndarray:
        """Per-dimension variance, 1 with no evidence, falling as events touch that direction."""
        return 1.0 / (1.0 + self.prec)


def make_prior(embedder, follows) -> np.ndarray:
    """Cold-start reader vector: the mean of the followed categories' centroids, length UV_PRIOR_NORM."""
    cs = [embedder.centroids[f] for f in follows if f in embedder.centroids]
    if not cs:
        return np.zeros(embedder.k)
    v = np.mean(cs, axis=0)
    return C.UV_PRIOR_NORM * v / (np.linalg.norm(v) + 1e-12)
