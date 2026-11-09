# ml/ : the ML "For you" ranker (offline prototype)

Status: prototype, **evaluated on simulated readers only**. Every reader on the website is still served by the SQL formula. The model runs on a laptop, uses only free local libraries, makes no network calls and calls no paid service. Nothing in `app/`, `lib/`, `supabase/` or `ingest/` imports this folder.

What it does, in one paragraph: every card gets a 32-number vector from its text (TF-IDF plus one-hot category, event type and source, squeezed by SVD). Every reader gets a vector that moves toward cards they like and away from cards they dislike, plus a small ridge-regression (RLS) model that also learns from plain views. Stage 1 picks about 150 candidate cards (closest to the reader, plus the most important and fresh). Stage 2 is four small LightGBM models that predict, for this reader and this card, the chance of a like, a dislike and an open-detail, and how much of the card the reader will read. Those predictions are combined into one "expected usefulness" number, then a diversity pass (MMR) shapes the page. Every card carries a one-sentence "why".

## How it connects to the website (shadow mode)

- **Shadow only.** The database logs which cards each signed-in For you and Trending page showed and in which slot, behind two flags in `core.rank_params`: `foryou_ml_mode` and `trending_ml_mode` (0 = off, 1 = shadow; they ship at 0). In shadow mode nothing a reader sees changes.
- **Hourly laptop job.** Next to the hourly ingest run, a job exports the logged pages and events (service-role RPC), rebuilds each reader's state as of the moment the page was served, runs `rank_for_you` on the same candidates and writes the model's would-have-ranked scores back to Postgres (`api.ml_write_shadow`). The database side is built and switched off; the Python replay job is the next step and is not in this folder yet. Its entry point will be `elementml.serving.rank_for_you`.
- **Trending** uses the same model averaged across readers ("expected appeal to everyone"), with position and crowd features neutralised so it cannot feed a popularity loop.
- **Going live later** is one capped term added to the existing SQL score, in hours, so importance and freshness stay the backbone. It needs its own migration and review, and only after these hold: at least 14 days of shadow logs and at least 200 real readers (with about 30,000 impressions), heads retrained on real events, and the shadow evaluation beating the formula without extra dislikes.

## Run it

Use a Python 3.13 environment (`pip install -r requirements.txt`: numpy, scipy, pandas, scikit-learn, lightgbm, pytest; nothing else). From this folder (`ml/`):

```
PY=<path to that python.exe>
$PY -m pytest tests -q                              # 46 tests, about 10 s
$PY -m elementml.cli stats                          # synthetic cards + fixture loader check
$PY -m elementml.cli train                          # embedder + original LightGBM heads -> models/ (about 2-5 min)
$PY -m elementml.cli train-variant --sub nr --spec normal   # hardened h_full heads -> models/nr/ (about 1 min); --spec dr --sub hr for h_full_dr
$PY -m elementml.cli eval --seeds 5                 # full original evaluation -> results/eval_results.json + eval_tables.md (about 25 min, 8 cores)
$PY -m elementml.cli eval --world wild --seed-list 1,2,3,4,5 --methods h_full,e_full,a1_current_server --out x.json
$PY -m elementml.cli compare x.json                 # mean (sd) per method + paired difference vs the server formula
$PY -m elementml.cli report                         # rebuild results/eval_tables.md from results/eval_results.json
$PY -m elementml.cli value [--bench]                # rebuild results/model_value.csv + model_value_summary.md
$PY -m elementml.cli diag nr hr                     # head AUC and calibration on fresh normal and stress logs
$PY -m elementml.cli demo --follow tech --like tech # rank contract/fixtures for a made-up reader
```

Everything is seeded: the same command gives the same numbers, and retraining gives byte-identical LightGBM files (`embedder.pkl` gives the same vectors, but its pickle bytes differ per run because scikit-learn stores an object id).

## Folders and files

