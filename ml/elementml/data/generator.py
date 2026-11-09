"""Synthetic card generator: 12 categories x 3 subtopics, each with its own vocabulary.

Input: a seed and a number of days. Output: (cards sorted by sort_at, latents).
Why: real reader data does not exist yet, so training and evaluation run on generated cards whose true
topic is known. `latents` (card id -> hidden topic mixture over the 36 subtopics) belongs to the
SIMULATOR ONLY: the Card record has no field for it and no ranker module reads it.

Realism knobs built in: 28% of stories mix two subtopics, 10% of category labels are deliberately
wrong, 7% of markets/economy cards are short data cards, and importance follows docs/RANKING.md.
"""
from __future__ import annotations

import random

import numpy as np

from .. import config as C
from .cards import Card, importance_of

# category -> (category words, {subtopic: subtopic words})
LEX = {
    "markets": ("stocks shares traders rally selloff investors volatility session benchmark futures".split(),
                {"indexes": "nasdaq dow index benchmark rally correction".split(),
                 "bonds": "treasury yield bonds auction curve duration".split(),
                 "crypto": "bitcoin ether token exchange wallet miners".split()}),
    "earnings": ("quarter revenue profit guidance analysts results margin outlook eps beat".split(),
                 {"retail": "stores shoppers comparable sales holiday inventory".split(),
                  "banks": "lenders deposits loans provisions interest income".split(),
                  "software": "subscriptions cloud bookings renewals seats churn".split()}),
    "economy": ("economy growth output households consumers data release monthly report officials".split(),
                {"jobs": "payrolls unemployment hiring wages workers openings".split(),
                 "inflation": "prices cpi inflation shelter groceries core".split(),
                 "housing": "mortgage homes sales builders rents starts".split()}),
    "policy": ("policy regulators rule agency committee statement officials proposal law hearing".split(),
               {"fedpolicy": "fomc rates chair federal reserve cut hike".split(),
                "tax": "tax irs deduction credit treasury filing".split(),
                "trade": "tariffs trade imports exports customs deal".split()}),
    "tech": ("technology company platform users product launch engineers startup data devices".split(),
             {"ai": "ai models chips training inference gpu".split(),
              "cyber": "breach hackers ransomware security patch vulnerability".split(),
              "consumer": "smartphone app headset streaming wearable update".split()}),
    "deals": ("deal acquisition agreement board shareholders offer combined transaction terms close".split(),
              {"mergers": "merger acquire premium stock buyout antitrust".split(),
               "ipo": "ipo listing debut underwriters pricing valuation".split(),
               "privateeq": "buyout private equity fund sponsor debt takeover".split()}),
    "energy": ("energy supply demand producers barrels output prices utilities grid power".split(),
               {"oil": "crude opec barrels refinery drilling brent".split(),
                "renew": "solar wind battery turbines storage subsidies".split(),
                "gas": "natural gas lng pipeline storage winter heating".split()}),
    "insider": ("insider executive director filing form shares transaction reported officer holdings".split(),
                {"buys": "purchase bought acquired stake open market confidence".split(),
                 "sells": "sold sale plan tenb1 disposed proceeds".split(),
                 "options": "options exercised grant vesting awards exercise".split()}),
    "personal-finance": ("savers households family budget account consumers money advice rates card".split(),
                         {"savings": "savings apy deposit cds emergency interest".split(),
                          "credit": "credit card debt score borrowing delinquency".split(),
                          "retire": "retirement ira pension social security benefits contribution".split()}),
    "world": ("government leaders country officials international region talks crisis election people".split(),
              {"conflict": "war ceasefire troops border sanctions attack".split(),
               "diplo": "summit treaty ambassador talks alliance visit".split(),
               "disaster": "earthquake flood storm hurricane evacuation wildfire".split()}),
    "science": ("researchers study scientists findings published observed team data experiment evidence".split(),
                {"space": "nasa rocket orbit telescope mission launch".split(),
                 "health": "trial vaccine patients drug fda disease".split(),
                 "climate": "temperature emissions glacier ocean warming carbon".split()}),
    "safety": ("consumers product safety agency notice hazard customers risk units reported".split(),
               {"recalls": "recall defect units refund retailers batch".split(),
                "auto": "vehicles nhtsa airbag brakes crash tires".split(),
                "food": "contamination listeria fda salmonella label allergen".split()}),
}
SUBTOPICS = [(c, s) for c in C.CATEGORIES for s in LEX[c][1]]          # 36 global subtopic ids
N_SUB = len(SUBTOPICS)                                                 # 36
SUB_CAT = np.array([C.CATEGORIES.index(c) for c, _ in SUBTOPICS])      # subtopic id -> category index
FILLER = ("said new this week after report according officials first million percent year company latest "
          "will would could also state group amid expected board plans since over under between").split()

