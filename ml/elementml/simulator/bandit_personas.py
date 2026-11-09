"""Six named reader types for the ranking v2 evaluation (simulator only; hidden from every ranker).

Input: a seed, a split label and a type name. Output: a Persona whose hidden taste is set by hand over the
36 synthetic subtopics, with behaviour knobs (like / dislike tendencies, reading speed, patience) drawn the
usual way by make_persona. Only `follows` is visible to a ranker.

    rates_markets     student who reads markets, bonds, the Fed, inflation and jobs; follows markets
    tech_reader       AI, cyber, gadgets, IPOs, software earnings; follows tech
    skimmer           mildly likes almost everything (the existing skimmer taste); no follows
    anti_macro        "anti-macro sports fan": there is no sports topic in the synthetic catalog, so this reader
                      loves world news, science and safety stories and actively dislikes markets, economy,
                      Fed and savings stories; no follows
    taste_changer     a tech reader who switches to energy and deals halfway through; follows tech
    cold_two_follows  a casual reader who follows their two strongest topics at sign-up
"""
from __future__ import annotations

import numpy as np

from .. import config as C
from ..data.generator import SUB_CAT, SUBTOPICS
from .personas import Persona, _taste, make_persona

TYPES = ["rates_markets", "tech_reader", "skimmer", "anti_macro", "taste_changer", "cold_two_follows"]
MACRO_SUBS = {("markets", "indexes"), ("markets", "bonds"), ("economy", "jobs"), ("economy", "inflation"),
              ("economy", "housing"), ("policy", "fedpolicy"), ("personal-finance", "savings")}
MACRO_IDX = np.array([i for i, s in enumerate(SUBTOPICS) if s in MACRO_SUBS])
IS_MACRO = np.isin(np.arange(len(SUBTOPICS)), MACRO_IDX)


def _set(t: np.ndarray, spec: dict, rng: np.random.Generator) -> np.ndarray:
    for key, (lo, hi) in spec.items():
        if ":" in key:
            c, s = key.split(":")
            idx = [i for i, x in enumerate(SUBTOPICS) if x == (c, s)]
        else:
            idx = [i for i, x in enumerate(SUBTOPICS) if x[0] == key]
        t[idx] = rng.uniform(lo, hi, len(idx))
    return t


def make_typed(seed: int, split: str, typ: str) -> Persona:
    """A persona of one of the six TYPES (seeded)."""
    rng = np.random.default_rng([seed, 71])
    beh = "skimmer" if typ == "skimmer" else "casual"
    p = make_persona(seed, split, shift=False, kind=beh)
    base = np.clip(rng.normal(-0.3, 0.3, len(SUBTOPICS)), -1.0, 0.3)
    p.taste2, p.shift_day = None, None
    if typ == "rates_markets":
        p.taste = _set(base, {"markets:indexes": (1.4, 1.8), "markets:bonds": (1.5, 1.9), "policy:fedpolicy": (1.5, 1.9),
                              "economy:inflation": (1.3, 1.7), "economy:jobs": (1.1, 1.5), "personal-finance:savings": (0.8, 1.2),
                              "earnings:banks": (0.6, 1.0)}, rng)
        p.follows = ["markets"]
    elif typ in ("tech_reader", "taste_changer"):
        p.taste = _set(base, {"tech": (1.4, 1.9), "deals:ipo": (0.7, 1.1), "earnings:software": (0.8, 1.2),
                              "science:space": (0.4, 0.8)}, rng)
        p.follows = ["tech"]
        if typ == "taste_changer":
            p.taste2 = _set(np.clip(rng.normal(-0.3, 0.3, len(SUBTOPICS)), -1.0, 0.3),
                            {"energy": (1.4, 1.8), "deals": (1.2, 1.6)}, rng)
    elif typ == "skimmer":
        p.taste = _taste(rng, "skimmer")
        p.follows = []
    elif typ == "anti_macro":
        t = np.clip(rng.normal(0.0, 0.25, len(SUBTOPICS)), -0.6, 0.4)
        t = _set(t, {"world": (1.2, 1.6), "science": (1.1, 1.5), "safety": (0.7, 1.1)}, rng)
        t[IS_MACRO] = rng.uniform(-1.6, -1.1, IS_MACRO.sum())
        p.taste = t
        p.follows = []
    elif typ == "cold_two_follows":
        p.taste = _taste(rng, "casual")
        mass = np.array([np.clip(p.taste[SUB_CAT == c], 0, None).sum() for c in range(len(C.CATEGORIES))])
        p.follows = [C.CATEGORIES[i] for i in np.argsort(-mass)[:2]]
    else:
        raise KeyError(typ)
    p.kind = typ
    p.id = f"{split}-{typ}-{seed}"
    return p


def cohort(base_seed: int, split: str, per_type: int) -> list[Persona]:
    """per_type readers of every type, seeds base_seed + 0, 1, ..."""
    out, k = [], 0
    for i in range(per_type):
        for typ in TYPES:
            out.append(make_typed(base_seed + k, split, typ))
            k += 1
    return out
