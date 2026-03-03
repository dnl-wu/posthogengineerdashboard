# Database Schema — Engineering Velocity / Impact Dashboard

> Supabase Postgres (pg 15).
> All tables live in the `public` schema.
> All write operations use `SUPABASE_SERVICE_ROLE_KEY` (server-side workers + Next.js API routes only).
> Migration file: `supabase/migrations/001_initial.sql`

---

## Table Inventory

| # | Table | Layer | Written by | Read by |
|---|-------|-------|------------|---------|
| 1 | `prs` | Ingest | `github-ingest.ts` | `enrich-pr.ts`, debug |
| 2 | `pr_changed_files` | Ingest | `github-ingest.ts` | `enrich-pr.ts`, `score-prs.ts` |
| 3 | `pr_reviews` | Ingest | `github-ingest.ts` | `enrich-review.ts`, debug |
| 4 | `pr_features` | Feature extraction | `enrich-pr.ts` | `score-prs.ts` |
| 5 | `pr_llm_features` | Feature extraction | `enrich-pr.ts` | `score-prs.ts` |
| 6 | `review_llm_features` | Feature extraction | `enrich-review.ts` | `score-reviews.ts` |
| 7 | `pr_scores` | Scoring | `score-prs.ts` | `rollup.ts`, `/api/prs/:login` |
| 8 | `review_scores` | Scoring | `score-reviews.ts` | `rollup.ts` |
| 9 | `engineer_weekly_velocity` | Rollup | `rollup.ts` | `/api/leaderboard`, `/api/engineer/:login` |
| 10 | `team_weekly_velocity` | Rollup | `rollup.ts` | `/api/leaderboard`, `/api/engineer/:login` |
| 11 | `engineer_scores_90d` | Rollup | `rollup.ts` | `/api/leaderboard` |
| 12 | `engineer_evidence` | Derived | `rollup.ts` | `/api/engineer/:login` |
| 13 | `engineer_areas` | Derived | `rollup.ts` | `/api/engineer/:login` |

---

## 1. `prs`

**Purpose:** Raw GitHub PR snapshot. One row per merged PR in the ingest window.
The `files_json` blob from the GitHub API is normalised out into `pr_changed_files`; this table holds only header-level fields.

**Primary key:** `id` (GitHub PR numeric id — globally unique, stable)

**Unique constraint:** `(repo, number)` — supports upsert by repo + PR number, useful when re-ingesting.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGINT` PK | GitHub PR id |
| `repo` | `TEXT` | `'PostHog/posthog'` default |
| `number` | `INT` | PR number within repo |
| `author_login` | `TEXT` | GitHub username |
| `title` | `TEXT` | |
| `body` | `TEXT` | nullable |
| `state` | `TEXT` | always `'closed'` post-filter |
| `merged_at` | `TIMESTAMPTZ` | NOT NULL — filter anchor |
| `created_at` | `TIMESTAMPTZ` | used for cycle_time + review_lag |
| `closed_at` | `TIMESTAMPTZ` | nullable |
| `label_names` | `TEXT[]` | e.g. `{bug, needs-review}` |
| `additions` | `INT` | total additions |
| `deletions` | `INT` | total deletions |
| `changed_files` | `INT` | total file count |
| `enriched_at` | `TIMESTAMPTZ` | NULL until `enrich-pr.ts` writes `pr_features` + `pr_llm_features` |
| `ingested_at` | `TIMESTAMPTZ` | set on insert |

**Indexes:**

| Index | Columns | Purpose |
|-------|---------|---------|
| `prs_author_idx` | `author_login` | per-author PR list queries |
| `prs_merged_idx` | `merged_at DESC` | window range scans |
| `prs_pending_enrich` | `ingested_at` WHERE `enriched_at IS NULL` | enrichment worker pick-up |

---

## 2. `pr_changed_files`

**Purpose:** One row per file touched by a PR. Normalises the `files` array from the GitHub API.
Feeds `enrich-pr.ts` (prompt construction) and `score-prs.ts` (subsystem count, touch type aggregation).

**Primary key:** `id` (surrogate BIGSERIAL)

**Unique constraint:** `(pr_id, filename)` — safe upsert on re-ingest.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGSERIAL` PK | surrogate |
| `pr_id` | `BIGINT` FK → `prs.id` | ON DELETE CASCADE |
| `filename` | `TEXT` | full repo path, e.g. `posthog/api/feature_flag.py` |
| `additions` | `INT` | |
| `deletions` | `INT` | |
| `touch_type` | `TEXT` | `'add' \| 'modify' \| 'delete' \| 'rename'`; CHECK enforced |
| `patch_excerpt` | `TEXT` | first 40 lines of unified diff; nullable for binary/large |

