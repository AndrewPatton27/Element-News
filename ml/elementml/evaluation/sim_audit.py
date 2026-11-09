"""Simulator fairness audit: does the simulated ground truth hand the formula an unfair head start?

Input: a world name and seeds. Output: a dict of numbers (printed by `python -m elementml.cli sim-audit`).
Evaluation only: it reads the hidden taste and latents, so no ranker may import it.

What it measures, for every v2 test reader at one fixed moment (day 5, noon, nothing seen yet):
  * NDCG@10 of fixed orderings against the true gains of the fresh pool:
      random, rank_score alone (importance x recency), true topic alone, the formula with follows only,
      rank_score + the reader's TRUE topic term in hours (a perfect taste learner on top of the base),
      and the noise-free hidden score (the best any ranker without per-card luck could do).
  * How much of the spread of the hidden score comes from parts the base already encodes
    (importance and age) versus the reader's taste, source and type preferences.
  * Correlation between card importance and how much each reader type truly likes the card.
"""
from __future__ import annotations

import numpy as np

from .. import config as C
from ..features.uservec import UserState
from ..ranking.baselines import CurrentServer
from ..simulator import ndcg_at
from ..simulator.bandit_personas import TYPES, cohort
from ..training.train import EVAL_PERSONA_BASE
from .bandit_eval import DIMS, _world
from .harness import WORLDS

HOURS_PER_Z = 0.8 / 48.0   # the hidden score loses 0.8 per 48 h of age: 1 unit of z = 60 h of freshness


def audit(world_name: str = "normal", seeds=(1, 2, 3), per_type: int = 10, days: int = 14) -> dict:
    acc: dict[str, list] = {k: [] for k in ("random", "base", "topic", "formula_cold", "base_plus_true_topic",
                                            "z_no_noise", "z_with_noise")}
    var_parts = {"importance_age": [], "taste_topic": [], "src_typ": [], "noise": []}
    corr_imp: dict[str, list] = {t: [] for t in TYPES}
    for seed in seeds:
        world, cat = _world(9000 + seed, days, WORLDS[world_name])
        people = cohort(EVAL_PERSONA_BASE + 50000 + seed * 1000, "test", per_type)
        now = (world.user_start_day + 5) * C.DAY + 12.0
        pool = cat.fresh_rows(now)
        rng = np.random.default_rng(seed)
        srv = CurrentServer(cat)
        for p in people:
            g = world.gain(p, pool, now)
            taste = world.taste_of(p, now / C.DAY)
            topic = world.taste_scale * (world.L[pool] @ taste)
            base = cat.base[pool] - now
            z0 = world.z(p, pool, now, with_noise=False)
            z1 = world.z(p, pool, now, with_noise=True)
            age = np.maximum(now - cat.sort_at[pool], 0)
            ia = p.imp_scale * 0.3 * np.log2(cat.importance[pool]) / 3 - 0.8 * np.minimum(age / 48.0, 1.5)
            st = p.src_pref[cat.src[pool]] + p.typ_pref[cat.typ[pool]]
            var_parts["importance_age"].append(ia.var()); var_parts["taste_topic"].append(topic.var())
            var_parts["src_typ"].append(st.var()); var_parts["noise"].append((z1 - z0).var())

            def nd(score):
                return ndcg_at(g[np.argsort(-score, kind="stable")], g)
            acc["random"].append(nd(rng.random(len(pool))))
            acc["base"].append(nd(base))
            acc["topic"].append(nd(topic))
            acc["base_plus_true_topic"].append(nd(base + topic / HOURS_PER_Z))
            acc["z_no_noise"].append(nd(z0))
            acc["z_with_noise"].append(nd(z1))
            stt = UserState(p.id, DIMS, follows=p.follows, now=now - 1.0)
            order = srv.rank(stt, pool, now, None)
            pos = {int(r): i for i, r in enumerate(order)}
            acc["formula_cold"].append(nd(-np.array([pos.get(int(r), 10**6) for r in pool], dtype=float)))
            corr_imp[p.kind].append(float(np.corrcoef(np.log2(cat.importance[pool]), topic)[0, 1]))
    out = {"ndcg10_at_cold_start": {k: round(float(np.mean(v)), 3) for k, v in acc.items()},
           "z_variance_share": {k: round(float(np.mean(v) / sum(np.mean(x) for x in var_parts.values())), 3)
                                for k, v in var_parts.items()},
           "corr_log_importance_vs_true_topic": {t: round(float(np.nanmean(v)), 3) for t, v in corr_imp.items()},
           "hours_per_unit_z": round(1 / HOURS_PER_Z, 1)}
    return out
