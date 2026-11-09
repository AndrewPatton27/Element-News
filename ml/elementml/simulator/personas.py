"""Simulated readers: hidden-taste personas (evaluation and training only, never seen by a ranker).

Input: a seed, a split label ("train" / "test" / ...), whether the taste shifts mid-run, optionally a kind.
Output: a Persona with a hidden taste over the 36 subtopics, source and type preferences, reading speed,
like / dislike / curiosity / skip tendencies, noise, patience, session slots and onboarding follows.
Why: real readers do not exist yet. Five kinds: picky-subtopic 25%, picky-category 15%, casual 30%,
skimmer 15%, two-category 15%. Only `follows` is ranker-visible (as onboarding topics would be).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .. import config as C
from ..data.generator import N_SUB, SUB_CAT

KINDS = ["picky_sub", "picky_cat", "casual", "skimmer", "two_cat"]
KIND_P = [0.25, 0.15, 0.30, 0.15, 0.15]


@dataclass
class Persona:
    """One simulated reader. Everything except id and follows is hidden from the rankers."""
    id: str
    kind: str
    seed: int
    taste: np.ndarray                      # hidden, N_SUB
    taste2: Optional[np.ndarray]           # taste after the shift
    shift_day: Optional[int]
    src_pref: np.ndarray                   # over C.SOURCES
    typ_pref: np.ndarray                   # over C.EVENT_TYPES
    bias: float
    imp_scale: float
    ms_per_word: float
    like_prop: float
    dis_prop: float
    curiosity: float
    skip_prop: float
    noise_sd: float
    patience: float
    slots: tuple
    offset: float
    follows: list = field(default_factory=list)       # onboarding follows (ranker-visible)


def _taste(rng: np.random.Generator, kind: str) -> np.ndarray:
    """A hidden taste vector over the subtopics for one persona kind."""
    t = np.zeros(N_SUB)
    if kind == "picky_sub":
        t = np.clip(rng.normal(-0.4, 0.35, N_SUB), -1.2, 0.3)
        t[rng.choice(N_SUB, 2, replace=False)] = rng.uniform(1.5, 2.0, 2)
    elif kind == "picky_cat":
        t = np.clip(rng.normal(-0.3, 0.3, N_SUB), -1.0, 0.3)
        c = rng.integers(len(C.CATEGORIES))
        t[SUB_CAT == c] = rng.uniform(1.3, 1.8, 3)
    elif kind == "casual":
        t = rng.normal(-0.1, 0.3, N_SUB)
        t[rng.choice(N_SUB, 9, replace=False)] = rng.uniform(0.7, 1.2, 9)
    elif kind == "skimmer":
        t = rng.normal(0.5, 0.35, N_SUB)
    elif kind == "two_cat":
        t = np.clip(rng.normal(-0.2, 0.3, N_SUB), -0.8, 0.3)
        for c in rng.choice(len(C.CATEGORIES), 2, replace=False):
            t[SUB_CAT == c] = rng.uniform(0.8, 1.3, 3)
    return t


def make_persona(seed: int, split: str, shift: bool = False, kind: Optional[str] = None) -> Persona:
    """A seeded persona. shift=True draws a second, clearly different taste (taste2);
    the caller sets shift_day. Follows are drawn from the strongest categories."""
    rng = np.random.default_rng(seed)
    kind = kind or rng.choice(KINDS, p=KIND_P)
    taste = _taste(rng, kind)
    taste2 = None
    if shift:
        for _ in range(30):
            k2 = rng.choice(["picky_sub", "picky_cat", "casual", "two_cat"])
            cand = _taste(rng, k2)
            a, b = np.clip(taste, 0, None), np.clip(cand, 0, None)
            if a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9) < 0.15:
                taste2 = cand
                break
        if taste2 is None:
            taste2 = np.roll(taste, 13)
    base = {"picky_sub": (-0.3, 0.55), "picky_cat": (-0.3, 0.5), "casual": (-0.5, 0.3),
            "skimmer": (-0.4, 0.2), "two_cat": (-0.4, 0.4)}[kind]
    n_slots = int(rng.choice([1, 2, 3], p=[0.25, 0.5, 0.25]))
    persona = Persona(
        id=f"{split}-{seed}", kind=kind, seed=seed, taste=taste, taste2=taste2,
        shift_day=None, src_pref=rng.normal(0, 0.25, len(C.SOURCES)), typ_pref=rng.normal(0, 0.2, len(C.EVENT_TYPES)),
        bias=base[0], imp_scale=float(rng.uniform(0.5, 1.5)), ms_per_word=float(rng.uniform(110, 260)),
        like_prop=float(rng.uniform(0.6, 1.0) if kind != "skimmer" else rng.uniform(0.9, 1.2)),
        dis_prop=base[1] * float(rng.uniform(0.6, 1.2)), curiosity=float(rng.uniform(0.5, 1.2)),
        skip_prop=float(rng.uniform(0.7, 1.0)), noise_sd=float(rng.uniform(0.25, 0.7)),
        patience=float(rng.uniform(0.6, 1.4)), slots=tuple(sorted(rng.choice(3, n_slots, replace=False).tolist())),
        offset=float(rng.uniform(-0.5, 0.5)))
    mass = np.array([np.clip(taste[SUB_CAT == c], 0, None).sum() for c in range(len(C.CATEGORIES))])
    order = list(np.argsort(-mass))
    nf = int(rng.choice([0, 1, 2], p=[0.4, 0.4, 0.2]))
    for i in range(nf):
        c = order[i] if rng.random() > 0.25 else int(rng.integers(len(C.CATEGORIES)))
        if C.CATEGORIES[c] not in persona.follows:
            persona.follows.append(C.CATEGORIES[c])
    return persona