**Indexes:**

| Index | Columns | Purpose |
|-------|---------|---------|
| `pr_changed_files_pr_idx` | `pr_id` | JOIN to `prs`; subsystem extraction |

---

## 3. `pr_reviews`

**Purpose:** Raw GitHub review snapshot. One row per review object (not per inline comment).
Inline comments are collapsed into `comments_json` for prompt construction.

**Primary key:** `id` (GitHub review id)

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGINT` PK | GitHub review id |
| `pr_id` | `BIGINT` FK → `prs.id` | ON DELETE CASCADE |
| `pr_number` | `INT` | denormalised for convenience |
| `reviewer_login` | `TEXT` | |
| `state` | `TEXT` | `APPROVED \| CHANGES_REQUESTED \| COMMENTED`; CHECK enforced |
| `submitted_at` | `TIMESTAMPTZ` | |
| `body` | `TEXT` | nullable top-level review body |
| `n_comments` | `INT` | total inline + top-level count |
| `n_inline_comments` | `INT` | inline comments only |
| `comments_json` | `JSONB` | `[{path, body, created_at}]` array; first 10 items used in prompt |
| `enriched_at` | `TIMESTAMPTZ` | NULL until `enrich-review.ts` writes `review_llm_features` |
| `ingested_at` | `TIMESTAMPTZ` | |

**Indexes:**

| Index | Columns | Purpose |
|-------|---------|---------|
| `pr_reviews_pr_idx` | `pr_id` | JOIN to `prs` |
| `pr_reviews_reviewer_idx` | `reviewer_login` | per-reviewer review list |
| `pr_reviews_pending_enrich` | `ingested_at` WHERE `enriched_at IS NULL` | enrichment worker pick-up |

---

## 4. `pr_features`

**Purpose:** Deterministic structural signals extracted from `prs` + `pr_changed_files` by `enrich-pr.ts` before any LLM call.
Provides "touch hints" (subsystem list, churn, cycle time) that are also injected into the Gemini prompt.

**Primary key:** `pr_id` (1-to-1 with `prs`)

| Column | Type | Notes |
|--------|------|-------|
| `pr_id` | `BIGINT` PK FK → `prs.id` | |
| `subsystem_list` | `TEXT[]` | distinct top-level dirs touched, e.g. `{frontend, posthog/api, ee}` |
| `n_files_changed` | `INT` | mirrors `prs.changed_files`; stored here for scoring join convenience |
| `n_subsystems_touched` | `INT` | `array_length(subsystem_list, 1)` |
| `churn_ratio` | `NUMERIC(5,3)` | `deletions / (additions + deletions)`; NULL if zero net lines |
| `cycle_time_hours` | `NUMERIC(8,2)` | `EXTRACT(EPOCH FROM merged_at - created_at) / 3600` |
| `review_lag_hours` | `NUMERIC(8,2)` | `created_at` → first `pr_reviews.submitted_at`; NULL if no reviews |
| `computed_at` | `TIMESTAMPTZ` | |

No additional indexes needed beyond PK (all lookups are by `pr_id`).

---

## 5. `pr_llm_features`

**Purpose:** Gemini-structured-output fields for a PR. Separated from deterministic features so the cache key (`prompt_version` + `input_hash`) is unambiguous and re-enrichment only touches this table.

**Primary key:** `pr_id` (1-to-1 with `prs`)

**Cache index:** `(prompt_version, input_hash)` — worker checks this before issuing a Gemini call.

| Column | Type | Notes |
|--------|------|-------|
| `pr_id` | `BIGINT` PK FK → `prs.id` | |
| `model_name` | `TEXT` | e.g. `'gemini-2.0-flash'` |
| `prompt_version` | `TEXT` | semver, e.g. `'1.0.0'`; bump when system prompt changes |
| `input_hash` | `TEXT` | SHA-256 hex of exact prompt user-turn; cache key |
| `raw_response` | `JSONB` | full model JSON; retained for debugging; nullable |
| `complexity_score` | `SMALLINT` | 0–100; CHECK constraint |
| `risk_score` | `SMALLINT` | 0–100 |
| `cross_cutting_score` | `SMALLINT` | 0–100 |
| `user_facing_score` | `SMALLINT` | 0–100 |
| `tech_debt_delta` | `SMALLINT` | -50 to +50; CHECK constraint |
| `pr_category` | `TEXT` | `feature \| bug_fix \| refactor \| test \| docs \| infra \| perf \| security`; CHECK |
| `is_breaking_change` | `BOOLEAN` | |
| `touches_critical_path` | `BOOLEAN` | billing / auth / ingestion / query engine |
| `gemini_rationale` | `TEXT` | 1–3 sentence justification; max 200 chars |
| `enriched_at` | `TIMESTAMPTZ` | |

**Indexes:**

| Index | Columns | Purpose |
|-------|---------|---------|
| `pr_llm_features_cache_idx` | `(prompt_version, input_hash)` | dedup check before Gemini call |

---

## 6. `review_llm_features`

**Purpose:** Gemini-structured-output fields for a review. Mirrors `pr_llm_features` pattern for reviews.
`enrich-review.ts` writes here and then stamps `pr_reviews.enriched_at`.

**Primary key:** `review_id` (1-to-1 with `pr_reviews`)

| Column | Type | Notes |
|--------|------|-------|
| `review_id` | `BIGINT` PK FK → `pr_reviews.id` | |
| `pr_id` | `BIGINT` | denormalised for join-free scoring |
| `reviewer_login` | `TEXT` | denormalised |
| `model_name` | `TEXT` | |
| `prompt_version` | `TEXT` | |
| `input_hash` | `TEXT` | SHA-256 of prompt user-turn |
| `raw_response` | `JSONB` | nullable |
| `depth_score` | `SMALLINT` | 0–100 |
| `actionability_score` | `SMALLINT` | 0–100 |
| `correctness_focus` | `SMALLINT` | 0–100 |
| `architecture_focus` | `SMALLINT` | 0–100 |
| `tone_score` | `SMALLINT` | 0–100 |
| `gemini_rationale` | `TEXT` | nullable |
| `response_time_hours` | `NUMERIC(8,2)` | `pr.created_at → review.submitted_at`; computed pre-call |
| `enriched_at` | `TIMESTAMPTZ` | |

**Indexes:**

| Index | Columns | Purpose |
|-------|---------|---------|
| `review_llm_features_reviewer_idx` | `reviewer_login` | per-reviewer scoring worker scan |
| `review_llm_features_pr_idx` | `pr_id` | JOIN to `pr_reviews` |

---

## 7. `pr_scores`

**Purpose:** Deterministic per-PR composite score. Computed by `score-prs.ts` from `pr_features` + `pr_llm_features`.
Source of truth for PR-level scoring; `engineer_weekly_velocity` is derived from this.

**Primary key:** `pr_id`

Formula reference: `docs/plan.md §4`.

| Column | Type | Notes |
|--------|------|-------|
| `pr_id` | `BIGINT` PK FK → `prs.id` | |
| `author_login` | `TEXT` | denormalised for aggregate queries |
| `merged_at` | `TIMESTAMPTZ` | denormalised for window filters |
| `impact_score` | `NUMERIC(6,4)` | 0–1; weighted avg of LLM dimension scores |
| `delivery_score` | `NUMERIC(6,4)` | 0–1; f(cycle_time, churn, breaking) |
| `breadth_score` | `NUMERIC(6,4)` | 0–1; f(n_subsystems, cross_cutting) |
| `category_weight` | `NUMERIC(4,3)` | 0.60–1.20; multiplier by `pr_category` |
| `raw_pr_score` | `NUMERIC(6,4)` | 0–1; final composite |
| `week_start` | `DATE` | Monday of ISO week of `merged_at` |
| `scored_at` | `TIMESTAMPTZ` | |

**Indexes:**

| Index | Columns | Purpose |
|-------|---------|---------|
| `pr_scores_author_week_idx` | `(author_login, week_start DESC)` | per-author weekly aggregation in rollup |
| `pr_scores_week_idx` | `week_start DESC` | full-team weekly aggregation |

---

## 8. `review_scores`

**Purpose:** Deterministic per-review score. Computed by `score-reviews.ts` from `review_llm_features`.

**Primary key:** `review_id`

Formula reference: `docs/plan.md §4`.

| Column | Type | Notes |
|--------|------|-------|
| `review_id` | `BIGINT` PK FK → `pr_reviews.id` | |
| `reviewer_login` | `TEXT` | denormalised |
| `pr_id` | `BIGINT` | denormalised |
| `submitted_at` | `TIMESTAMPTZ` | denormalised |
| `quality_score` | `NUMERIC(6,4)` | 0–1; weighted avg of LLM dimension scores |
| `engagement_bonus` | `NUMERIC(4,3)` | 0–0.20; bonus for CHANGES_REQUESTED, fast response, inline depth |
| `raw_review_score` | `NUMERIC(6,4)` | 0–1; `min(1, quality + engagement)` |
| `week_start` | `DATE` | Monday of ISO week of `submitted_at` |
| `scored_at` | `TIMESTAMPTZ` | |

**Indexes:**

| Index | Columns | Purpose |
|-------|---------|---------|
| `review_scores_reviewer_week_idx` | `(reviewer_login, week_start DESC)` | per-reviewer weekly aggregation |

---

## 9. `engineer_weekly_velocity`

**Purpose:** Per-engineer, per-week rollup. Written by `rollup.ts`.
The primary table read by `/api/leaderboard` and `/api/engineer/:login` for time-series chart data.

**Primary key:** surrogate `id` (BIGSERIAL)

**Unique constraint:** `(author_login, week_start)` — upsert target for rollup re-runs.

Composite formula: `raw_composite = 0.70 × avg_pr_score + 0.30 × avg_review_score`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGSERIAL` PK | surrogate |
| `author_login` | `TEXT` | |
| `week_start` | `DATE` | Monday of ISO week |
| `n_prs_merged` | `INT` | PRs merged this week |
| `avg_pr_score` | `NUMERIC(6,4)` | mean `raw_pr_score` this week |
| `sum_pr_score` | `NUMERIC(8,4)` | for re-aggregation if needed |
| `n_reviews` | `INT` | reviews submitted this week |
| `avg_review_score` | `NUMERIC(6,4)` | mean `raw_review_score` this week |
| `sum_review_score` | `NUMERIC(8,4)` | |
| `raw_composite` | `NUMERIC(6,4)` | `0.70 × avg_pr + 0.30 × avg_review` |
| `team_percentile` | `NUMERIC(5,2)` | 0–100; NULL if <3 engineers active |
| `computed_at` | `TIMESTAMPTZ` | |

