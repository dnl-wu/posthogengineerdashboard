-- =============================================================================
-- 001_initial.sql
-- Engineering Velocity / Impact Dashboard — PostHog/posthog
-- =============================================================================
-- All objects use IF NOT EXISTS so the script is safe to re-run in dev.
-- Tables are created in dependency order (parents before FK children).
-- Service-role access assumed; no RLS policies required for worker tables.
-- =============================================================================


-- =============================================================================
-- LAYER 1: RAW INGEST
-- github-ingest.ts writes; enrich-*.ts reads
-- =============================================================================

CREATE TABLE IF NOT EXISTS prs (
    id              BIGINT        PRIMARY KEY,            -- GitHub PR numeric id
    repo            TEXT          NOT NULL DEFAULT 'PostHog/posthog',
    number          INT           NOT NULL,
    author_login    TEXT          NOT NULL,
    title           TEXT          NOT NULL,
    body            TEXT,                                 -- nullable; may be empty
    state           TEXT          NOT NULL DEFAULT 'closed',
    merged_at       TIMESTAMPTZ   NOT NULL,
    created_at      TIMESTAMPTZ   NOT NULL,
    closed_at       TIMESTAMPTZ,
    label_names     TEXT[]        NOT NULL DEFAULT '{}',
    additions       INT           NOT NULL DEFAULT 0,
    deletions       INT           NOT NULL DEFAULT 0,
    changed_files   INT           NOT NULL DEFAULT 0,
    enriched_at     TIMESTAMPTZ,                          -- NULL until pr_features + pr_llm_features written
    ingested_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT prs_repo_number_uq UNIQUE (repo, number)
);

-- hot: per-author PR list
CREATE INDEX IF NOT EXISTS prs_author_idx
    ON prs (author_login);

-- hot: window range scans (last 90 / 120 days)
CREATE INDEX IF NOT EXISTS prs_merged_idx
    ON prs (merged_at DESC);

-- hot: enrichment worker batch pick-up
CREATE INDEX IF NOT EXISTS prs_pending_enrich_idx
    ON prs (ingested_at)
    WHERE enriched_at IS NULL;

-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pr_changed_files (
    id             BIGSERIAL     PRIMARY KEY,
    pr_id          BIGINT        NOT NULL
                       REFERENCES prs (id) ON DELETE CASCADE,
    filename       TEXT          NOT NULL,               -- full repo path
    additions      INT           NOT NULL DEFAULT 0,
    deletions      INT           NOT NULL DEFAULT 0,
    touch_type     TEXT          NOT NULL,               -- 'add'|'modify'|'delete'|'rename'
    patch_excerpt  TEXT,                                 -- first 40 lines of unified diff; NULL for binary

    CONSTRAINT pr_changed_files_pr_file_uq
        UNIQUE (pr_id, filename),
    CONSTRAINT pr_changed_files_touch_type_ck
        CHECK (touch_type IN ('add', 'modify', 'delete', 'rename'))
);

-- hot: JOIN prs → pr_changed_files; subsystem extraction
CREATE INDEX IF NOT EXISTS pr_changed_files_pr_idx
    ON pr_changed_files (pr_id);

