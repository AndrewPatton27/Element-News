"""Running a cohort of simulated readers through a ranking method, day by day (the evaluation loop).

Input: a World, personas, policy_for(persona) -> Policy, state_factory(persona, now) -> UserState, the number
of days, and an optional logger (training uses it to record features and labels of every impression).
Output: {"sessions": per-session metric records, "states": final reader states, "ledger": the crowd ledger}.
Why "in the loop": the method's own pages decide what each reader sees next, as on the real site.
Session records include NDCG@10 of the first page against the true gains, expected and real like and
dislike rates, dwell, categories and repeats. Crowd tables are rebuilt at the end of each simulated day.
"""
from __future__ import annotations

from typing import Callable

import numpy as np

from .. import config as C
from ..features.crowd import CrowdLedger, CrowdTables
from ..features.uservec import UserState
from ..interfaces import Policy
from .personas import Persona
from .world import SESSION_SEEDS, World

MIN_CARDS_BEFORE_STOP = 5       # a session shows at least 5 cards


def ndcg_at(gains_ranked: np.ndarray, all_gains: np.ndarray, k: int = 10) -> float:
    """NDCG@k of a ranked list of true gains against the best possible order of all_gains."""
    disc = 1.0 / np.log2(np.arange(2, k + 2))
    g = gains_ranked[:k]
    dcg = float((g * disc[:len(g)]).sum())
    ideal = np.sort(all_gains)[::-1][:k]
    idcg = float((ideal * disc[:len(ideal)]).sum())
    return dcg / idcg if idcg > 0 else 0.0


def run_cohort(world: World, personas: list[Persona], policy_for: Callable[[Persona], Policy],
               state_factory: Callable[[Persona, float], UserState], days: int, logger=None) -> dict:
    """Simulate `days` days for a cohort. Returns per-session records, final states and the crowd ledger."""
    cat = world.catalog
    ledger = CrowdLedger(cat)
    crowd = CrowdTables.empty(cat.n)
    states = {}
    d0 = world.user_start_day
    for p in personas:
        states[p.id] = state_factory(p, d0 * C.DAY)
        ledger.follows[p.id] = list(p.follows)
    sessions = []
    last_top: dict[str, set] = {}
    sess_idx = {p.id: 0 for p in personas}
    for day in range(d0, d0 + days):
        for slot in range(3):
            for p in personas:
                if slot not in world.session_slots(p, day):
                    continue
                now = day * C.DAY + C.SESSION_HOURS[slot] + p.offset
                st = states[p.id]
                st.advance(now)
                pol = policy_for(p)
                si = sess_idx[p.id]; sess_idx[p.id] += 1
                pos, stopped, first = 0, False, True
                rec = dict(user=p.id, kind=p.kind, day=day - d0, now=now, n_cards=0, dwell_total=0.0,
                           likes10=0, impr10=0, dislikes10=0, shift=p.taste2 is not None)
                slot_dwell = np.zeros(C.PAGE_SIZE); slot_n = np.zeros(C.PAGE_SIZE)
                while pos < C.MAX_SESSION_CARDS and not stopped:
                    pool = cat.fresh_rows(now)
                    order = pol.rank(st, pool, now, crowd)
                    page = order[:C.PAGE_SIZE]
                    if len(page) == 0:
                        break
                    if first:
                        seen_, dis_ = st.seen_ids, st.disliked_ids
                        elig = np.array([r for r in pool if cat.cards[r].id not in seen_
                                         and cat.cards[r].id not in dis_], dtype=int)
                        g_all = world.gain(p, elig, now) if len(elig) else np.zeros(1)
                        g_top = world.gain(p, page, now)
                        pl, pdis, pdet, dw = world.expected(p, page, now)
                        pl_all = world.expected(p, elig, now)[0] if len(elig) else np.zeros(1)
                        rec["orc_like10"] = float(np.sort(pl_all)[::-1][:C.PAGE_SIZE].mean())
                        _, _, _, _, _, pskip, comp = world.probs(p, page, now)
                        rec.update(ndcg10=ndcg_at(g_top, g_all), exp_like10=float(pl.mean()), exp_dis10=float(pdis.mean()),
                                   exp_dwell10=float(dw.mean()), gain10=float(g_top.mean()),
                                   cats10=len({cat.cat[r] for r in page}), subs10=len({int(world.sub_main[r]) for r in page}),
                                   base10=float((cat.base[page] - now).mean()),
                                   n_strong=st.n_strong, ids10=set(int(r) for r in page))
                        rec["repeat"] = len(rec["ids10"] & last_top.get(p.id, set())) / len(page)
                        last_top[p.id] = rec["ids10"]
                        first = False
                    token = logger.before(st, page, now, crowd, pos) if logger else None
                    outs = []
                    for r in page:
                        card = cat.cards[r]
                        t_i = now + 0.002 * pos
                        ev, out = world.behave(p, int(r), pos, t_i)
                        st.observe(card, cat.emb[r], ev, t_i)
                        ledger.add(p.id, int(r), ev, t_i)
                        outs.append(out)
                        rec["n_cards"] += 1
                        if out["dwell"] <= C.DWELL_WALKAWAY_MS:
                            rec["dwell_total"] += out["dwell"]
                        if pos < C.PAGE_SIZE:
                            rec["impr10"] += 1; rec["likes10"] += out["like"]; rec["dislikes10"] += out["dislike"]
                            if out["dwell"] <= C.DWELL_WALKAWAY_MS:
                                slot_dwell[pos] += out["dwell"]; slot_n[pos] += 1
                        pos += 1
                        if world._draws(p)[3][si % SESSION_SEEDS][min(pos, C.MAX_SESSION_CARDS)] < world.stop_prob(p, out["z"]) and pos >= MIN_CARDS_BEFORE_STOP:
                            stopped = True
                            break
                    if logger:
                        logger.after(token, outs)
                rec["slot_dwell"], rec["slot_n"] = slot_dwell, slot_n
                sessions.append(rec)
        crowd = ledger.refresh((day + 1) * C.DAY)   # end-of-day crowd refresh (the live job runs about hourly)
    return dict(sessions=sessions, states=states, ledger=ledger)