**Indexes:**

| Index | Columns | Purpose |
|-------|---------|---------|
| `ewv_author_week_idx` | `(author_login, week_start DESC)` | per-engineer drill-down timeline |
| `ewv_week_score_idx` | `(week_start DESC, raw_composite DESC)` | team leaderboard for a week |

---

## 10. `team_weekly_velocity`

**Purpose:** Pre-computed team distribution per week. Materialises P25/P50/P75 so the API avoids
re-computing percentiles from `engineer_weekly_velocity` on every request.
Written by `rollup.ts` immediately after updating `engineer_weekly_velocity`.

**Primary key:** `week_start` — one row per week, replaced on re-run.

| Column | Type | Notes |
|--------|------|-------|
| `week_start` | `DATE` PK | Monday of ISO week |
| `n_active` | `INT` | engineers with ≥1 PR or review that week |
| `mean_composite` | `NUMERIC(6,4)` | nullable if n_active < 1 |
| `p25_composite` | `NUMERIC(6,4)` | 25th percentile of `raw_composite` across active engineers |
| `p50_composite` | `NUMERIC(6,4)` | median |
| `p75_composite` | `NUMERIC(6,4)` | 75th percentile |
| `computed_at` | `TIMESTAMPTZ` | |

No additional indexes; PK range scan covers all API access patterns.

