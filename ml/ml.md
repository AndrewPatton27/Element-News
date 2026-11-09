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

## Rules this prototype keeps

- Free and local: scikit-learn, LightGBM, numpy. No embedding API, no hosted model.
- Deterministic: fixed seeds, single-threaded LightGBM, stable sorts; the same input gives the same order, so a cursor can page over it.
- Informational only: nothing predicts price moves. The time term is "how much of this card's own length is read", capped, so long cards and engagement bait are not rewarded.
- Privacy: signals are event kinds, dwell milliseconds and times per reader id, the same as `core.user_events`; crowd numbers need 3 or more people.
- Explainable: each card gets one sentence (follow, similar to liked, source habit, topic habit, major story, or "something new").
