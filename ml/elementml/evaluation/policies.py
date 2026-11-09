"""Method wiring: every ranking method the evaluation compares, by name, plus the training-log policy mix.

Input: a method name (for example "a1_current_server", "e_full", "h_full", "d+rls+base:0.2"), the Catalog
and the loaded models (Bundle). Output: (policy_for(persona) -> Policy, state_factory(persona, now) -> UserState).
Why: one place maps the names used in results files and docs to concrete Ranker / baseline settings.

A method = (policy_for(persona) -> Policy, state_factory(persona, now) -> UserState). The state factory builds the
user state the same way for every method (follows -> cold-start prior), except the ablations that switch it.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Callable

import numpy as np

from ..data.catalog import Catalog
from ..features.embed import Embedder
from ..features.uservec import UserState, VecCfg, make_prior
from ..interfaces import Policy
from ..paths import MODELS
from ..ranking.baselines import CurrentDevice, CurrentServer, Popularity, RecencyImportance, _unseen_filter
from ..ranking.heads import Heads
from ..ranking.utility import Weights
from ..serving.for_you import Ranker, Variant

if TYPE_CHECKING:                                     # type name only: this module never imports the simulator
    from ..simulator.personas import Persona

# head-set tag -> feature groups left out when it was trained (models/<tag>.*.txt)
TAGS = {"full": None, "no_crowd": ("crowd",), "no_vec": ("vec",), "no_aff": ("aff",), "no_pos": ("pos",)}


class RankerPolicy(Policy):
    """A Ranker on catalog rows, as the simulator calls it."""

    def __init__(self, ranker: Ranker, cat: Catalog, name: str):
        self.ranker, self.cat, self.name = ranker, cat, name

    def rank(self, state, rows, now, crowd):
        return self.ranker.rank_rows(state, self.cat, rows, now, crowd)


class RandomPolicy(Policy):
    """Uniform over the eligible fresh cards: gives the training logs coverage (like an exploration arm)."""
    name = "random"

    def __init__(self, cat: Catalog, seed: int):
        self.cat, self.rng = cat, np.random.default_rng(seed)

    def rank(self, state, rows, now, crowd):
        e = _unseen_filter(state, self.cat, rows, True)
        return e[self.rng.permutation(len(e))]


class MixedPolicy(Policy):
    """Training-log policy: each page is served by one of several rankers, chosen at random
    (30% server formula, 20% vectors only, 15% recency, 35% uniform random). `last_arm` names the one used."""
    name = "logging_mix"

    def __init__(self, cat: Catalog, embedder: Embedder, seed: int):
        self.rng = np.random.default_rng(seed)
        vec = Ranker(None, Variant("vec", use_gbdt=False, use_mmr=False, use_explore=False))
        self.arms = [(0.30, CurrentServer(cat)), (0.20, RankerPolicy(vec, cat, "vec")),
                     (0.15, RecencyImportance(cat)), (0.35, RandomPolicy(cat, seed + 1))]

    def rank(self, state, rows, now, crowd):
        r = self.rng.random()
        acc = 0.0
        for p, pol in self.arms:
            acc += p
            if r < acc:
                self.last_arm = getattr(pol, "name", "?")
                return pol.rank(state, rows, now, crowd)
        self.last_arm = getattr(self.arms[-1][1], "name", "?")
        return self.arms[-1][1].rank(state, rows, now, crowd)


def state_factory(embedder: Embedder, use_prior: bool = True, static_step: bool = False, n_cap=None,
                  vcfg: VecCfg | None = None) -> Callable[[Persona, float], UserState]:
    """Builds a reader's starting state (follow prior, step and vector settings) the same way for every method."""
    def make(p: Persona, now: float) -> UserState:
        prior = make_prior(embedder, p.follows) if use_prior else None
        return UserState(p.id, embedder.k, follows=p.follows, prior=prior, now=now, static_step=static_step, n_cap=n_cap,
                         vcfg=vcfg)
    return make


@dataclass
class Bundle:
    """A loaded model folder: the embedder and every head set found in it, by tag."""
    embedder: Embedder
    heads: dict[str, Heads]

    @staticmethod
    def load(models_dir: Path = MODELS) -> "Bundle":
        emb = Embedder.load(models_dir / "embedder.pkl")
        heads = {}
        for tag in TAGS:
            if (models_dir / f"{tag}.json").exists():
                heads[tag] = Heads.load(models_dir, tag)
        return Bundle(emb, heads)