CAT_SOURCES = {"markets": ["fred", "sec", "fed"], "earnings": ["sec"], "economy": ["fred", "bea"],
               "policy": ["fed", "fedreg"], "tech": ["sec", "wikipedia"], "deals": ["sec"],
               "energy": ["fred", "sec"], "insider": ["sec"], "personal-finance": ["fed", "fred"],
               "world": ["wikipedia", "usgs"], "science": ["nasa", "wikipedia", "usgs"], "safety": ["cpsc", "fedreg"]}
CAT_EVENTS = {"markets": ["macro_release", None], "earnings": ["earnings"], "economy": ["macro_release"],
              "policy": ["fed", "macro_release"], "tech": ["earnings", "exec_change", None], "deals": ["deal"],
              "energy": ["macro_release", "earnings", "deal"], "insider": ["insider"],
              "personal-finance": ["macro_release", None], "world": ["world_event"], "science": ["science"],
              "safety": ["recall"]}
SRC_AUTH = {"sec": "filing", "fed": "government", "bea": "government", "fred": "government", "fedreg": "government",
            "wikipedia": "news", "cpsc": "government", "usgs": "government", "nasa": "government"}

CROSS_TOPIC_P = 0.28        # share of stories that mix two subtopics (0.68 / 0.32)
WRONG_LABEL_P = 0.10        # share of cards whose shown category is not their true one
DATA_CARD_P = 0.07          # share of markets/economy cards that are short data cards


def generate_cards(seed: int, days: int, per_day: int = C.CARDS_PER_DAY, start_day: int = 0):
    """Synthetic cards arriving over `days` days. Returns (cards sorted by sort_at, latents).

    latents[card_id] = np.ndarray(N_SUB) topic mixture (sums to 1) -- SIMULATOR ONLY.
    The same seed always gives the same cards (two seeded generators, fixed draw order).
    """
    rng = random.Random(seed * 7919 + 13)
    nrng = np.random.default_rng(seed * 104729 + 17)
    cards, latents = [], {}
    for d in range(start_day, start_day + days):
        for i in range(per_day):
            t = d * C.DAY + rng.random() * C.DAY
            s1 = rng.randrange(N_SUB)
            mix = np.zeros(N_SUB)
            mix[s1] = 1.0
            if rng.random() < CROSS_TOPIC_P:             # cross-topic story
                s2 = rng.randrange(N_SUB)
                if s2 != s1:
                    mix[s1], mix[s2] = 0.68, 0.32
            cat_true = C.CATEGORIES[SUB_CAT[s1]]
            cat = cat_true
            if rng.random() < WRONG_LABEL_P:             # the shown category label is imperfect
                others = [k for k in np.nonzero(mix)[0] if k != s1]
                cat = C.CATEGORIES[SUB_CAT[others[0] if others else rng.randrange(N_SUB)]]
            data = rng.random() < DATA_CARD_P and cat_true in ("markets", "economy")
            ev = rng.choice(CAT_EVENTS[cat_true]) if not data else "macro_release"
            src = rng.choice(CAT_SOURCES[cat_true]) if not data else "fred"
            nsrc = 1 + int(nrng.poisson(1.2 if rng.random() < 0.85 else 4))
            imp = importance_of(ev, SRC_AUTH.get(src, "filing"), nsrc)
            body_n = rng.randint(18, 26) if data else rng.randint(34, 62)
            words, head = [], []
            subs = [(k, mix[k]) for k in np.nonzero(mix)[0]]
            # each word: 50% subtopic vocabulary, 22% category vocabulary, 28% filler
            for pool_n, out in ((rng.randint(6, 9), head), (body_n, words)):
                for _ in range(pool_n):
                    r = rng.random()
                    if r < 0.50:
                        k = subs[0][0] if len(subs) == 1 or rng.random() < subs[0][1] else subs[1][0]
                        c_, s_ = SUBTOPICS[k]
                        out.append(rng.choice(LEX[c_][1][s_]))
                    elif r < 0.72:
                        out.append(rng.choice(LEX[cat_true][0]))
                    else:
                        out.append(rng.choice(FILLER))
            cid = f"c{d:03d}-{rng.getrandbits(40):010x}"
            card = Card(id=cid, kind="data" if data else "summary", headline=" ".join(head).capitalize(),
                        body=" ".join(words), category=cat, event_type=ev, source=src, importance=imp,
                        source_count=nsrc, sort_at=t, published_at=t + 0.2, word_count=len(words))
            cards.append(card)
            latents[cid] = mix
    cards.sort(key=lambda c: (c.sort_at, c.id))
    return cards, latents
