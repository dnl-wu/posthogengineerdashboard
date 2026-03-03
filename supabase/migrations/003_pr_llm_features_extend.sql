-- =============================================================================
-- 003_pr_llm_features_extend.sql
-- Adds new Gemini output columns to pr_llm_features.
-- Written by llm_enrich_prs.ts; read by score-prs.ts.
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is idempotent.
-- =============================================================================

ALTER TABLE pr_llm_features
  -- ── Product classification ────────────────────────────────────────────────
  ADD COLUMN IF NOT EXISTS primary_product      TEXT,
  -- One canonical PostHog product slug (analytics, session_replay, etc.)

  ADD COLUMN IF NOT EXISTS secondary_products   TEXT[]       NOT NULL DEFAULT '{}',
  -- Up to 3 additional product slugs meaningfully touched

  -- ── Raw Gemini scalars ────────────────────────────────────────────────────
  ADD COLUMN IF NOT EXISTS impact_signal        NUMERIC(4,2),
  -- Raw 0.0–10.0 value from Gemini (impact_score_0_10); feeds complexity/risk mapping

  ADD COLUMN IF NOT EXISTS confidence           NUMERIC(4,3),
  -- 0.000–1.000 model confidence in the classification

  -- ── Gemini arrays ─────────────────────────────────────────────────────────
  ADD COLUMN IF NOT EXISTS impact_drivers       TEXT[]       NOT NULL DEFAULT '{}',
  -- 1–4 short strings explaining what drives the impact score

  ADD COLUMN IF NOT EXISTS one_liner            TEXT,
  -- ≤120-char terse description; also copied to gemini_rationale (≤200 chars)

  -- ── Operational bookkeeping ───────────────────────────────────────────────
  ADD COLUMN IF NOT EXISTS fallback_used        BOOLEAN      NOT NULL DEFAULT FALSE;
  -- TRUE when the Gemini call failed; row was populated with safe defaults
