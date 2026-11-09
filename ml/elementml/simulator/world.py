"""The behaviour model: how a simulated reader reacts to a card (the ground truth that grades rankings).

Input: the Catalog, the hidden card topic mixtures (latents) and world knobs (noise, topic-signal strength,
position bias, and the "wild" world's moods, drift, bursty days and mistaps). Output, per impression:
the events a real app would log, [("view", None), ("like", None), ..., ("dwell", ms)], plus a private
outcome record; and, for grading only, the true value (`gain`) and expected rates of any card.
Why: the reaction model is sigmoids of a hidden score z = taste x topic + source/type preference +
importance - staleness + bias + per-card noise. Draws are fixed per (persona, card) ("common random
numbers"), so every method meets the same reactions and differs only in what it shows.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from .. import config as C
from ..data.catalog import Catalog
from ..data.generator import N_SUB
from .personas import Persona, _taste

WALKAWAY_P = 0.02               # chance an impression is a walk-away (dwell of 130 to 190 s)
SESSION_SEEDS = 400             # stop-decision draws are cycled every 400 sessions


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


class World:
    """Cards + hidden latents + deterministic per-(persona, card) random draws."""

    def __init__(self, catalog: Catalog, latents: dict[str, np.ndarray], user_start_day: int = 3,
                 noise_mult: float = 1.0, taste_scale: float = 1.0, pos_decay: float = 0.07,
                 pos_form: str = "hyper", mood_sd: float = 0.0, session_gain_sd: float = 0.0, drift: float = 0.0,
                 mistap: float = 0.0, bursty: bool = False):
        self.noise_mult, self.taste_scale, self.pos_decay = noise_mult, taste_scale, pos_decay   # stress-test knobs
        # third-world knobs (all off by default, so the normal and stress worlds are unchanged):
        #   pos_form "exp": examination 0.5 ** (pos / 5) instead of 1 / (1 + decay * pos)
        #   mood_sd: per-session random offset on every subtopic (inconsistent taste, topic-correlated noise)
        #   session_gain_sd: per-session multiplier on the whole taste (some sessions the reader barely cares)
        #   drift: taste slides linearly toward a second hidden taste, reaching `drift` share after 14 days
        #   mistap: chance per impression of an accidental like or dislike, unrelated to the card
        #   bursty: on each day a reader is active with p 0.55, and then has 1 to 3 sessions at random slots
        self.pos_form, self.mood_sd, self.session_gain_sd, self.drift = pos_form, mood_sd, session_gain_sd, drift
        self.mistap, self.bursty = mistap, bursty
        self._mood: dict[tuple, tuple] = {}
        self._alt: dict[int, np.ndarray] = {}
        self.catalog = catalog
        self.L = np.stack([latents[c.id] for c in catalog.cards])
        self.sub_main = np.argmax(self.L, axis=1)
        self.user_start_day = user_start_day
        self._cache: dict[int, tuple] = {}

    def _draws(self, p: Persona):
        """Fixed random draws for one persona over every card (cached)."""
        d = self._cache.get(p.seed)
        if d is None:
            n = self.catalog.n
            d = (np.random.default_rng([p.seed, 11]).normal(size=n),            # idiosyncratic taste noise
                 np.random.default_rng([p.seed, 12]).random((n, 6)),            # like dis detail src skip walk
                 np.random.default_rng([p.seed, 14]).normal(size=n),            # dwell noise
                 np.random.default_rng([p.seed, 13]).random((SESSION_SEEDS, C.MAX_SESSION_CARDS + 2)))  # stop draws
            self._cache[p.seed] = d
        return d

    def taste_of(self, p: Persona, day: float) -> np.ndarray:
        """The persona's hidden taste on `day` (after a shift and with drift, if on)."""
        t = p.taste2 if (p.taste2 is not None and p.shift_day is not None and day >= p.shift_day) else p.taste
        if self.drift > 0:
            alt = self._alt.get(p.seed)
            if alt is None:
                r = np.random.default_rng([p.seed, 31])
                alt = self._alt[p.seed] = _taste(r, str(r.choice(["picky_sub", "picky_cat", "casual", "two_cat"])))
            a = float(np.clip(self.drift * (day - self.user_start_day) / 14.0, 0.0, self.drift))
            t = (1 - a) * t + a * alt
        return t

    def _session_key(self, now: float) -> tuple:
        day = int(now // C.DAY)
        hour = now - day * C.DAY
        return day, int(np.argmin([abs(hour - h) for h in C.SESSION_HOURS]))

    def mood(self, p: Persona, now: float) -> tuple:
        """(per-subtopic offset, taste gain) for the session that contains `now` (third world only)."""
        key = (p.seed,) + self._session_key(now)
        m = self._mood.get(key)
        if m is None:
            r = np.random.default_rng([p.seed, 32, key[1], key[2]])
            off = self.mood_sd * r.normal(size=N_SUB)
            g = float(np.clip(1.0 + self.session_gain_sd * r.normal(), 0.2, 1.8))
            m = self._mood[key] = (off, g)
        return m

    def session_slots(self, p: Persona, day: int) -> tuple:
        """Which of the day's three session times the persona uses (random per day in a bursty world)."""
        if not self.bursty:
            return p.slots
        r = np.random.default_rng([p.seed, 34, day])
        if r.random() > 0.55:
            return ()
        n = int(r.choice([1, 2, 3], p=[0.4, 0.3, 0.3]))
        return tuple(sorted(r.choice(3, n, replace=False).tolist()))

    def z(self, p: Persona, rows: np.ndarray, now: float, with_noise: bool = True) -> np.ndarray:
        """Hidden appeal score of each card for the persona at `now`."""
        cat = self.catalog
        taste = self.taste_of(p, now / C.DAY)
        if self.mood_sd > 0 or self.session_gain_sd > 0:
            off, g = self.mood(p, now)
            taste = g * taste + off
        topic = self.taste_scale * (self.L[rows] @ taste)
        age = np.maximum(now - cat.sort_at[rows], 0)
        z = (topic + p.src_pref[cat.src[rows]] + p.typ_pref[cat.typ[rows]]
             + p.imp_scale * 0.3 * np.log2(cat.importance[rows]) / 3 - 0.8 * np.minimum(age / 48.0, 1.5) + p.bias)
        if with_noise:
            z = z + self.noise_mult * p.noise_sd * self._draws(p)[0][rows]
        return z

    def probs(self, p: Persona, rows: np.ndarray, now: float, exam: np.ndarray | float = 1.0):
        """(z, p_like, p_dislike, p_detail, p_source, p_skip, completion); exam = chance the card is examined."""
        z = self.z(p, rows, now)
        pl = exam * p.like_prop * sigmoid(2.2 * (z - 0.9))
        pdis = p.dis_prop * sigmoid(-2.4 * (z + 0.6))
        pdet = exam * p.curiosity * sigmoid(2.0 * (z - 1.1))
        psrc = 0.35 * exam * p.curiosity * sigmoid(2.0 * (z - 1.0))
        pskip = p.skip_prop * sigmoid(-2.2 * (z - 0.1))
        comp = 0.25 + 0.9 * sigmoid(1.5 * (z - 0.5))
        return z, np.clip(pl, 0, 1), np.clip(pdis, 0, 1), np.clip(pdet, 0, 1), np.clip(psrc, 0, 1), np.clip(pskip, 0, 1), comp

    def gain(self, p: Persona, rows: np.ndarray, now: float) -> np.ndarray:
        """Ground-truth value of showing each card at slot 0 (used ONLY to grade rankings)."""
        z, pl, pdis, pdet, psrc, pskip, comp = self.probs(p, rows, now)
        return np.clip(pl + 0.5 * pdet + 0.25 * (1 - pskip) * comp - 0.5 * pdis, 0, None)

    def expected(self, p: Persona, rows: np.ndarray, now: float):
        """Expected (p_like, p_dislike, p_detail, dwell_ms) at slot 0 (grading only)."""
        z, pl, pdis, pdet, psrc, pskip, comp = self.probs(p, rows, now)
        words = self.catalog.words[rows]
        dwell = (1 - pskip) * comp * words * p.ms_per_word + pskip * 900.0
        return pl, pdis, pdet, dwell

    def behave(self, p: Persona, row: int, pos: int, now: float):
        """One impression at session position `pos`. Returns (events, outcome dict)."""
        draws = self._draws(p)
        u = draws[1][row]
        exam = (0.5 ** (pos / 5.0)) if self.pos_form == "exp" else 1.0 / (1.0 + self.pos_decay * pos)   # position bias
        z, pl, pdis, pdet, psrc, pskip, comp = (float(a[0]) for a in self.probs(p, np.array([row]), now, exam))
        words = float(self.catalog.words[row])
        ev: list[tuple[str, Optional[float]]] = [("view", None)]
        disliked = u[1] < pdis
        liked = (not disliked) and u[0] < pl
        if self.mistap > 0:
            mt = np.random.default_rng([p.seed, 15, row]).random(2)
            if mt[0] < self.mistap:                               # accidental tap, unrelated to the card
                liked, disliked = (mt[1] < 0.5), (mt[1] >= 0.5)
        detail = (not disliked) and u[2] < pdet
        src = (not disliked) and u[3] < psrc
        if disliked: ev.append(("dislike", None))
        if liked: ev.append(("like", None))
        if detail: ev.append(("open_detail", None))
        if src: ev.append(("open_source", None))
        skipped = (disliked or u[4] < pskip) and not (liked or detail or src)
        if u[5] < WALKAWAY_P:
            ms = 130000.0 + 60000.0 * u[4]                    # walked away
        elif skipped:
            ms = 300.0 + 1100.0 * u[3]
        else:
            ms = max(comp * np.exp(0.25 * draws[2][row]) * words * p.ms_per_word, 1600.0)
        ev.append(("dwell", float(ms)))
        return ev, dict(like=liked, dislike=disliked, detail=detail, src=src, dwell=float(ms), skipped=skipped, z=z)

    def stop_prob(self, p: Persona, z: float) -> float:
        """Chance the session ends after a card of appeal z (boring cards end sessions sooner)."""
        return float(np.clip((0.03 + 0.10 * (1.0 - sigmoid(1.5 * z))) * p.patience, 0.01, 0.4))
