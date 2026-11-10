-- Ranking v3: the extra topic step also for cold readers (Drew's decision; see ml/v3-findings.md).
-- Sets core.rank_params v3_step_extra_cold to 1 (allowed range: >= 0, CHECK from 20261112000000_ranking_v3.sql;
-- any value > 0 means on). Effect only while foryou_ml_mode = 3, which stays 0 (v3 OFF): this migration does
-- not touch foryou_ml_mode, so nothing readers see changes until v3 is switched on by hand.
-- With it, a reader with no evidence gets v5's score plus the 2.5 h extra same-topic step (faster cold-reader
-- personalisation, passes the recovery gate) instead of exactly the v5 order. Rollback: set it back to 0.
-- Re-runnable. Needs 20261112000000_ranking_v3.sql. Checked by tests/ranking_v3_check.sql. NOT applied.
insert into core.rank_params (key, value) values ('v3_step_extra_cold', 1)
on conflict (key) do update set value = excluded.value;
