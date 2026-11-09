"""Method names for v3 in the evaluation harness.

"v3" is the default V3Config; "v3:key=value,key=value" overrides fields, for example
"v3:solver=ridge,lam=1" or "v3:base=base_follow". Numbers are parsed as float, everything else as text.
"""
from __future__ import annotations

from dataclasses import fields

from .policy import ResidualPolicy, V3Config

_FIELDS = {f.name: f.type for f in fields(V3Config)}
ALIASES = {"H": "hours_per_reward", "cap": "cap_hours"}


def parse(method: str) -> V3Config:
    cfg = V3Config()
    if ":" not in method:
        return cfg
    kw = {}
    for part in method.split(":", 1)[1].split(","):
        if not part:
            continue
        k, v = part.split("=")
        k = ALIASES.get(k, k)
        if k not in _FIELDS:
            raise KeyError(k)
        kw[k] = v if k in ("solver", "base") else float(v)
    return cfg.with_(**kw)


def make_v3(method: str, cat) -> ResidualPolicy:
    return ResidualPolicy(cat, parse(method), name=method)


# The setting chosen on tuning seeds 101-102 and evaluated once on seeds 1-5 (v3-findings.md, "Final run").
FINAL = "v3:H=36,cap=30,step_extra=2.5"