---

## 11. `engineer_scores_90d`

**Purpose:** Materialized 90-day aggregate per engineer. Single row per engineer, replaced on each rollup run.
Powers the `/api/leaderboard` ranked table without recomputing window aggregations per request.

**Primary key:** `author_login`

| Column | Type | Notes |
|--------|------|-------|
| `author_login` | `TEXT` PK | |
| `window_end` | `DATE` | date when this snapshot was computed |
| `n_prs_merged` | `INT` | PRs merged in the 90-day window |
| `avg_pr_score` | `NUMERIC(6,4)` | |
| `n_reviews_given` | `INT` | reviews submitted in window |
| `avg_review_score` | `NUMERIC(6,4)` | |
| `raw_composite` | `NUMERIC(6,4)` | `0.70 × avg_pr + 0.30 × avg_review` |
| `avg_percentile` | `NUMERIC(5,2)` | mean `team_percentile` across weeks active; NULL if never ranked |
| `rank` | `INT` | ordinal rank among all engineers; NULL if <1 PR and <1 review |
| `n_prs_merged_30d` | `INT` | PRs merged in the last 30 calendar days |
| `avg_pr_score_30d` | `NUMERIC(6,4)` | mean `raw_pr_score` over last 30 days |
| `n_reviews_given_30d` | `INT` | reviews submitted in last 30 days |
| `avg_review_score_30d` | `NUMERIC(6,4)` | mean `raw_review_score` over last 30 days |
| `raw_composite_30d` | `NUMERIC(6,4)` | `0.70 × sum_pr_30d + 0.30 × sum_review_30d` |
| `rank_30d` | `INT` | ordinal rank by `raw_composite_30d`; NULL if no activity in last 30 d |
| `computed_at` | `TIMESTAMPTZ` | |

