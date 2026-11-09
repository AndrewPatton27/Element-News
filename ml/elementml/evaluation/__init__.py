"""Evaluation on simulated readers: method wiring (policies), the harness, report tables, the value table
and diagnostics.

Modules are imported directly (for example `from elementml.evaluation.harness import run_eval`). This file
imports nothing on purpose: `policies` must stay importable without loading the simulator, while
`harness`, `value` and `diagnostics` do load it.
"""