The leakage rule: nothing in `data/`, `features/`, `ranking/` or `serving/` imports `simulator/`. `tests/test_pipeline.py` checks the source of every such file and that importing them never loads the simulator.

| Path | What happens there |
|---|---|
| `elementml/config.py` | Every tunable number, named, with a one-line meaning (signal weights, vector steps, K, utility weights, MMR, exploration, live-formula constants). `SETTINGS_TABLE` lists the main ones. |
| `elementml/paths.py` | Folder locations: `models/`, `results/`, `contract/fixtures/`. |
| `elementml/interfaces.py` | The one-method `Policy` interface shared by the simulator and every ranker. |
| `elementml/embed.py` | Compatibility name only: saved `embedder.pkl` files refer to `elementml.embed.Embedder`. |
| **`data/`** | **Cards.** |
| `data/cards.py` | `Card` (ranker-visible fields only), the importance formula, loader for `contract/fixtures/*.json`. |
| `data/generator.py` | Synthetic cards: 12 categories x 3 subtopics with their own vocabulary, mixed-topic stories, wrong labels. Also returns hidden topic mixtures, which only the simulator reads. |
| `data/catalog.py` | `Catalog`: cards as numpy columns plus the embedding matrix; freshness-window lookup. |
| **`features/`** | **What the ranker knows.** |
| `features/embed.py` | `Embedder`: TF-IDF + one-hot -> TruncatedSVD (32 dims) -> unit length; category centroids. |
| `features/uservec.py` | `UserState`: the reader vector (shrinking step, 14-day fade toward the follow prior, uncertainty), the RLS reader model, the per-card signal ledger and affinities (a port of `core.user_affinity_dims`). |
| `features/crowd.py` | Python mirror of the hourly crowd tables (Trending buzz and quality, card neighbours, topic lifts). Counts only, at least 3 people per number. |
| `features/builder.py` | The stage-2 feature matrix: 34 columns in eight groups (`GROUPS`, used for ablations). |
| **`ranking/`** | **The pieces of the ranker.** |
| `ranking/candidates.py` | Stage 1: eligibility (not seen, disliked or hidden) and the ~150-card shortlist. |
| `ranking/heads.py` | LightGBM heads (train, predict, save, load), monotone constraints, Platt calibration, ECE. |
| `ranking/utility.py` | The expected-utility formula and its weights. |
| `ranking/diversity.py` | MMR diversity re-rank and UCB exploration slots. |
| `ranking/baselines.py` | Faithful ports of today's server formula (`api.feed_for_you`) and device formula (`lib/forYouRank.ts`), plus recency/importance and popularity. |
| **`serving/`** | **The assembled ranker.** |
| `serving/for_you.py` | `Ranker`, `Variant` (method switches) and `rank_for_you(user_state, candidate_cards, ranker, embedder)` -> ordered ids with a short "why". |
| **`simulator/`** | **Simulated readers (evaluation and training only).** |
| `simulator/personas.py` | Hidden-taste personas (five kinds), some of whom change taste halfway. |
| `simulator/world.py` | The behaviour model: like, dislike, open detail, dwell, quick skip, position bias, session end; normal, stress and wild world switches. |
| `simulator/cohort.py` | `run_cohort`: a cohort reads its own method's feed day by day; NDCG and other per-session metrics. |
| **`training/`** | |
| `training/train.py` | Simulated logs under a mixed logging policy -> embedder + heads; `train_variant` for the hardened sets (domain randomisation, IPS, feature-group drop). |
| **`evaluation/`** | |
| `evaluation/policies.py` | Every method by name (`a1_current_server`, `e_full`, `h_full`, `d_hard`, composable `e+heads:nr+noexp`, ...) and the logging mix. |
| `evaluation/harness.py` | Held-out evaluation over seeds and worlds (`WORLDS`), the new-user probe, table helpers. |
| `evaluation/report.py` | Markdown tables and the `compare` view. |
| `evaluation/value.py` | `results/model_value.csv` (one row per variant x world x seed) and the component-value table; inference benchmark. |
| `evaluation/diagnostics.py` | Head AUC / calibration per world, and the headroom oracle (reads hidden taste; evaluation only, never a ranker). |
| **`cli/`** | `python -m elementml.cli <command>` (`cli/main.py`). |
| `tests/` | pytest: vector-update direction and step size, signal weights, affinity rules, no simulator leakage, train/eval seed separation, determinism, ranker output is a permutation, paging stability, MMR, exploration, crowd privacy floor, baseline ports, hardening pieces. |
| `models/` | Saved embedder and heads, one sub-folder per hardened variant (git-ignored: regenerate with `train` / `train-variant`). |
| `results/` | Evaluation JSON, markdown tables, logs, `refactor_baseline.json` and `refactor_report.md` (git-ignored). |