# Original ablations of e_full: name -> Variant fields, plus tag / use_prior / static_step / n_cap for the state.
ABLATIONS = {
    "e_full": dict(),
    "e_no_gbdt": dict(use_gbdt=False),                       # vectors + MMR + exploration, ordered by cosine
    "e_no_mmr": dict(use_mmr=False),
    "e_no_explore": dict(use_explore=False),
    "e_no_crowd": dict(tag="no_crowd"),
    "e_no_vecfeat": dict(tag="no_vec"),
    "e_no_aff": dict(tag="no_aff"),
    "e_no_posfeat": dict(tag="no_pos"),                      # trained without the position column
    "e_no_time_term": dict(weights=Weights(time=0.0)),
    "e_no_base_term": dict(weights=Weights(base=0.0)),
    "e_time_high": dict(weights=Weights(time=1.0)),          # trade-off check: weight reading time more
    "e_static_step": dict(static_step=True),
    "e_no_prior": dict(use_prior=False),
}
EXTRA = {                                                    # tried, not in the default evaluation
    "e_cap8": dict(n_cap=8.0),                               # evidence cap: the step never shrinks below eta0/(1+8/tau)
    "e_cap16": dict(n_cap=16.0),
}
# ---- hardening ----------------------------------------------------------------------------
# User-vector update configurations tried on the validation worlds (seeds 11-13). "k*" = Kalman gain.
VCFGS = {
    "shrink": VecCfg(),
    "k1": VecCfg(update="kalman", p0=1.0, r=1.6, q_per_day=0.08),
    "k2": VecCfg(update="kalman", p0=1.0, r=3.0, q_per_day=0.08),
    "k3": VecCfg(update="kalman", p0=1.0, r=3.0, q_per_day=0.25),
    "k4": VecCfg(update="kalman", p0=1.0, r=5.0, q_per_day=0.15),
    "k2d": VecCfg(update="kalman", p0=1.0, r=3.0, q_per_day=0.08, dwell_mult=0.4),
    "k2n": VecCfg(update="kalman", p0=1.0, r=3.0, q_per_day=0.08, neg_mult=0.5),
    "k2h": VecCfg(update="kalman", p0=1.0, r=3.0, q_per_day=0.08, huber_cos=0.0),
    "k3d": VecCfg(update="kalman", p0=1.0, r=3.0, q_per_day=0.25, dwell_mult=0.4),
    "k3dn": VecCfg(update="kalman", p0=1.0, r=3.0, q_per_day=0.25, dwell_mult=0.4, neg_mult=0.5),
}


def parse_spec(name: str) -> dict:
    """Composable experiment names: '<base>+opt:val+...'.  base: d (vectors only) or e (full pipeline).
    Options: vc:<VCFGS key>, heads:<models subfolder>, gate:<k>, noexp, nommr, pool:<n>."""
    parts = name.split("+")
    spec = {"base": parts[0], "vc": "shrink", "heads": "", "gate": None, "explore": True, "mmr": True, "pool": 40, "base_w": 0.0, "score": "cos", "only": None}
    for t in parts[1:]:
        k, _, v = t.partition(":")
        if k == "vc": spec["vc"] = v
        elif k == "heads": spec["heads"] = v
        elif k == "gate": spec["gate"] = float(v)
        elif k == "pool": spec["pool"] = int(v)
        elif k == "base": spec["base_w"] = float(v)
        elif k == "rls": spec["score"] = "rls"
        elif k == "only": spec["only"] = v              # rank by one head alone: like | dislike | detail | time
        elif k == "noexp": spec["explore"] = False
        elif k == "nommr": spec["mmr"] = False
        elif k == "mmr": spec["mmr"] = True
        else: raise KeyError(t)
    return spec


# methods whose heads live in another models folder (hardening experiments): name -> subfolder of ml/models
MODEL_DIRS: dict[str, str] = {}


def models_dir_for(name: str, default: Path) -> Path:
    """The models folder a method's heads live in (a sub-folder for hardened methods, else `default`)."""
    sub = MODEL_DIRS.get(name)
    if sub is None and (name in HARDENED or "+" in name):
        sub = parse_spec(HARDENED.get(name, name))["heads"]
    return default / sub if sub else default


