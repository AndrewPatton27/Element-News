"""Command line for the ML prototype. Run from the ml/ folder: python -m elementml.cli <command> ...

Commands (inputs -> outputs):
    stats          synthetic card counts + fixture loader check -> printed
    train          embedder + original head sets -> models/ (about 2 min)
    train-variant  one hardened head set -> models/<sub>/ (about 30 s for --spec normal)
    eval           held-out evaluation -> results/<file>.json (+ eval_tables.md for the default run)
    report         results/eval_results.json -> results/eval_tables.md
    compare        mean (sd) and paired differences for result files -> printed
    value          every results file -> results/model_value.csv + model_value_summary.md
    diag           head AUC / calibration per world -> printed JSON
    demo           rank contract/fixtures for a made-up reader -> printed table
Heavy modules are imported inside each command so `--help` and `stats` start fast.
"""
from __future__ import annotations

import argparse
from collections import Counter

import numpy as np

from ..data.cards import load_fixture_cards
from ..data.generator import generate_cards
from ..paths import MODELS

STRESS_WORLD = dict(noise_mult=2.0, taste_scale=0.6, pos_decay=0.15)   # --stress (same as evaluation WORLDS["stress"])
STRESS_METHODS = ["a2_current_device", "a1_current_server", "d_vectors_only", "e_full"]


def cmd_stats(a):
    """Print what the generator makes and check that the contract fixtures load."""
    cards, lat = generate_cards(a.seed, a.days)
    print(f"{len(cards)} synthetic cards over {a.days} days")
    print("per category:", dict(Counter(c.category for c in cards).most_common()))
    print("per event type:", dict(Counter(c.event_type for c in cards).most_common()))
    print("importance: min %.2f median %.2f max %.2f" % (min(c.importance for c in cards), np.median([c.importance for c in cards]), max(c.importance for c in cards)))
    for c in cards[:3]:
        print(f"- [{c.category}/{c.event_type}/{c.source}] imp {c.importance}: {c.headline} | {c.body[:90]}...")
    fx = load_fixture_cards()
    print(f"{len(fx)} fixture cards loaded from contract/fixtures; first: {fx[0].headline}")


def cmd_train(a):
    """Fit the embedder and the original head sets into models/."""
    from ..training.train import train_all
    train_all(n_personas=a.personas, days=a.days, workers=a.workers)


def cmd_eval(a):
    """Evaluate methods on held-out personas; see --world, --methods, --seed-list and --stress."""
    from ..evaluation.harness import WORLDS, run_eval
    seeds = tuple(range(1, a.seeds + 1))
    if a.seed_list:
        seeds = tuple(int(x) for x in a.seed_list.split(","))
    if a.methods or a.world != "normal" and not a.stress:
        methods = a.methods.split(",") if a.methods else None
        run_eval(seeds=seeds, methods=methods, n_personas=a.personas, days=a.days, workers=a.workers,
                 out_name=a.out or f"eval_{a.world}.json", world_kw=WORLDS[a.world])
        return
    if a.stress:
        from ..evaluation.report import write_stress
        run_eval(seeds=seeds, methods=STRESS_METHODS, n_personas=a.personas,
                 days=a.days, workers=a.workers, out_name="eval_stress.json",
                 world_kw=dict(STRESS_WORLD))
        print(write_stress())
        return
    run_eval(seeds=seeds, n_personas=a.personas, days=a.days, workers=a.workers)
    cmd_report(a)


def cmd_train_variant(a):
    """Train one hardened head set into models/<sub>/."""
    from ..evaluation.policies import VCFGS
    from ..training.train import train_variant
    train_variant(a.sub, spec=a.spec, robust=bool(a.robust), pos_mode=a.pos, calibrate=bool(a.calib), vcfg=VCFGS[a.vc],
                  n_personas=a.personas, workers=a.workers, drop=tuple(x for x in a.drop.split(",") if x))


def cmd_report(a):
    """Rebuild results/eval_tables.md from results/eval_results.json."""
    from ..evaluation.report import write_report
    print(write_report())


def cmd_compare(a):
    """Compare methods across result files (formerly `python -m elementml.report`)."""
    from ..evaluation.report import compare
    print(compare(a.files, ref=a.ref))


def cmd_value(a):
    """Rebuild the model-value table (formerly `python -m elementml.value`)."""
    from ..evaluation.value import main as value_main
    value_main(["--bench"] if a.bench else [])


def cmd_diag(a):
    """Head diagnostics per world (formerly `python -m elementml.harden`)."""
    from ..evaluation.diagnostics import main as diag_main
    diag_main(a.subs)


