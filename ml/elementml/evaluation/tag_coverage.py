"""Real-headline robustness check for the tag step (core.tag_rules keywords, bandit/features.TAG_RULES).

Input: realistic headlines in the repo: contract/fixtures/*.json card headlines (SEC 8-K, Form 4, Fed, BEA,
FRED, CPSC, USGS styles), ingest/test/fixtures/*.xml RSS titles (Fed FOMC and speeches, SEC press), and
headline/title strings in ingest/test/*.ts (placeholders such as "A short plain news card" are dropped).
Output: the share of headlines with at least one keyword tag, and the same share for the synthetic catalog the
simulator uses, so the v3 result's dependence on tags can be judged. `python -m elementml.evaluation.tag_coverage`.
"""
from __future__ import annotations

import html
import json
import re
from collections import Counter
from pathlib import Path

from ..bandit.features import TAG_RULES, tags_of
from ..data.generator import generate_cards

REPO = Path(__file__).resolve().parents[3]
KEYWORD_RULES = [r for r in TAG_RULES if r[0] == "keyword"]
PLACEHOLDER = re.compile(r"short plain news card|^a? ?card\b|lorem|^test\b", re.I)
STR_RX = re.compile(r"""(?:headline|title)["']?\s*[:=]\s*(["'`])(.{12,200}?)\1""")


def real_headlines() -> list[str]:
    out = []
    for p in sorted((REPO / "contract" / "fixtures").glob("*.json")):
        def walk(x):
            if isinstance(x, dict):
                for k, v in x.items():
                    if k == "headline" and isinstance(v, str):
                        out.append(v)
                    else:
                        walk(v)
            elif isinstance(x, list):
                for v in x:
                    walk(v)
        walk(json.loads(p.read_text(encoding="utf-8")))
    for p in sorted((REPO / "ingest" / "test" / "fixtures").glob("*.xml")):
        out += [html.unescape(t).strip() for t in re.findall(r"<title>(?:<!\[CDATA\[)?([^<\]]+)", p.read_text(encoding="utf-8"))]
    for p in sorted((REPO / "ingest" / "test").glob("*.ts")):
        out += [m.group(2) for m in STR_RX.finditer(p.read_text(encoding="utf-8"))]
    clean = []
    for h in out:
        h = h.replace("[SAMPLE]", "").strip()
        if len(h) >= 12 and not PLACEHOLDER.search(h) and "|" not in h and not h.startswith("FRB:") and h not in clean:
            clean.append(h)
    return clean


def coverage(heads: list[str]) -> dict:
    tagged = [sorted(tags_of("", None, h, rules=KEYWORD_RULES)) for h in heads]
    c = Counter(t for ts in tagged for t in ts)
    return {"n": len(heads), "share_with_tag": round(sum(bool(t) for t in tagged) / max(len(heads), 1), 3),
            "tags": dict(c.most_common())}


def report() -> str:
    real = real_headlines()
    syn = [c.headline for c in generate_cards(9001, days=3)[0]]
    r, s = coverage(real), coverage(syn)
    lines = [f"real-style headlines: {r['n']}, share with >= 1 keyword tag {r['share_with_tag']}, tags {r['tags']}",
             f"synthetic headlines:  {s['n']}, share with >= 1 keyword tag {s['share_with_tag']}, tags {s['tags']}",
             "untagged real examples: " + " || ".join(h for h in real if not tags_of("", None, h, rules=KEYWORD_RULES))[:900]]
    return "\n".join(lines)


if __name__ == "__main__":
    print(report())