**Indexes:**

| Index | Columns | Purpose |
|-------|---------|---------|
| `es90d_rank_idx` | `raw_composite DESC` | 90-day leaderboard ORDER BY |
| `es90d_rank_30d_idx` | `raw_composite_30d DESC` | 30-day leaderboard ORDER BY |

---

## 12. `engineer_evidence`

**Purpose:** Pre-materialised notable PRs per engineer.
Populated by `rollup.ts`; read by `/api/engineer/:login` for the `top_prs` array (top 10 by score)
and by the UI's expandable evidence drawer.

**Primary key:** surrogate `id`

**Unique constraint:** `(author_login, pr_id, evidence_type)` — prevents duplicate evidence tags.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGSERIAL` PK | |
| `author_login` | `TEXT` | |
| `pr_id` | `BIGINT` FK → `prs.id` | ON DELETE CASCADE |
| `evidence_type` | `TEXT` | `'top_pr' \| 'critical_path' \| 'high_complexity' \| 'security' \| 'high_impact'` |
| `raw_pr_score` | `NUMERIC(6,4)` | denormalised for ORDER BY without join |
| `week_start` | `DATE` | week the PR was merged |

**Indexes:**

| Index | Columns | Purpose |
|-------|---------|---------|
| `engineer_evidence_author_score_idx` | `(author_login, raw_pr_score DESC)` | top-N PRs for `/api/engineer/:login` |

---

## 13. `engineer_areas`

**Purpose:** Subsystem specialisation per engineer. Derived from `pr_changed_files` by `rollup.ts`.
Each row is one top-level directory an engineer has touched in the rolling window.
Used by the UI's `<ScoreBreakdownBar>` and potential "specialisation" chip display.

**Primary key:** surrogate `id`

**Unique constraint:** `(author_login, area)` — upsert on re-run.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGSERIAL` PK | |
| `author_login` | `TEXT` | |
| `area` | `TEXT` | top-level repo directory, e.g. `'posthog/api'`, `'frontend'`, `'ee'` |
| `n_prs` | `INT` | PRs that touched this area |
| `n_files_touched` | `INT` | distinct files touched within area |
| `last_touched_at` | `TIMESTAMPTZ` | `MAX(prs.merged_at)` for PRs in this area |

**Indexes:**

| Index | Columns | Purpose |
|-------|---------|---------|
| `engineer_areas_author_idx` | `author_login` | per-engineer area list |

---

## Pipeline Dependency Graph

```
prs ─────────────────┬──► pr_changed_files
                     │
                     ├──► pr_features          (deterministic; reads prs + pr_changed_files)
                     │
                     ├──► pr_llm_features       (Gemini; reads prs + pr_changed_files + pr_features)
                     │
                     └──► pr_scores             (deterministic; reads pr_features + pr_llm_features)

pr_reviews ──────────┬──► review_llm_features   (Gemini; reads pr_reviews)
                     │
                     └──► review_scores          (deterministic; reads review_llm_features)

pr_scores ───────────┐
                     ├──► engineer_weekly_velocity
review_scores ───────┘         │
                               ├──► team_weekly_velocity
                               ├──► engineer_scores_90d
                               ├──► engineer_evidence   (reads pr_scores + prs)
                               └──► engineer_areas      (reads pr_changed_files)
```

---

*Document version: 1.0 — 2026-03-03*