# Named hardened methods, fixed on validation seeds 11-13 (normal + stress) BEFORE any test-seed run (see ml.md "Hardening").
HARDENED: dict[str, str] = {
    "h_full": "e+heads:nr+noexp",         # heads: monotone + regularised + Platt-calibrated, RLS + server-score features; no explore slots
    "h_full_dr": "e+heads:hr+noexp",      # same, trained on domain-randomised worlds
    "d_hard": "d+rls+base:0.2",           # vectors only, hardened: RLS reader model + importance/freshness term, no GBDT
    "d_hard_cos": "d+base:0.25",          # simpler: cosine to the reader vector + importance/freshness term
    # each hardened head alone (no utility mix, no MMR, no exploration): how much does each head carry?
    "hx_like_only": "e+heads:nr+noexp+nommr+only:like",
    "hx_dislike_only": "e+heads:nr+noexp+nommr+only:dislike",
    "hx_detail_only": "e+heads:nr+noexp+nommr+only:detail",
    "hx_dwell_only": "e+heads:nr+noexp+nommr+only:time",
    # ablations of h_full (one change each)
    "h_with_explore": "e+heads:nr",
    "h_gate5": "e+heads:nr+noexp+gate:5",
    "h_ips": "e+heads:hr_ips+noexp",
    "h_no_rls": "e+heads:nr_norls+noexp",
    "h_no_srv": "e+heads:nr_nosrv+noexp",
    "h_no_monotone": "e+heads:nr_nomono+noexp",
    "h_no_calib": "e+heads:nr_nocalib+noexp",
}

BASELINES = ["a1_current_server", "a2_current_device", "b_recency_importance", "c_popularity", "d_vectors_only"]


def method(name: str, cat: Catalog, bundle: Bundle):
    """Returns (policy_for, state_factory) for a method name."""
    sf = state_factory(bundle.embedder)
    if name == "a1_current_server":
        pol = CurrentServer(cat)
    elif name == "a2_current_device":
        pol = CurrentDevice(cat)
    elif name == "b_recency_importance":
        pol = RecencyImportance(cat)
    elif name == "c_popularity":
        pol = Popularity(cat)
    elif name == "d_vectors_only":
        pol = RankerPolicy(Ranker(None, Variant("d", use_gbdt=False, use_mmr=False, use_explore=False)), cat, name)
    elif name in ABLATIONS or name in EXTRA:
        kw = dict((ABLATIONS | EXTRA)[name])
        tag = kw.pop("tag", "full")
        use_prior = kw.pop("use_prior", True)
        static = kw.pop("static_step", False)
        n_cap = kw.pop("n_cap", None)
        v = Variant(name, tag=tag, **kw)
        pol = RankerPolicy(Ranker(bundle.heads[tag], v), cat, name)
        sf = state_factory(bundle.embedder, use_prior=use_prior, static_step=static, n_cap=n_cap)
    elif "+" in name or name in HARDENED:
        sp = parse_spec(HARDENED.get(name, name))
        vcfg = VCFGS[sp["vc"]]
        if sp["base"] == "d":
            v = Variant(name, use_gbdt=False, use_mmr=sp["mmr"] and "+mmr" in name, use_explore=False, gate_k=sp["gate"],
                        gate_pool=sp["pool"], vec_base_w=sp["base_w"], vec_score=sp["score"])
            pol = RankerPolicy(Ranker(None, v), cat, name)
        elif sp["base"] == "e":
            w = Weights()
            if sp["only"]:
                w = Weights(like=0.0, time=0.0, detail=0.0, dislike=0.0, base=0.0)
                setattr(w, sp["only"], {"like": 1.0, "dislike": 1.0, "detail": 1.0, "time": 1.0}[sp["only"]])
            v = Variant(name, use_mmr=sp["mmr"], use_explore=sp["explore"], gate_k=sp["gate"], gate_pool=sp["pool"], weights=w)
            pol = RankerPolicy(Ranker(bundle.heads["full"], v), cat, name)
        else:
            raise KeyError(name)
        sf = state_factory(bundle.embedder, vcfg=vcfg)
    else:
        raise KeyError(name)
    return (lambda p, _pol=pol: _pol), sf
