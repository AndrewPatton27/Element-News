"""Element ML "For you" ranker: an offline prototype (synthetic readers, free local libraries only).

Sub-packages, in the order data flows through them:

    data/        Card record, contract-fixture loader, synthetic card generator, Catalog (cards as numpy columns)
    features/    item embeddings, the per-reader state (vector, RLS model, affinities), crowd tables,
                 and the stage-2 feature matrix
    ranking/     stage 1 candidates, LightGBM heads, the utility formula, diversity and exploration,
                 and Python ports of today's live formulas (the baselines)
    serving/     the assembled pipeline: Ranker and rank_for_you(user_state, cards) -> ordered ids + "why"
    simulator/   hidden-taste personas and the behaviour model that grades rankings (evaluation only)
    training/    simulated logged impressions -> fitted embedder and heads in ml/models/
    evaluation/  method wiring, the held-out evaluation harness, report tables, value table, diagnostics
    cli/         `python -m elementml.cli ...`

Leakage rule: nothing in data/, features/, ranking/ or serving/ imports simulator/ (tests/test_pipeline.py
checks the source and the imported modules). config.py holds every tunable number; paths.py the folders.
"""