-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pr_reviews (
    id                BIGINT        PRIMARY KEY,          -- GitHub review id
    pr_id             BIGINT        NOT NULL
                          REFERENCES prs (id) ON DELETE CASCADE,
    pr_number         INT           NOT NULL,             -- denormalised
    reviewer_login    TEXT          NOT NULL,
    state             TEXT          NOT NULL,             -- 'APPROVED'|'CHANGES_REQUESTED'|'COMMENTED'
    submitted_at      TIMESTAMPTZ   NOT NULL,
    body              TEXT,
    n_comments        INT           NOT NULL DEFAULT 0,   -- total inline + top-level
    n_inline_comments INT           NOT NULL DEFAULT 0,
    comments_json     JSONB         NOT NULL DEFAULT '[]', -- [{path, body, created_at}]
    enriched_at       TIMESTAMPTZ,
    ingested_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT pr_reviews_state_ck
        CHECK (state IN ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'))
);

-- hot: JOIN pr_reviews → prs
CREATE INDEX IF NOT EXISTS pr_reviews_pr_idx
    ON pr_reviews (pr_id);

-- hot: per-reviewer scoring + aggregation
CREATE INDEX IF NOT EXISTS pr_reviews_reviewer_idx
    ON pr_reviews (reviewer_login);

-- hot: enrichment worker pick-up
CREATE INDEX IF NOT EXISTS pr_reviews_pending_enrich_idx
    ON pr_reviews (ingested_at)
    WHERE enriched_at IS NULL;


-- =============================================================================
-- LAYER 2: FEATURE EXTRACTION
-- Deterministic (pr_features) + LLM (pr_llm_features, review_llm_features)
-- =============================================================================

-- Deterministic structural signals — no LLM calls
-- Computed by enrich-pr.ts before the Gemini call; also injected into prompt
CREATE TABLE IF NOT EXISTS pr_features (
    pr_id                BIGINT        PRIMARY KEY
                             REFERENCES prs (id) ON DELETE CASCADE,

    -- touch hints (derived from pr_changed_files)
    subsystem_list       TEXT[]        NOT NULL DEFAULT '{}',
    -- distinct top-level dirs, e.g. {'posthog/api','frontend','ee'}
    n_files_changed      INT           NOT NULL,
    n_subsystems_touched INT           NOT NULL,

    -- scoring inputs
    churn_ratio          NUMERIC(5,3),
    -- deletions / (additions + deletions); NULL when net lines = 0
    cycle_time_hours     NUMERIC(8,2),
    -- EXTRACT(EPOCH FROM merged_at - created_at) / 3600
    review_lag_hours     NUMERIC(8,2),
    -- created_at → first pr_reviews.submitted_at; NULL if no reviews

    computed_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- All access is by pr_id (PK lookup); no additional indexes required.

-- -----------------------------------------------------------------------------

-- Gemini structured-output fields for a PR
-- Separated so prompt_version + input_hash form a clean cache key
CREATE TABLE IF NOT EXISTS pr_llm_features (
    pr_id                  BIGINT        PRIMARY KEY
                               REFERENCES prs (id) ON DELETE CASCADE,

    -- auditability
    model_name             TEXT          NOT NULL DEFAULT 'gemini-2.0-flash',
    prompt_version         TEXT          NOT NULL,
    -- semver string, e.g. '1.0.0'; bump whenever system prompt changes
    input_hash             TEXT          NOT NULL,
    -- SHA-256 hex of exact prompt user-turn; dedup / cache key
    raw_response           JSONB,
    -- full model response retained for debugging; nullable

    -- scored dimensions 0–100
    complexity_score       SMALLINT      NOT NULL
                               CHECK (complexity_score    BETWEEN 0 AND 100),
    risk_score             SMALLINT      NOT NULL
                               CHECK (risk_score          BETWEEN 0 AND 100),
    cross_cutting_score    SMALLINT      NOT NULL
                               CHECK (cross_cutting_score BETWEEN 0 AND 100),
    user_facing_score      SMALLINT      NOT NULL
                               CHECK (user_facing_score   BETWEEN 0 AND 100),
    tech_debt_delta        SMALLINT      NOT NULL
                               CHECK (tech_debt_delta     BETWEEN -50 AND 50),

    -- classification
    pr_category            TEXT          NOT NULL,
    -- 'feature'|'bug_fix'|'refactor'|'test'|'docs'|'infra'|'perf'|'security'
    is_breaking_change     BOOLEAN       NOT NULL DEFAULT FALSE,
    touches_critical_path  BOOLEAN       NOT NULL DEFAULT FALSE,
    -- billing / auth / ingestion pipeline / query engine

    gemini_rationale       TEXT,         -- 1-3 sentence justification, max 200 chars
    enriched_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT pr_llm_features_category_ck
        CHECK (pr_category IN
               ('feature','bug_fix','refactor','test','docs','infra','perf','security'))
);

-- hot: dedup check before issuing a Gemini call
CREATE INDEX IF NOT EXISTS pr_llm_features_cache_idx
    ON pr_llm_features (prompt_version, input_hash);

-- -----------------------------------------------------------------------------

-- Gemini structured-output fields for a review
-- Mirrors pr_llm_features pattern; written by enrich-review.ts
CREATE TABLE IF NOT EXISTS review_llm_features (
    review_id            BIGINT        PRIMARY KEY
                             REFERENCES pr_reviews (id) ON DELETE CASCADE,

    -- denormalised for join-free scoring queries
    pr_id                BIGINT        NOT NULL,
    reviewer_login       TEXT          NOT NULL,

    -- auditability
    model_name           TEXT          NOT NULL DEFAULT 'gemini-2.0-flash',
    prompt_version       TEXT          NOT NULL,
    input_hash           TEXT          NOT NULL,
    raw_response         JSONB,

    -- scored dimensions 0–100
    depth_score          SMALLINT      NOT NULL
                             CHECK (depth_score          BETWEEN 0 AND 100),
    actionability_score  SMALLINT      NOT NULL
                             CHECK (actionability_score  BETWEEN 0 AND 100),
    correctness_focus    SMALLINT      NOT NULL
                             CHECK (correctness_focus    BETWEEN 0 AND 100),
    architecture_focus   SMALLINT      NOT NULL
                             CHECK (architecture_focus   BETWEEN 0 AND 100),
    tone_score           SMALLINT      NOT NULL
                             CHECK (tone_score           BETWEEN 0 AND 100),

    gemini_rationale     TEXT,
    response_time_hours  NUMERIC(8,2), -- prs.created_at → pr_reviews.submitted_at
    enriched_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- hot: per-reviewer scoring worker scan
CREATE INDEX IF NOT EXISTS review_llm_features_reviewer_idx
    ON review_llm_features (reviewer_login);

-- hot: JOIN review_llm_features → pr_reviews → prs
CREATE INDEX IF NOT EXISTS review_llm_features_pr_idx
    ON review_llm_features (pr_id);


-- =============================================================================
-- LAYER 3: SCORING  (deterministic formulas; no LLM calls)
-- score-prs.ts writes pr_scores; score-reviews.ts writes review_scores
-- Formula reference: docs/plan.md §4
-- =============================================================================

CREATE TABLE IF NOT EXISTS pr_scores (
    pr_id             BIGINT        PRIMARY KEY
                          REFERENCES prs (id) ON DELETE CASCADE,

    -- denormalised for aggregate queries without a JOIN
    author_login      TEXT          NOT NULL,
    merged_at         TIMESTAMPTZ   NOT NULL,

    -- sub-scores 0.0–1.0
    impact_score      NUMERIC(6,4)  NOT NULL,
    -- = (0.30×complexity + 0.25×risk + 0.20×cross_cutting
    --    + 0.15×user_facing + 0.10×|tech_debt_delta|×2) / 100
    delivery_score    NUMERIC(6,4)  NOT NULL,
    -- = clamp(1 - cycle_time/336, 0, 1) × (1 - churn×0.5) × (breaking ? 0.90 : 1)
    breadth_score     NUMERIC(6,4)  NOT NULL,
    -- = min(1, n_subsystems/5) × (cross_cutting/100)

    -- category multiplier: security=1.20 perf=1.10 bug_fix=1.05 feature=1.00
    --                       infra=0.95 refactor=0.90 test=0.70 docs=0.60
    category_weight   NUMERIC(4,3)  NOT NULL,

    -- final: category_weight × (0.55×impact + 0.25×delivery + 0.20×breadth)
    raw_pr_score      NUMERIC(6,4)  NOT NULL,

    week_start        DATE          NOT NULL,  -- Monday of ISO week of merged_at
    scored_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- hot: per-author weekly aggregation in rollup.ts
CREATE INDEX IF NOT EXISTS pr_scores_author_week_idx
    ON pr_scores (author_login, week_start DESC);

-- hot: full-team weekly band computation
CREATE INDEX IF NOT EXISTS pr_scores_week_idx
    ON pr_scores (week_start DESC);

-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS review_scores (
    review_id         BIGINT        PRIMARY KEY
                          REFERENCES pr_reviews (id) ON DELETE CASCADE,

    -- denormalised
    reviewer_login    TEXT          NOT NULL,
    pr_id             BIGINT        NOT NULL,
    submitted_at      TIMESTAMPTZ   NOT NULL,

    -- sub-scores
    quality_score     NUMERIC(6,4)  NOT NULL,
    -- = (0.30×depth + 0.25×actionability + 0.25×correctness
    --    + 0.15×architecture + 0.05×tone) / 100
    engagement_bonus  NUMERIC(4,3)  NOT NULL DEFAULT 0,
    -- +0.10 CHANGES_REQUESTED | +0.05 response<4h | +0.05 inline>=5

    -- final: min(1.0, quality + engagement)
    raw_review_score  NUMERIC(6,4)  NOT NULL,

    week_start        DATE          NOT NULL,  -- Monday of ISO week of submitted_at
    scored_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- hot: per-reviewer weekly aggregation
CREATE INDEX IF NOT EXISTS review_scores_reviewer_week_idx
    ON review_scores (reviewer_login, week_start DESC);


-- =============================================================================
-- LAYER 4: ROLLUP / AGGREGATION
-- rollup.ts writes all four tables below
-- =============================================================================

-- Per-engineer, per-week velocity rollup
-- composite = 0.70 × avg_pr_score + 0.30 × avg_review_score
CREATE TABLE IF NOT EXISTS engineer_weekly_velocity (
    id                BIGSERIAL     PRIMARY KEY,
    author_login      TEXT          NOT NULL,
    week_start        DATE          NOT NULL,             -- Monday of ISO week

    -- PR component (70% weight)
    n_prs_merged      INT           NOT NULL DEFAULT 0,
    avg_pr_score      NUMERIC(6,4)  NOT NULL DEFAULT 0,
    sum_pr_score      NUMERIC(8,4)  NOT NULL DEFAULT 0,

    -- Review component (30% weight)
    n_reviews         INT           NOT NULL DEFAULT 0,
    avg_review_score  NUMERIC(6,4)  NOT NULL DEFAULT 0,
    sum_review_score  NUMERIC(8,4)  NOT NULL DEFAULT 0,

    -- composite
    raw_composite     NUMERIC(6,4)  NOT NULL,
    team_percentile   NUMERIC(5,2),                      -- NULL if <3 engineers active

    computed_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT engineer_weekly_velocity_uq
        UNIQUE (author_login, week_start)
);

-- hot: per-engineer timeline drill-down  (/api/engineer/:login)
CREATE INDEX IF NOT EXISTS ewv_author_week_idx
    ON engineer_weekly_velocity (author_login, week_start DESC);

-- hot: leaderboard rank order within a week; also band percentile computation
CREATE INDEX IF NOT EXISTS ewv_week_score_idx
    ON engineer_weekly_velocity (week_start DESC, raw_composite DESC);

-- -----------------------------------------------------------------------------

-- Pre-computed team distribution per ISO week
-- Eliminates repeated percentile_cont() calls on every API request
CREATE TABLE IF NOT EXISTS team_weekly_velocity (
    week_start      DATE          PRIMARY KEY,            -- Monday of ISO week
    n_active        INT           NOT NULL DEFAULT 0,     -- engineers with >=1 PR or review
    mean_composite  NUMERIC(6,4),
    p25_composite   NUMERIC(6,4),
    p50_composite   NUMERIC(6,4),
    p75_composite   NUMERIC(6,4),
    computed_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- PK range scan covers all API access patterns; no additional indexes needed.

-- -----------------------------------------------------------------------------

-- Materialised 90-day aggregate per engineer
-- Single row per engineer; replaced in-place each rollup run
-- Powers /api/leaderboard ranked table without per-request window recomputation
CREATE TABLE IF NOT EXISTS engineer_scores_90d (
    author_login      TEXT          PRIMARY KEY,
    window_end        DATE          NOT NULL,             -- date snapshot was computed

    -- PR aggregate (rolling 90-day window)
    n_prs_merged      INT           NOT NULL DEFAULT 0,
    avg_pr_score      NUMERIC(6,4)  NOT NULL DEFAULT 0,

    -- Review aggregate
    n_reviews_given   INT           NOT NULL DEFAULT 0,
    avg_review_score  NUMERIC(6,4)  NOT NULL DEFAULT 0,

    -- composite
    raw_composite     NUMERIC(6,4)  NOT NULL DEFAULT 0,
    avg_percentile    NUMERIC(5,2), -- mean team_percentile across weeks active; NULL if never ranked
    rank              INT,          -- ordinal rank among engineers; NULL if no activity

    computed_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- hot: leaderboard ORDER BY composite DESC
CREATE INDEX IF NOT EXISTS es90d_rank_idx
    ON engineer_scores_90d (raw_composite DESC);


-- =============================================================================
-- LAYER 5: DERIVED SUMMARIES
-- rollup.ts writes; /api/engineer/:login reads
-- =============================================================================

-- Pre-materialised notable PR evidence per engineer
-- Backed by pr_scores; rollup.ts re-populates this after each scoring run
-- /api/engineer/:login uses top 10 rows by raw_pr_score for the top_prs array
CREATE TABLE IF NOT EXISTS engineer_evidence (
    id             BIGSERIAL     PRIMARY KEY,
    author_login   TEXT          NOT NULL,
    pr_id          BIGINT        NOT NULL
                       REFERENCES prs (id) ON DELETE CASCADE,
    evidence_type  TEXT          NOT NULL,
    -- 'top_pr' | 'critical_path' | 'high_complexity' | 'security' | 'high_impact'
    raw_pr_score   NUMERIC(6,4)  NOT NULL,               -- denormalised for ORDER BY without JOIN
    week_start     DATE          NOT NULL,

    CONSTRAINT engineer_evidence_uq
        UNIQUE (author_login, pr_id, evidence_type)
);

-- hot: top-N PRs for /api/engineer/:login  (top 10 by score)
CREATE INDEX IF NOT EXISTS engineer_evidence_author_score_idx
    ON engineer_evidence (author_login, raw_pr_score DESC);

-- -----------------------------------------------------------------------------

-- Subsystem specialisation per engineer
-- Derived from pr_changed_files; one row per (engineer, top-level dir)
-- Powers area chips in the UI and potential future specialisation scoring
CREATE TABLE IF NOT EXISTS engineer_areas (
    id              BIGSERIAL     PRIMARY KEY,
    author_login    TEXT          NOT NULL,
    area            TEXT          NOT NULL,
    -- top-level repo directory, e.g. 'posthog/api', 'frontend', 'ee'
    n_prs           INT           NOT NULL DEFAULT 0,
    n_files_touched INT           NOT NULL DEFAULT 0,
    last_touched_at TIMESTAMPTZ,                         -- MAX(prs.merged_at) for this area

    CONSTRAINT engineer_areas_uq
        UNIQUE (author_login, area)
);

-- hot: per-engineer area list
CREATE INDEX IF NOT EXISTS engineer_areas_author_idx
    ON engineer_areas (author_login);
