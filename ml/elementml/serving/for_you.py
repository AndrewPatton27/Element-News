"""The assembled For you ranker: `rank_for_you(user_state, candidate_cards, ranker, embedder)`.

Input: one reader's UserState (built from their events, follows and hides), the candidate Cards, a
Ranker (trained heads + a Variant switch set) and the fitted Embedder. Output: `Ranked(id, score, why)`
for every eligible card, best first, with a one-sentence reason for the first 20.

Pipeline: eligible (not seen / disliked / hidden) -> stage 1 candidates -> features -> LightGBM heads ->
expected utility -> MMR diversity -> exploration slots. Deterministic: same inputs, same output.
The head of the list is the reranked candidates; the tail is every other eligible card by base score,
so the result is a permutation of the eligible cards (keyset paging can run over it as-is).
Nothing here imports the simulator.

On the website this is meant to run only offline, in shadow mode: an hourly laptop job (the next step,
not built yet) replays logged pages through it and writes the would-have-ranked scores back to Postgres;
readers are still served by the SQL formula. Reader-state ablations (follow prior, fixed step) are set
where states are created (evaluation/policies.py state_factory), not here.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .. import config as C
from .. import features as F
from ..data.cards import Card
from ..data.catalog import Catalog
from ..features.crowd import CrowdTables
from ..features.embed import Embedder
from ..features.uservec import UserState
from ..ranking import diversity
from ..ranking.candidates import candidates, eligible_rows
from ..ranking.heads import Heads
from ..ranking.utility import Weights, utility

TOP_WHY = 20                    # cards that get a personal "why" sentence; the rest say "Fresh and important"
TIE_BREAK_BASE = 1e-6           # vectors-only order: ties broken by the base score


@dataclass
class Variant:
    """Switches for one ranking method (the defaults are the original full pipeline, e_full)."""
    name: str = "full"
    use_gbdt: bool = True
    use_mmr: bool = True
    use_explore: bool = True
    weights: Weights = field(default_factory=Weights)
    tag: str = "full"                        # model file tag (which trained head set; informational here)
    gate_k: Optional[float] = None           # hardening: blend toward the server formula, g = e / (e + gate_k)
    gate_pool: int = 40                      # with the gate, the server formula's top cards join the candidates
    vec_base_w: float = 0.0                  # vectors-only: add w * clip(base_rel / 24 h, -1.5, 1) (importance + freshness)
    vec_score: str = "cos"                   # vectors-only score: "cos" (cosine to the reader vector) or "rls"


def pct_rank(x: np.ndarray) -> np.ndarray:
    """Percentile rank in [0, 1] (ties broken by position, so the result is deterministic)."""
    n = len(x)
    if n <= 1:
        return np.zeros(n)
    r = np.empty(n)
    r[np.argsort(x, kind="stable")] = np.arange(n)
    return r / (n - 1)


def evidence_gate(state: UserState, k: float) -> float:
    """Share of the order that comes from the ML score: g = e / (e + k), e = explicit events (likes,
    dislikes, detail and source taps). With no evidence the order is the server formula's; it hands over
    smoothly as evidence builds. k is fitted on validation worlds (never on the test seeds)."""
    if k <= 0:
        return 1.0
    e = float(state.n_strong)
    return e / (e + k)


@dataclass
class Ranked:
    """One ranked card: its id, its utility (nan for the tail) and the reason shown to the reader."""
    id: str
    score: float
    why: str


class Ranker:
    """Stage 1 -> features -> heads -> utility -> MMR -> exploration, configured by a Variant."""

    def __init__(self, heads: Optional[Heads], variant: Variant | None = None):
        self.heads, self.v = heads, variant or Variant()

    # ---- on catalog rows (fast path, used by the simulator and evaluation) -------------
    def rank_rows(self, state: UserState, cat: Catalog, rows: np.ndarray, now: float, crowd: CrowdTables | None,
                  with_info: bool = False):
        """Ordered catalog rows (a permutation of the eligible rows). with_info also returns the
        intermediate arrays (candidates, features, utility, predictions, flagged rows) for the "why"."""
        state.advance(now)
        elig = eligible_rows(state, cat, rows)
        if len(elig) == 0:
            return (elig, {}) if with_info else elig
        cands = candidates(state, cat, elig)
        aff = state.affinity(now)
        g = 1.0
        if self.v.gate_k is not None:
            s_all = self._server.raw_scores(state, elig, now, crowd, aff) if hasattr(self, "_server") else None
            if s_all is None:
                from ..ranking.baselines import CurrentServer
                self._server = CurrentServer(cat)
                s_all = self._server.raw_scores(state, elig, now, crowd, aff)
            top = elig[np.argsort(-s_all, kind="stable")[:self.v.gate_pool]]
            cands = np.concatenate([cands, top[~np.isin(top, cands)]]).astype(int)
            s_of = dict(zip(elig.tolist(), s_all.tolist()))
            S_c = np.array([s_of[int(r)] for r in cands])
            g = evidence_gate(state, self.v.gate_k)
        X = F.build(state, cat, cands, now, crowd, aff, position=0.0)
        if self.v.use_gbdt and self.heads is not None:
            pred = self.heads.predict(X)
            U = utility(pred, X[:, F.NAMES.index("base_rel")], self.v.weights)
        else:                                              # vectors only: cosine, ties by base score
            pred = {}
            U = X[:, F.NAMES.index("cos_user" if self.v.vec_score == "cos" else "rls_score")] + TIE_BREAK_BASE * cat.base[cands]
            if self.v.vec_base_w:
                U = U + self.v.vec_base_w * np.clip(X[:, F.NAMES.index("base_rel")] / C.DAY, -1.5, 1.0)
        if self.v.gate_k is not None:
            U = g * pct_rank(U) + (1.0 - g) * pct_rank(S_c)
        order = np.argsort(-U, kind="stable")
        flagged: set = set()
        if self.v.use_mmr:
            order = diversity.mmr(order, U, cat.emb[cands])
        if self.v.use_explore and state.n_ev >= C.EXPLORE_MIN_EVENTS:
            order, flagged = diversity.explore_slots(order, U, X[:, F.NAMES.index("unc_card")])
        head = cands[order]
        rest = elig[~np.isin(elig, head)]
        rest = rest[np.argsort(-cat.base[rest], kind="stable")]
        out = np.concatenate([head, rest]).astype(int)
        if not with_info:
            return out
        return out, dict(cands=cands, X=X, U=U, pred=pred, order=order, flagged={int(cands[i]) for i in flagged}, aff=aff)

    # ---- public API on Card objects ----------------------------------------------------
    def rank_cards(self, state: UserState, cards: list[Card], embedder: Embedder, now: float | None = None,
                   crowd: CrowdTables | None = None, top_why: int = TOP_WHY) -> list[Ranked]:
        """Rank Card objects (builds a Catalog first). `now` defaults to just after the newest card."""
        cat = Catalog.build(cards, embedder)
        now = float(max(c.sort_at for c in cards)) + 0.01 if now is None else now
        rows = np.arange(cat.n)
        out, info = self.rank_rows(state, cat, rows, now, crowd, with_info=True)
        ranked = []
        pos_of = {int(r): i for i, r in enumerate(info["cands"])} if info else {}
        for i, r in enumerate(out):
            r = int(r)
            why = self.why(state, cat, r, info, pos_of) if i < top_why and info else "Fresh and important"
            score = float(info["U"][pos_of[r]]) if info and r in pos_of else float("nan")
            ranked.append(Ranked(cat.cards[r].id, score, why))
        return ranked

    def why(self, state: UserState, cat: Catalog, r: int, info: dict, pos_of: dict) -> str:
        """One sentence for row r, from the first rule that fires (exploration, follow, similar, habits, major)."""
        c = cat.cards[r]
        if r in info["flagged"]:
            return "Something new, to learn what you like"
        i = pos_of.get(r)
        if i is None:
            return "Fresh and important"
        x = dict(zip(F.NAMES, info["X"][i]))
        if c.category in state.follows and x["cos_user"] > 0.2:
            return f"You follow {c.category}"
        if x["max_cos_liked"] >= 0.6:
            return "Similar to stories you liked"
        if x["src_aff"] >= 0.3 and c.source:
            return f"You often open {c.source.upper()} stories"
        if x["cat_aff"] >= 0.5:
            return f"You often engage with {c.category}"
        if x["imp_log2"] >= 3.3:
            return "Major story right now"
        return "Fresh and important"


def rank_for_you(user_state: UserState, candidate_cards: list[Card], ranker: Ranker, embedder: Embedder,
                 now: float | None = None, crowd: CrowdTables | None = None) -> list[Ranked]:
    """Ordered ids with a short why for each of the first 20. Eligible cards only (seen, disliked and hidden are dropped)."""
    return ranker.rank_cards(user_state, candidate_cards, embedder, now, crowd)
