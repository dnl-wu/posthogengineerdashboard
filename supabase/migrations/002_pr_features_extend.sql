-- =============================================================================
-- 002_pr_features_extend.sql
-- Adds deterministic flow + touch-hint columns to pr_features.
-- Written by build_features.ts; read by score-prs.ts and enrich-pr.ts.
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is idempotent.
-- =============================================================================

ALTER TABLE pr_features
  -- ── Flow signals ────────────────────────────────────────────────────────
  ADD COLUMN IF NOT EXISTS review_cycles           INT      NOT NULL DEFAULT 0,
  -- Count of CHANGES_REQUESTED reviews (proxy for iteration cost)

  ADD COLUMN IF NOT EXISTS review_coverage         INT      NOT NULL DEFAULT 0,
  -- Distinct reviewer logins (breadth of scrutiny)

  ADD COLUMN IF NOT EXISTS has_description         BOOLEAN  NOT NULL DEFAULT FALSE,
  -- body IS NOT NULL AND trim(body) != ''

  ADD COLUMN IF NOT EXISTS is_merge_to_main        BOOLEAN  NOT NULL DEFAULT TRUE,
  -- base_ref = default branch; TRUE for all PostHog/posthog PRs
  -- (base_ref not stored in prs table — default TRUE; override if ingester adds it)

  ADD COLUMN IF NOT EXISTS total_comments_received INT      NOT NULL DEFAULT 0,
  -- Aggregate of review comments directed at the PR author.
  -- Initialised to 0 here; a later comment-aggregation worker fills it.

  -- ── Touch hints (path-prefix routing) ────────────────────────────────────
  ADD COLUMN IF NOT EXISTS touches_frontend        BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS touches_backend         BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS touches_infra           BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS touches_tests           BOOLEAN  NOT NULL DEFAULT FALSE,

  -- ── Test presence (glob detection) ───────────────────────────────────────
  ADD COLUMN IF NOT EXISTS has_tests               BOOLEAN  NOT NULL DEFAULT FALSE,
  -- TRUE when any changed file matches a test-file pattern

  -- ── Size bucket (routing / per-bucket score caps only) ───────────────────
  ADD COLUMN IF NOT EXISTS size_bucket             TEXT;
  -- 'XS' | 'S' | 'M' | 'L' | 'XL'  (based on additions + deletions)