## Inputs and outputs

- Training input: simulated impressions `(reader state, card, slot) -> like / dislike / open_detail / dwell_ms`. With real data the same table is built from `core.user_events` plus the logged pages (which cards were shown, and in which slot).
- Serving input: a `UserState` (built from that reader's events, follows and hides) and a list of candidate `Card`s.
- Output: ordered card ids, a utility score, and a short reason for each of the first 20.

## Honest limits

- The model was trained and graded by the same simulator, which encodes guesses about how people react. The stress and wild worlds are partial checks, not independence. Do not read any number here as a gain for real readers.
- In the simulator (test seeds 1-5) the hardened pipeline `h_full` beats today's server formula on NDCG@10 by +0.164 in the normal world but only +0.039 (stress) and +0.031 (wild). Real readers are likely noisier still; the gain could be zero.
- Synthetic cards share a templated vocabulary, so text vectors are far cleaner than they will be on real headlines.
- One metric got worse when hardening: recovery after a reader's taste changes completely is slower.
- Heads trained on simulated logs must not be used for real readers; they are retrained on real events before any go-live review.

## Ranking v2 (`elementml/bandit/`): Thompson sampling in plain SQL

A second, much smaller approach that can run inside Postgres on the free tier. It is written and tested but **switched off**: the SQL (`supabase/migrations/20261109000000_ranking_v2.sql`) only serves it when `core.rank_params.foryou_ml_mode = 2` (set by hand, ships at 0) and a model in `core.ml_models` has passed the gate.

In plain words: a card is a few features (topic, story type, source and tags such as `rates`, `inflation`, `jobs`, `markets`, set by `core.tag_rules`). For each feature a reader has a belief: an average reward and how sure we are. The belief starts at the population average (trained weekly) and moves toward the reader's own likes, detail opens, long looks, quick skips and dislikes. Each scroll takes one random draw from those beliefs and adds it, in hours, to the usual importance-and-freshness score. Unsure topics get wide draws and sometimes win (built-in exploration, which fades as evidence grows). The draw is fixed by reader, feature and a seed kept in the cursor, so paging is exact.

```
n_j = sum w x^2     mu_j = (lambda_g mu0_j + sum w x r) / (lambda_g + n_j)     sigma_j = tau / sqrt(lambda_g + n_j)
theta_j = mu_j + v2_explore sigma_j z_j          hours = clamp(12 x sum_j x theta_j, -18, 18)
score = rank_score + hours - seen penalty, then the topic step and core.diversify (as today)
```

| File | What happens there |
|---|---|
| `bandit/params.py` | Every setting, same keys as the `core.rank_params` rows (`v2_*`, plus the reused signal weights). |
| `bandit/features.py` | Card features; `TAG_RULES` is the exact `core.tag_rules` seed (a test compares them). |
| `bandit/policy.py` | The math, `score_reference` (line-by-line mirror of `core.v2_scores`), the md5 normal draw shared with SQL, `BanditPolicy` for the simulator. |
| `bandit/prior.py` | Weekly empirical-Bayes fit: slot propensities, population mean per feature (reader weight capped, at least 20 readers per feature, else the hand prior), tau, prior strength per group picked by next-week likelihood. |
| `bandit/gate.py` | Go/no-go: synthetic criteria per world, the real-data replay (inverse propensity, needs 14 days and 200 readers, 90% bootstrap lower bound > 0). |
| `bandit/supa.py`, `bandit/job.py` | Service-role REST client (standard library) and the weekly steps: export, train, gate, publish. They print counts and pass/fail only. |
| `simulator/bandit_personas.py` | Six reader types: rates-and-markets student, tech reader, everything skimmer, anti-macro reader (no sports topic exists in the synthetic catalog, so: world/science/safety fan who dislikes macro), taste changer, new reader with two follows. |
| `evaluation/bandit_eval.py` | ts_v2 vs today's server formula over normal / stress / wild worlds and 5 seeds; trains the prior on separate simulated logs first, exactly like the weekly job. |
| `tests/test_bandit.py`, `tests/pglite_parity.mjs` | Update direction, shrinkage, follows, lean, draws, paging stability, training (fallback, privacy floor, reader cap, determinism), gate logic, the offline job, and SQL parity in PGlite. |

```
$PY -m pytest tests/test_bandit.py -q                       # parity runs only with PGLITE_PACKAGE_JSON set (else skipped)
PGLITE_PACKAGE_JSON=<path to a package.json with @electric-sql/pglite installed> $PY -m pytest tests/test_bandit.py -q
$PY -m elementml.cli eval-bandit --seeds 5                  # -> results/bandit_eval.json + printed tables and gate
$PY -m elementml.cli bandit-export --data <folder>          # needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
$PY -m elementml.cli train-bandit --data <folder>
$PY -m elementml.cli bandit-gate --data <folder> --synthetic results/bandit_eval.json
$PY -m elementml.cli bandit-publish --data <folder>
```

The weekly GitHub workflow `.github/workflows/train-ranker.yml` runs these steps (Mondays, or by hand), uploads nothing and deletes the data folder at the end. Actions are pinned by commit SHA, Python wheels by sha256 (`requirements-ranker.txt`, `--require-hashes`) and PGlite by its lockfile (`tests/pglite/`); CI sets `REQUIRE_PGLITE=1` so the SQL parity test cannot silently skip. GitHub turns scheduled workflows off after 60 idle days: the last passed weights then stay in use, and `api.ml_v2_check()` (daily via pg_cron) reports `stale` after `v2_model_stale_days` (21) so it can be noticed and re-run by hand.

**The real-data gate needs logged pages.** `core.ml_pages` is only written while `foryou_ml_mode` is 1 or 2, so the replay part of the gate can pass only after mode 1 (logging only, readers see exactly today's feed) has run for at least 14 days with at least 200 signed-in readers. Until then `gate_passed` is always false and v2 cannot serve anyone, even in mode 2.

**Offline result (2026-11-09): the synthetic gate FAILS in every world.** See `results/bandit_eval.json` (regenerate with `eval-bandit`). Do not switch v2 on. Means over 5 seeds, 60 simulated readers (10 per type), 14 days (formula -> ts_v2):

| world | NDCG@10 | P@10 | dislike@10 | topics@10 | recovery days | anti-macro reader: macro share (true interest) |
|---|---|---|---|---|---|---|
| normal | 0.454 -> 0.296 (0/5 seeds better) | 0.464 -> 0.271 | 0.060 -> 0.088 | 4.77 -> 5.89 | 4.4 -> 0.4 | 0.058 -> 0.415 (0.003) |
| stress | 0.332 -> 0.270 (0/5) | 0.392 -> 0.248 | 0.080 -> 0.094 | 4.90 -> 5.60 | 4.0 -> 0.0 | 0.130 -> 0.450 (0.040) |
| wild | 0.323 -> 0.264 (0/5) | 0.283 -> 0.178 | 0.080 -> 0.092 | 5.26 -> 5.64 | 1.6 -> 0.0 | 0.208 -> 0.473 (0.055) |

Paging held: 600 frozen scrolls, 0 repeats, 0 same-cursor mismatches. Per type (normal), P@10: rates-and-markets 0.523 -> 0.459, tech reader 0.351 -> 0.079, anti-macro 0.570 -> 0.136, new reader with two follows 0.416 -> 0.272. Why: the weekly fit picked the strongest prior strength on the grid (lambda = 34) for almost every group, so a reader's own signals barely move the beliefs. Almost every feature has a positive population mean (most views end in a long look), and macro cards carry more tags plus the lean. The result is roughly "importance + population taste": macro for everyone and very little personal taste. Two diagnostics (not adopted, normal world): averaging features instead of summing them gave NDCG 0.276. A fixed lambda of 5 gave 0.367, still below 0.454, with a 22% macro share for the anti-macro reader. The formula needs a redesign, not tuning (for example per-reader deviations from the population, a joint fit instead of per-feature beliefs, and keeping v5's follow and dislike terms).

Its limits: the simulator that grades ts_v2 is the same family of simulator its prior is trained on (the gate also needs the real replay), simulated readers carry no slot on their per-card record (so the simulated feed uses propensity 1), and the anti-macro reader stands in for a sports fan.

## Ranking v3 (`elementml/v3/`): the formula plus a per-reader residual (prototype, Python only)

The live formula stays the base. On top of it, each reader gets a bounded personal term in hours. It is built from their own rewards, centered on that reader's usual reward, per card feature (topic, type, source, tag, the same features as v2), with prior mean 0, so there is no pull toward the population average. A new reader gets the formula. In the simulator it beats the formula in 15 of 15 world-seed pairs (NDCG@10 0.454 -> 0.530 normal, 0.332 -> 0.349 stress, 0.323 -> 0.339 wild). It still fails two synthetic-gate checks: topics@10 in normal, and the macro check, which even the formula cannot pass. There is no SQL yet. The numbers, the reasons v2 lost and the simulator audit are in `v3-findings.md`.

| File | What happens there |
|---|---|
| `v3/policy.py` | `V3Config` (every v3 setting), `reader_weights` (diag or ridge), `residual_hours`, `ResidualPolicy` for the simulator. |
| `v3/methods.py` | Method names for the harness: `v3`, `v3:H=36,cap=30,step_extra=1.5`, `v3:solver=ridge`, ... |
| `evaluation/v3_eval.py` | Formula vs v3 (and ts_v2 or its ablations `ts_v2:lam=1,onformula=1`) over worlds and seeds, with the gate per method. |
| `evaluation/v3_curves.py` | NDCG by explicit actions and by day, and paired differences, from `results/v3_eval.json`. |
| `evaluation/sim_audit.py` | Does the ground truth favour the formula? Fixed-order NDCG ceilings, variance shares, importance-taste correlation. |

```
$PY -m elementml.cli eval-v3 --methods "ts_v2;v3;v3:H=36,cap=30,step_extra=1.5"   # about 8 min, 7 workers
$PY -m elementml.cli sim-audit
$PY -m elementml.evaluation.v3_curves
$PY -m pytest tests/test_v3.py -q
```

## Rules this prototype keeps

- Free and local: scikit-learn, LightGBM, numpy. No embedding API, no hosted model.
- Deterministic: fixed seeds, single-threaded LightGBM, stable sorts; the same input gives the same order, so a cursor can page over it.
- Informational only: nothing predicts price moves. The time term is "how much of this card's own length is read", capped, so long cards and engagement bait are not rewarded.
- Privacy: signals are event kinds, dwell milliseconds and times per reader id, the same as `core.user_events`; crowd numbers need 3 or more people.
- Explainable: each card gets one sentence (follow, similar to liked, source habit, topic habit, major story, or "something new").