def cmd_demo(a):
    """Rank the contract fixtures for a made-up reader. The embedder is fitted on the fixtures themselves
    (the saved one was fitted on synthetic vocabulary), the saved LightGBM heads are reused as they are."""
    from ..evaluation.policies import Bundle
    from ..features.embed import Embedder
    from ..features.uservec import UserState, make_prior
    from ..serving.for_you import Ranker, rank_for_you
    cards = load_fixture_cards()
    emb = Embedder().fit(cards)
    bundle = Bundle.load(MODELS)
    now = max(c.sort_at for c in cards) + 1.0
    state = UserState("demo", emb.k, follows=a.follow, prior=make_prior(emb, a.follow), now=now - 48.0)
    vec = emb.transform(cards)
    liked = [c for c in cards if c.category in a.like]
    for c in liked[:a.n_likes]:
        i = cards.index(c)
        state.observe(c, vec[i], [("view", None), ("like", None), ("dwell", 9000.0)], now - 24.0)
    print(f"reader follows {a.follow or 'nothing'}; liked {min(len(liked), a.n_likes)} card(s) in {a.like or 'no topic'}")
    ranker = Ranker(bundle.heads["full"])
    ranked = rank_for_you(state, cards, ranker, emb, now=now)
    byfull = {c.id: c for c in cards}
    print(f"{'#':>2}  {'category':<17} {'headline':<58} why")
    for i, r in enumerate(ranked[:a.top]):
        c = byfull[r.id]
        print(f"{i + 1:>2}  {c.category:<17} {c.headline[:56]:<58} {r.why}")
    if len(ranked) < len(cards):
        print(f"({len(cards) - len(ranked)} cards left out: already seen by this reader)")


def main(argv=None):
    """Parse the command line and run one command."""
    ap = argparse.ArgumentParser(prog="elementml")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("stats"); s.add_argument("--seed", type=int, default=1); s.add_argument("--days", type=int, default=20); s.set_defaults(f=cmd_stats)
    t = sub.add_parser("train"); t.add_argument("--personas", type=int, default=50); t.add_argument("--days", type=int, default=14)
    t.add_argument("--workers", type=int, default=6); t.set_defaults(f=cmd_train)

    e = sub.add_parser("eval"); e.add_argument("--seeds", type=int, default=5); e.add_argument("--personas", type=int, default=60)
    e.add_argument("--days", type=int, default=14); e.add_argument("--workers", type=int, default=7)
    e.add_argument("--stress", action="store_true", help="evaluate in a differently-behaving world")
    e.add_argument("--world", default="normal", choices=["normal", "stress", "wild"])
    e.add_argument("--seed-list", default="", help="comma-separated seeds (overrides --seeds), e.g. 11,12,13 for validation")
    e.add_argument("--methods", default="", help="comma-separated method names")
    e.add_argument("--out", default="", help="results file name under results/"); e.set_defaults(f=cmd_eval)

    r = sub.add_parser("report"); r.set_defaults(f=cmd_report)

    c = sub.add_parser("compare", help="mean (sd) per method + paired difference vs --ref, for result files")
    c.add_argument("files", nargs="+", help="file names under results/"); c.add_argument("--ref", default="a1_current_server")
    c.set_defaults(f=cmd_compare)

    v = sub.add_parser("value", help="rebuild results/model_value.csv and model_value_summary.md")
    v.add_argument("--bench", action="store_true", help="re-measure inference ms"); v.set_defaults(f=cmd_value)

    g = sub.add_parser("diag", help="head AUC / calibration on fresh normal and stress logs")
    g.add_argument("subs", nargs="*", help="model sub-folders; 'original' = models/ itself"); g.set_defaults(f=cmd_diag)

    tv = sub.add_parser("train-variant", help="hardening: train one head set into models/<sub>/")
    tv.add_argument("--sub", required=True); tv.add_argument("--spec", default="dr", choices=["normal", "stress", "dr"])
    tv.add_argument("--robust", type=int, default=1); tv.add_argument("--pos", default="feature", choices=["feature", "ips"])
    tv.add_argument("--calib", type=int, default=1); tv.add_argument("--vc", default="shrink")
    tv.add_argument("--personas", type=int, default=50); tv.add_argument("--workers", type=int, default=7)
    tv.add_argument("--drop", default="", help="feature groups to leave out, e.g. rls,srv")
    tv.set_defaults(f=cmd_train_variant)

    d = sub.add_parser("demo"); d.add_argument("--follow", nargs="*", default=["tech"]); d.add_argument("--like", nargs="*", default=["tech"])
    d.add_argument("--n-likes", type=int, default=2); d.add_argument("--top", type=int, default=12); d.set_defaults(f=cmd_demo)
    a = ap.parse_args(argv)
    a.f(a)
