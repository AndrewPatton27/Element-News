"""The ranker-visible Card record, the importance formula, and a loader for the contract fixtures.

Input: card JSON as the app receives it (`contract/fixtures/*.json`). Output: `Card` objects.
Why: every ranker (ML and baselines) sees cards only through this record, so it holds exactly what the
live feed knows about a card and nothing the simulator hides (no topic mixture, no true subtopic).
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from .. import config as C
from ..paths import FIXTURES


@dataclass(frozen=True)
class Card:
    id: str
    kind: str                      # summary | data
    headline: str
    body: str
    category: str
    event_type: Optional[str]
    source: Optional[str]          # source key (lib/sourceKeys.ts) or None
    importance: float
    source_count: int
    sort_at: float                 # hours (any fixed origin)
    published_at: float
    word_count: int

    @property
    def rank_score(self) -> float:
        """Stored base score (docs/RANKING.md): sort_at hours + 8 * log2(importance)."""
        return self.sort_at + C.HALF_LIFE_H * math.log2(max(self.importance, 1.0))

    @property
    def text(self) -> str:
        """Headline and body, the text the embedder reads."""
        return f"{self.headline}. {self.body}"


def importance_of(event_type: Optional[str], authority: str, source_count: int) -> float:
    """docs/RANKING.md importance: event weight x source authority x coverage bonus (rounded to 3 places)."""
    w = C.EVENT_WEIGHT.get(event_type or "none", C.EVENT_WEIGHT["none"])
    cov = 1 + C.COVERAGE_K * math.log(min(max(source_count, 1), C.COVERAGE_CAP))
    return round(w * C.AUTHORITY[authority] * cov, 3)


# ---- contract fixtures -------------------------------------------------------------------
_SOURCE_NAMES = {"SEC": "sec", "Federal Reserve Board": "fed", "U.S. Bureau of Economic Analysis": "bea",
                 "Federal Register": "fedreg", "Wikipedia": "wikipedia",
                 "U.S. Consumer Product Safety Commission": "cpsc", "U.S. Geological Survey": "usgs", "NASA": "nasa"}


def _hours(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() / 3600.0


def source_key(raw: dict) -> Optional[str]:
    """Port of lib/sourceKeys.ts cardSourceKey: data cards are FRED, else the first known source (primary first)."""
    if raw.get("kind") == "data":
        return "fred"
    for s in sorted(raw.get("sources", []), key=lambda s: not s.get("is_primary")):
        if s["name"] in _SOURCE_NAMES:
            return _SOURCE_NAMES[s["name"]]
    return None


def card_from_json(raw: dict) -> Card:
    """One contract card (JSON dict) -> Card. Times become hours since the Unix epoch."""
    body = raw.get("body") or ""
    return Card(id=raw["id"], kind=raw["kind"], headline=raw["headline"], body=body, category=raw["category"],
                event_type=raw.get("event_type"), source=source_key(raw),
                importance=float(raw.get("importance") or 1.0), source_count=int(raw.get("source_count") or 1),
                sort_at=_hours(raw["sort_at"]), published_at=_hours(raw["published_at"]),
                word_count=len(body.split()))


def load_fixture_cards(names=("feed.page1.json", "feed.page2.json", "feed_for_you.page1.json")) -> list[Card]:
    """Summary and data cards from the named fixture pages, each id once, in file order."""
    seen, out = set(), []
    for n in names:
        for raw in json.loads((FIXTURES / n).read_text(encoding="utf-8"))["items"]:
            if raw["id"] not in seen and raw.get("kind") in ("summary", "data"):
                seen.add(raw["id"])
                out.append(card_from_json(raw))
    return out
