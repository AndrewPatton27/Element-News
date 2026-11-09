# Ranking v3: findings (2026-11-09, simulated readers only)

**Verdict: GO for a SQL port of v3 in shadow mode. NO-GO for serving it now.** On held-out seeds 1-5, v3 beats today's formula on NDCG@10 in every world and every seed (15/15). It also lowers dislikes and the anti-macro reader's macro share. It still fails the synthetic gate on two points (see below), and the real-data replay gate is still required.

## What v3 is

The formula stays the base. A bounded per-reader term is added on top:

```
r_i   = card reward (existing weights: like +1, detail +0.5, source +0.5, long look +0.25, quick skip -0.15, dislike -1; capped -1..1.5)
f_i   = 14-day fade;  rbar = sum f r / (sum f + 3)           the reader's own usual reward
d_i   = r_i - rbar                                           centered: better or worse than usual
b_j   = sum_i f_i d_i [j on card i] / (2 + sum_i f_i [j on i])   per feature j (c: topic, t: type, s: source, g: tag); prior mean 0
hours = clamp(36 x (b_c + 0.5 b_t + 0.5 b_s + sum b_g), -30, 30)
score = formula score (follow, affinity, explore, trend, seen penalty) + hours; same-topic step 0.75 + 1.5 h; diversify
```

A reader with no evidence gets the formula, apart from the larger same-topic step. Updates are immediate. In SQL this is one GROUP BY over `core.user_events` joined with the existing `core.v2_features`. It needs no training job, no population prior, no exploration draws and no new signals. Code: `elementml/v3/`. Tests: `tests/test_v3.py`.

## Results (held-out seeds 1-5, 60 readers, 14 days; mean, sd over seeds)

| world | method | NDCG@10 | wins | P@10 | dislike@10 | topics@10 | recovery d | anti-macro macro share |
|---|---|---|---|---|---|---|---|---|
| normal | formula | 0.454 (0.015) | | 0.464 | 0.060 | 4.77 | 4.4 | 0.058 |
| normal | ts_v2 | 0.296 (0.007) | 0/5 | 0.271 | 0.087 | 5.89 | 0.4 | 0.415 |
| normal | **v3** | **0.530 (0.018)** | 5/5 | 0.556 | 0.051 | 4.43 | 5.4 | 0.013 |
| stress | formula | 0.332 (0.008) | | 0.392 | 0.080 | 4.90 | 4.0 | 0.130 |
| stress | ts_v2 | 0.270 (0.007) | 0/5 | 0.248 | 0.093 | 5.60 | 0.0 | 0.450 |
| stress | **v3** | **0.349 (0.009)** | 5/5 | 0.446 | 0.076 | 4.66 | 2.6 | 0.062 |
| wild | formula | 0.323 (0.010) | | 0.283 | 0.080 | 5.26 | 1.6 | 0.208 |
| wild | ts_v2 | 0.264 (0.013) | 0/5 | 0.178 | 0.092 | 5.64 | 0.0 | 0.473 |
| wild | **v3** | **0.339 (0.013)** | 5/5 | 0.330 | 0.077 | 5.02 | 2.0 | 0.097 |

Paired NDCG gain over the formula, min to max over the seeds: normal +0.062 to +0.087, stress +0.014 to +0.021, wild +0.012 to +0.022.

**How fast it learns (normal world, NDCG@10 by the number of explicit actions before the session):**

| actions | 0-4 | 5-14 | 15-29 | 30-59 | 60+ |
|---|---|---|---|---|---|
| formula | 0.264 | 0.362 | 0.440 | 0.455 | 0.484 |
| v3 | 0.279 | 0.421 | 0.499 | 0.513 | 0.570 |

After 15-29 actions, v3 already beats the formula's level at 60 or more.

Variants (held out): plain v3 (H 24, cap 24, no extra step) scored 0.520 / 0.345 / 0.337. A full joint ridge solve scored 0.503 / 0.341 / 0.331, worse than the per-feature version, so per-feature independence is not the problem. Thompson draws cost 0.008 on the tuning seeds, so they are off. The final settings were picked on tuning seeds 101-102 (normal and stress) before seeds 1-5 were run.

## Why v2 lost (normal world, seeds 1-5, NDCG@10)

| change to ts_v2 | NDCG@10 |
|---|---|
| as shipped (lambda 34) | 0.296 |
| macro lean 0 | 0.298 (the lean is not the cause) |
| lambda 1 | 0.412 |
| lambda 1, no lean, no population mean, no draws | 0.409 |
| v2's hours **added on top of the formula** (lambda 34) | 0.489 (5/5 over the formula) |
| the same with lambda 1, no lean, no mean, no draws | 0.510 |

The main cause is that v2 replaced the formula's personal terms (the follow boost of 6 h, affinity worth up to 12 h with dislikes counting double, and the explore term) with one capped term. The second cause is the strong prior (lambda 34), which keeps each reader close to the population. The lean, the population mean and exploration each matter by about 0.01 or less. Centering rewards adds about +0.01 (an uncentered k0 = 1000 variant scored 0.485 against 0.495 on the tuning seeds). In the on-formula rows, v2's seen penalty is counted twice, a small bias against them.

## Simulator audit (`cli sim-audit`, cold start, 3 seeds)

- The ground truth contains importance and age (16% of the hidden-score variance in normal). rank_score alone gets NDCG 0.264 against 0.120 for random. Every method keeps rank_score, so this favours no method over another. It does cap what personalisation can add.
- Importance is correlated with true taste: +0.31 for the rates reader, -0.42 for the anti-macro reader, -0.22 for the tech reader. Because macro cards carry more importance, any base-heavy ranker leans toward macro.
- The headroom is small outside the normal world. The best ordering using rank_score plus the reader's true topic term reaches 0.716 in normal, 0.431 in stress and 0.476 in wild. Noise is 74% of the hidden-score variance in stress, so +0.017 there is a large share of what can be gained.
- **The gate's macro test cannot be met.** It asks for at most 1.2 x the true interest (about 0.004 in normal), and the formula itself scores 0.058. Proposed change: compare against the formula's share.

## Gate status of v3

- normal: fails topics@10 (-0.34; the limit is -0.30) and macro (unmeetable test).
- stress: passes everything.
- wild: fails macro only (0.097 against a limit of 1.2 x 0.055).
- Recovery in normal is +1.0 day, exactly at the limit.

Next step: tune `step_extra` around 2 on the tuning seeds, then re-run once on seeds 1-5.

## Limits

These are simulated readers graded by the same simulator family, so nothing here is a gain for real readers. The gains in stress and wild are small (+0.017). The tags only separate subtopics because the synthetic headlines contain the `core.tag_rules` keywords; real headlines will match less often. SQL parity is not written yet, so v3 is untested in Postgres.
