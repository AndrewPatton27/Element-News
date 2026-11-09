"""Folder locations used by the package (no settings, no I/O).

ML_DIR is the `ml/` folder. Saved models go to `ml/models/` and evaluation output to `ml/results/`
(both git-ignored and rebuilt by the CLI). FIXTURES is the shared card contract the demo ranks.
"""
from __future__ import annotations

from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]      # .../ml
REPO = ML_DIR.parent                               # repository root
MODELS = ML_DIR / "models"                         # embedder.pkl + LightGBM heads (one sub-folder per variant)
RESULTS = ML_DIR / "results"                       # evaluation JSON, markdown tables, logs
FIXTURES = REPO / "contract" / "fixtures"          # sample feed pages shared with the app
