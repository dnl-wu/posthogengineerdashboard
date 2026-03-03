-- =============================================================================
-- 004_engineer_scores_30d.sql
-- Add a 30-day sub-window to engineer_scores_90d.
--
-- The existing 90-day columns and all dependent tables are unchanged.
-- rollup.ts computes both windows from the same already-loaded pr_scores /
-- review_scores rows, then upserts a single combined row per engineer.
-- =============================================================================

ALTER TABLE engineer_scores_90d
    ADD COLUMN IF NOT EXISTS n_prs_merged_30d     INT           NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avg_pr_score_30d     NUMERIC(6,4)  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS n_reviews_given_30d  INT           NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avg_review_score_30d NUMERIC(6,4)  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS raw_composite_30d    NUMERIC(6,4)  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rank_30d             INT;          -- NULL if no activity in last 30 d

-- hot: 30-day leaderboard ORDER BY
CREATE INDEX IF NOT EXISTS es90d_rank_30d_idx
    ON engineer_scores_90d (raw_composite_30d DESC);
