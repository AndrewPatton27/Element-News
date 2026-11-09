"""The weekly ranking v2 job, step by step (each step reads and writes JSON files in one data folder).

    export   Supabase -> <data>/events.json, pages.json, prefs.json, cards.json, params.json  (60 days)
    train    <data> -> <data>/model.json (core.ml_weights rows + the fit report)
    gate     <data> + the synthetic evaluation file -> <data>/gate.json (gate_passed and every criterion)
    publish  <data>/model.json + gate.json -> api.ml_write_weights (one core.ml_models row + its weights)
The folder holds reader ids and events, so the GitHub workflow deletes it at the end and never uploads it.
Printed output is counts and pass/fail only; never a row.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import features as FT
from .gate import decide, replay_gains, replay_gate
from .params import params
from .policy import Model, RefCard
from .prior import events_from_export, fit
from .supa import Supa, iso_to_hours

EXPORT_DAYS = 60


def _w(path: Path, obj) -> None:
    path.write_text(json.dumps(obj), encoding="utf-8")


def _r(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def export(data: Path, supa: Supa | None = None, days: int = EXPORT_DAYS, log=print) -> dict:
    supa = supa or Supa()
    data.mkdir(parents=True, exist_ok=True)
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    counts = {}
    for what in ("events", "pages"):
        rows = supa.export(what, since)
        _w(data / f"{what}.json", rows); counts[what] = len(rows)
    rows = supa.export("prefs", "1970-01-01T00:00:00Z")
    _w(data / "prefs.json", rows); counts["prefs"] = len(rows)
    rows = supa.export_cards(since)
    _w(data / "cards.json", rows); counts["cards"] = len(rows)
    _w(data / "params.json", supa.params())
    _w(data / "meta.json", {"asof": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    log(f"export: {counts}")
    return counts


def _load(data: Path):
    P = params({k: v for k, v in (_r(data / "params.json") if (data / "params.json").exists() else {}).items()
                if isinstance(v, (int, float))})
    asof = iso_to_hours(_r(data / "meta.json")["asof"]) if (data / "meta.json").exists() else time.time() / 3600.0
    ev = events_from_export(_r(data / "events.json"), iso_to_hours)
    cards = {}
    for c in _r(data / "cards.json"):
        cards[c["id"]] = RefCard(id=c["id"], category=c["category"], typ=c.get("typ"), skey=c.get("skey"),
                                 headline=c.get("headline") or "", series=tuple(c.get("series") or ()),
                                 rank_score=float(c.get("rank_score") or 0), sort_at=iso_to_hours(c["sort_at"]),
                                 published_at=iso_to_hours(c["published_at"]), words=int(c.get("word_count") or 0))
    # the database's own tags win (core.v2_features); the Python rules are only a fallback
    feats = {c["id"]: list(c["features"]) if c.get("features") else cards[c["id"]].features for c in _r(data / "cards.json")}
    follows = {p["user_id"]: list(p.get("followed_categories") or []) for p in _r(data / "prefs.json")}
    return P, asof, ev, cards, feats, follows


def train(data: Path, log=print) -> dict:
    P, asof, ev, cards, feats, follows = _load(data)
    words = {k: c.words for k, c in cards.items()}
    version = "ts-v2-" + datetime.fromtimestamp(asof * 3600, tz=timezone.utc).strftime("%Y%m%d")
    model, report = fit(ev, feats, words, follows, asof, P, version=version)
    _w(data / "model.json", {"version": model.version, "rows": model.rows(), "report": report})
    log(f"train: readers {report['readers']}, events {report['events']}, rows {len(model.rows())}"
        + (f", {report['fallback']}" if "fallback" in report else ""))
    return report


def gate(data: Path, synthetic_file: Path, log=print) -> dict:
    from .gate import synthetic_gate
    P, asof, ev, cards, feats, follows = _load(data)
    m = _r(data / "model.json")
    model = Model.from_rows(m["rows"], m["version"])
    synth = synthetic_gate(_r(synthetic_file)["runs"]) if synthetic_file.exists() else {"passed": False, "why": "no synthetic results"}
    pages = []
    for p in _r(data / "pages.json"):
        if p.get("holdout"):
            continue                                   # holdout pages are the control, not replay input
        pages.append({"user_id": p["user_id"], "surface": p["surface"], "as_of": iso_to_hours(p["as_of"]),
                      "shown_at": iso_to_hours(p["shown_at"]), "card_ids": p["card_ids"]})
    gains = replay_gains(pages, ev, cards, follows, model, P)
    rep = replay_gate(pages, gains)
    out = {"synthetic": synth, "replay": rep, "gate_passed": decide(synth, rep)}
    _w(data / "gate.json", out)
    log(f"gate: synthetic {'pass' if synth.get('passed') else 'fail'}, replay {'pass' if rep.get('passed') else 'fail'}"
        f" ({rep.get('days', 0)} days, {rep.get('readers', 0)} readers), gate_passed {out['gate_passed']}")
    return out


def publish(data: Path, supa: Supa | None = None, log=print) -> dict:
    supa = supa or Supa()
    m = _r(data / "model.json"); g = _r(data / "gate.json") if (data / "gate.json").exists() else {"gate_passed": False}
    rep = m["report"]
    model = {"version": m["version"], "n_readers": rep.get("readers", 0), "n_events": rep.get("events", 0),
             "gate_passed": bool(g.get("gate_passed")), "gate": g, "report": rep}
    r = supa.write_weights(model, m["rows"])
    log(f"publish: model {r.get('model_id')}, written {r.get('written')}, skipped {r.get('skipped')}, gate_passed {model['gate_passed']}")
    return r


def tag_rules_sql_rows() -> list[tuple[str, str, str]]:
    """The Python tag rules (compared with the migration's seed by the tests)."""
    return list(FT.TAG_RULES)
