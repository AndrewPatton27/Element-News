"""Card features for ranking v2: topic, story type, source and tags (a mirror of core.v2_features).

Input: a card's category, type (event_type, else kind), source key, headline and FRED series ids.
Output: a sorted list of feature names, for example ["c:economy", "g:inflation", "s:fred", "t:macro_release"].
Groups: c = category (topic), t = story type, s = source, g = tag. Tags come from TAG_RULES, which is the
exact seed of the core.tag_rules table (a test compares the two), so Python and SQL tag a card the same way.

Rule kinds: category (equal), event_type (equal), series (a FRED series id on the card), keyword (a whole
word or phrase in the headline, case-insensitive; patterns are lowercase letters, digits and single spaces).
"""
from __future__ import annotations

import math
import re
from functools import lru_cache
from typing import Iterable, Optional

# (match_kind, pattern, tag). Keep in sync with the seed in supabase/migrations/*_ranking_v2.sql.
TAG_RULES: list[tuple[str, str, str]] = [
    ("category", "markets", "markets"),
    ("category", "economy", "growth"),
    ("event_type", "fed", "rates"),
    ("series", "DFF", "rates"), ("series", "DGS10", "rates"), ("series", "DGS2", "rates"),
    ("series", "CPIAUCSL", "inflation"),
    ("series", "UNRATE", "jobs"), ("series", "PAYEMS", "jobs"), ("series", "ICSA", "jobs"),
    ("series", "A191RL1Q225SBEA", "growth"), ("series", "RSAFS", "growth"),
    ("series", "HOUST", "housing"),
    ("series", "DCOILWTICO", "energy"), ("series", "GASREGW", "energy"),
    ("keyword", "interest rate", "rates"), ("keyword", "interest rates", "rates"), ("keyword", "rates", "rates"),
    ("keyword", "rate cut", "rates"), ("keyword", "rate hike", "rates"), ("keyword", "fed", "rates"),
    ("keyword", "fomc", "rates"), ("keyword", "federal reserve", "rates"), ("keyword", "treasury", "rates"),
    ("keyword", "yield", "rates"), ("keyword", "yields", "rates"), ("keyword", "bond", "rates"),
    ("keyword", "bonds", "rates"),
    ("keyword", "inflation", "inflation"), ("keyword", "cpi", "inflation"), ("keyword", "consumer prices", "inflation"),
    ("keyword", "jobs", "jobs"), ("keyword", "payrolls", "jobs"), ("keyword", "unemployment", "jobs"),
    ("keyword", "jobless", "jobs"), ("keyword", "hiring", "jobs"), ("keyword", "layoffs", "jobs"),
    ("keyword", "wages", "jobs"),
    ("keyword", "gdp", "growth"), ("keyword", "recession", "growth"), ("keyword", "retail sales", "growth"),
    ("keyword", "stocks", "markets"), ("keyword", "stock market", "markets"), ("keyword", "dow", "markets"),
    ("keyword", "nasdaq", "markets"), ("keyword", "wall street", "markets"), ("keyword", "selloff", "markets"),
    ("keyword", "oil", "energy"), ("keyword", "crude", "energy"), ("keyword", "opec", "energy"),
    ("keyword", "gasoline", "energy"),
    ("keyword", "ai", "ai"), ("keyword", "chips", "ai"), ("keyword", "gpu", "ai"),
    ("keyword", "bitcoin", "crypto"), ("keyword", "crypto", "crypto"),
    ("keyword", "housing", "housing"), ("keyword", "mortgage", "housing"), ("keyword", "home sales", "housing"),
    ("keyword", "recall", "recalls"), ("keyword", "recalls", "recalls"),
    ("keyword", "earthquake", "disaster"), ("keyword", "hurricane", "disaster"), ("keyword", "wildfire", "disaster"),
    ("keyword", "flood", "disaster"),
    ("keyword", "nasa", "space"), ("keyword", "rocket", "space"), ("keyword", "telescope", "space"),
]
KEYWORD_PATTERN = re.compile(r"^[a-z0-9]+( [a-z0-9]+)*$")    # same CHECK as core.tag_rules
GROUPS = ("c", "t", "s", "g")


@lru_cache(maxsize=None)
def _kw_regex(pattern: str) -> re.Pattern:
    # Postgres: headline ~* ('\m' || pattern || '\M'); word characters are letters, digits and '_'
    return re.compile(r"(?<![A-Za-z0-9_])" + re.escape(pattern) + r"(?![A-Za-z0-9_])", re.IGNORECASE)


def tags_of(category: str, typ: Optional[str], headline: str, series: Iterable[str] = (),
            rules: list[tuple[str, str, str]] = TAG_RULES) -> set[str]:
    """Tags of one card under `rules`."""
    ser = {s.upper() for s in series if s}
    out = set()
    for kind, pat, tag in rules:
        if kind == "category" and category == pat:
            out.add(tag)
        elif kind == "event_type" and typ == pat:
            out.add(tag)
        elif kind == "series" and pat.upper() in ser:
            out.add(tag)
        elif kind == "keyword" and headline and _kw_regex(pat).search(headline):
            out.add(tag)
    return out


def card_features(category: str, typ: Optional[str], skey: Optional[str], headline: str = "",
                  series: Iterable[str] = (), rules: list[tuple[str, str, str]] = TAG_RULES) -> list[str]:
    """Sorted feature names of one card (mirror of core.v2_features)."""
    f = {"c:" + category}
    if typ:
        f.add("t:" + typ)
    if skey:
        f.add("s:" + skey)
    f |= {"g:" + t for t in tags_of(category, typ, headline, series, rules)}
    return sorted(f)


def x_of(features: list[str]) -> float:
    """Value of each active feature: 1 / sqrt(number of active features), so a card's features share one unit."""
    return 1.0 / math.sqrt(len(features)) if features else 0.0


def group_of(feature: str) -> str:
    return feature.split(":", 1)[0]
