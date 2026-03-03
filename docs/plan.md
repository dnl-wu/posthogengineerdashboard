# Engineering Velocity / Impact Dashboard — Architecture & Data Contract

> **Repo target:** PostHog/posthog
> **Window:** last 90 days (120-day backfill on first run)
> **Stack:** GitHub REST/GraphQL API · Gemini API · Supabase (Postgres + pgvector) · Next.js 14 (App Router) · tRPC-optional

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  INGEST LAYER  (Node workers, run on cron or manual trigger)                │
│                                                                             │
│  github-ingest.ts                                                           │
│   └─ GitHub REST API (Octokit)                                              │
│       ├─ GET /repos/PostHog/posthog/pulls?state=closed&per_page=100         │
│       │    (paginate; filter merged_at within window)                       │
│       ├─ GET /repos/…/pulls/:number   (body, labels)                        │
│       ├─ GET /repos/…/pulls/:number/files  (filename, additions, deletions, │
│       │    patch – first 200 lines)                                         │
│       └─ GET /repos/…/pulls/:number/reviews  (state, submitted_at, body)   │
│                                                                             │
│   Writes →  raw_prs  +  raw_reviews  (Supabase, service-role key)          │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────────┐
│  FEATURE EXTRACTION LAYER  (enrichment worker)                              │
│                                                                             │
│  enrich-pr.ts                                                               │
│   ├─ Reads raw_prs WHERE enriched_at IS NULL                                │
│   ├─ Builds prompt from: title + body + label names + file-path list        │
│   │   + per-file (additions, deletions, touch_type)                         │
│   ├─ Calls Gemini Flash 2.0 (structured JSON output mode)                  │
│   └─ Writes structured fields → pr_features                                │
│                                                                             │
│  enrich-review.ts                                                           │
│   ├─ Reads raw_reviews WHERE enriched_at IS NULL                            │
│   ├─ Builds prompt from: review body + inline comment bodies                │
│   ├─ Calls Gemini Flash 2.0 (structured JSON output mode)                  │
│   └─ Writes structured fields → review_features                            │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────────┐
│  SCORING LAYER  (deterministic; no LLM calls)                               │
│                                                                             │
│  score-prs.ts                                                               │
│   └─ Reads pr_features → writes pr_scores (formula below)                  │
│                                                                             │
│  score-reviews.ts                                                           │
│   └─ Reads review_features → writes review_scores (formula below)          │
│                                                                             │
│  rollup.ts                                                                  │
│   └─ Aggregates per-author per-week → engineer_weekly_scores               │
│       composite = 0.70 × pr_score_norm + 0.30 × review_score_norm          │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────────┐
│  API LAYER  (Next.js 14 Route Handlers, server-side only)                   │
│                                                                             │
│  /api/leaderboard  – ranked engineers + team distribution band             │
│  /api/engineer/:login  – single engineer drill-down                        │
│  /api/prs/:login  – paginated PR list with scores                          │
│  All handlers read Supabase with SUPABASE_SERVICE_ROLE_KEY (server env)    │
│  Never exposed to browser; Next.js is the only Supabase client             │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────────────┐
│  UI LAYER  (Next.js 14 React Server + Client Components)                    │
│                                                                             │
│  /dashboard  – team leaderboard with P25–P75 band chart                    │
│  /engineer/[login]  – individual timeline + PR breakdown                   │
│  Fetches exclusively from /api/* routes; zero direct Supabase calls        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Data Contracts

### 2.1 `raw_prs` — GitHub PR snapshot

Written by: `github-ingest.ts`
Read by: `enrich-pr.ts`, debug tooling

```sql
CREATE TABLE raw_prs (
  id              BIGINT PRIMARY KEY,          -- GitHub PR node id (numeric)
  repo            TEXT    NOT NULL DEFAULT 'PostHog/posthog',
  number          INT     NOT NULL,
  author_login    TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  body            TEXT,                        -- may be null / empty
  state           TEXT    NOT NULL,            -- always 'closed' after filter
  merged_at       TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  closed_at       TIMESTAMPTZ,
  label_names     TEXT[]  NOT NULL DEFAULT '{}',
  additions       INT     NOT NULL DEFAULT 0,
  deletions       INT     NOT NULL DEFAULT 0,
  changed_files   INT     NOT NULL DEFAULT 0,
  -- file-level detail: [{filename, additions, deletions, patch_excerpt}]
  files_json      JSONB   NOT NULL DEFAULT '[]',
  enriched_at     TIMESTAMPTZ,                 -- NULL until enrich-pr runs
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX raw_prs_author      ON raw_prs (author_login);
CREATE INDEX raw_prs_merged      ON raw_prs (merged_at DESC);
CREATE INDEX raw_prs_enriched    ON raw_prs (enriched_at) WHERE enriched_at IS NULL;
```

**`files_json` element shape:**
```jsonc
{
  "filename":     "posthog/api/feature_flag.py",   // full repo path
  "additions":    42,
  "deletions":    7,
  "touch_type":   "modify",   // "add" | "modify" | "delete" | "rename"
  "patch_excerpt": "@@..."    // first 40 lines of unified diff, may be null
}
```

---

### 2.2 `raw_reviews` — GitHub review snapshot

Written by: `github-ingest.ts`
Read by: `enrich-review.ts`

```sql
CREATE TABLE raw_reviews (
  id              BIGINT PRIMARY KEY,          -- GitHub review id
  pr_id           BIGINT NOT NULL REFERENCES raw_prs(id) ON DELETE CASCADE,
  pr_number       INT    NOT NULL,
  reviewer_login  TEXT   NOT NULL,
  state           TEXT   NOT NULL,  -- 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'
  submitted_at    TIMESTAMPTZ NOT NULL,
  body            TEXT,
  -- inline comments collapsed: [{path, body, created_at}]
  comments_json   JSONB  NOT NULL DEFAULT '[]',
  enriched_at     TIMESTAMPTZ,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX raw_reviews_reviewer  ON raw_reviews (reviewer_login);
CREATE INDEX raw_reviews_pr        ON raw_reviews (pr_id);
CREATE INDEX raw_reviews_enriched  ON raw_reviews (enriched_at) WHERE enriched_at IS NULL;
```

---

### 2.3 `pr_features` — Gemini-extracted PR signals

Written by: `enrich-pr.ts`
Read by: `score-prs.ts`

Every field produced by a **single structured Gemini call per PR**.
All integer fields are 0–100 unless noted.

```sql
CREATE TABLE pr_features (
  pr_id                   BIGINT PRIMARY KEY REFERENCES raw_prs(id) ON DELETE CASCADE,

  -- ── Impact dimensions (Gemini) ──────────────────────────────────────────
  complexity_score        SMALLINT NOT NULL,  -- 0–100: algorithmic/architectural depth
  risk_score              SMALLINT NOT NULL,  -- 0–100: blast radius if this breaks
  cross_cutting_score     SMALLINT NOT NULL,  -- 0–100: touches multiple systems/layers
  user_facing_score       SMALLINT NOT NULL,  -- 0–100: visible to end-users / customers
  tech_debt_delta         SMALLINT NOT NULL,  -- -50 (adds debt) → +50 (pays debt)

  -- ── Classification (Gemini) ─────────────────────────────────────────────
  pr_category             TEXT NOT NULL,
  -- 'feature' | 'bug_fix' | 'refactor' | 'test' | 'docs' | 'infra' | 'perf' | 'security'
  is_breaking_change      BOOLEAN NOT NULL DEFAULT false,
  touches_critical_path   BOOLEAN NOT NULL,
  -- true if files include: billing, auth, ingestion pipeline, query engine

  -- ── Structural signals (deterministic, computed by worker, not Gemini) ──
  n_files_changed         INT NOT NULL,
  n_subsystems_touched    INT NOT NULL,   -- distinct top-level dirs
  churn_ratio             NUMERIC(5,3),   -- deletions / (additions + deletions); null if 0 lines
  cycle_time_hours        NUMERIC(8,2),   -- merged_at - created_at in hours
  review_lag_hours        NUMERIC(8,2),   -- time from ready→first review

  -- ── Gemini reasoning trace ───────────────────────────────────────────────
  gemini_rationale        TEXT,           -- 1–3 sentence justification
  gemini_model            TEXT NOT NULL DEFAULT 'gemini-2.0-flash',
  enriched_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Gemini prompt contract (enrich-pr.ts):**

```
System:
  You are a senior software engineer evaluating a pull request for engineering impact.
  Respond ONLY with a JSON object matching this exact schema. Do not include markdown fences.

  Schema:
  {
    "complexity_score":      <integer 0-100>,
    "risk_score":            <integer 0-100>,
    "cross_cutting_score":   <integer 0-100>,
    "user_facing_score":     <integer 0-100>,
    "tech_debt_delta":       <integer -50 to 50>,
    "pr_category":           <one of: feature|bug_fix|refactor|test|docs|infra|perf|security>,
    "is_breaking_change":    <boolean>,
    "touches_critical_path": <boolean>,
    "gemini_rationale":      <string, max 200 chars>
  }

User:
  PR Title: {{title}}
  Labels: {{label_names.join(', ')}}
  Body (first 800 chars): {{body.slice(0,800)}}
  Files changed ({{n_files}} total):
  {{files_json.slice(0,25).map(f => `  ${f.touch_type.padEnd(7)} ${f.filename}  +${f.additions}/-${f.deletions}`).join('\n')}}
  {{n_files > 25 ? `  … and ${n_files-25} more files` : ''}}
```

---

### 2.4 `review_features` — Gemini-extracted review signals

Written by: `enrich-review.ts`
Read by: `score-reviews.ts`

```sql
CREATE TABLE review_features (
  review_id               BIGINT PRIMARY KEY REFERENCES raw_reviews(id) ON DELETE CASCADE,
  pr_id                   BIGINT NOT NULL,
  reviewer_login          TEXT   NOT NULL,

  -- ── Quality dimensions (Gemini) ──────────────────────────────────────────
  depth_score             SMALLINT NOT NULL,  -- 0–100: substance vs rubber-stamp
  actionability_score     SMALLINT NOT NULL,  -- 0–100: specific, implementable feedback
  correctness_focus       SMALLINT NOT NULL,  -- 0–100: catches bugs/logic errors
  architecture_focus      SMALLINT NOT NULL,  -- 0–100: design-level comments
  tone_score              SMALLINT NOT NULL,  -- 0–100: constructive language

  -- ── Structural signals (deterministic) ───────────────────────────────────
  n_comments              INT  NOT NULL,      -- total inline + top-level comments
  n_inline_comments       INT  NOT NULL,
  review_state            TEXT NOT NULL,      -- APPROVED | CHANGES_REQUESTED | COMMENTED
  response_time_hours     NUMERIC(8,2),       -- pr created_at → review submitted_at

  -- ── Gemini reasoning ────────────────────────────────────────────────────
  gemini_rationale        TEXT,
  gemini_model            TEXT NOT NULL DEFAULT 'gemini-2.0-flash',
  enriched_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX review_features_reviewer ON review_features (reviewer_login);
CREATE INDEX review_features_pr       ON review_features (pr_id);
```

**Gemini prompt contract (enrich-review.ts):**

```
System:
  You are a senior engineering manager evaluating the quality of a code review.
  Respond ONLY with a JSON object matching this exact schema. Do not include markdown fences.

  Schema:
  {
    "depth_score":          <integer 0-100>,
    "actionability_score":  <integer 0-100>,
    "correctness_focus":    <integer 0-100>,
    "architecture_focus":   <integer 0-100>,
    "tone_score":           <integer 0-100>,
    "gemini_rationale":     <string, max 200 chars>
  }

User:
  Review state: {{review_state}}
  Top-level review body: {{body.slice(0,600)}}
  Inline comments ({{n_inline_comments}} total, first 10 shown):
  {{comments_json.slice(0,10).map(c => `  [${c.path}] ${c.body.slice(0,150)}`).join('\n')}}
```

---

### 2.5 `pr_scores` — deterministic PR score

Written by: `score-prs.ts`
Read by: `rollup.ts`, `/api/leaderboard`, `/api/prs/:login`

```sql
CREATE TABLE pr_scores (
  pr_id             BIGINT PRIMARY KEY REFERENCES raw_prs(id) ON DELETE CASCADE,
  author_login      TEXT   NOT NULL,
  merged_at         TIMESTAMPTZ NOT NULL,

  -- ── Component sub-scores (each 0–1 float, computed deterministically) ───
  impact_score      NUMERIC(6,4) NOT NULL,
  -- = weighted avg of Gemini dimensions:
  --   0.30 × complexity + 0.25 × risk + 0.20 × cross_cutting
  --   + 0.15 × user_facing + 0.10 × |tech_debt_delta|/50
  --   all divided by 100

  delivery_score    NUMERIC(6,4) NOT NULL,
  -- = f(cycle_time_hours, churn_ratio, is_breaking_change)
  -- faster cycle with good churn → higher; breaking changes penalised -0.10

  breadth_score     NUMERIC(6,4) NOT NULL,
  -- = min(1, n_subsystems_touched / 5) × cross_cutting_score/100
  -- rewards engineers who improve multiple systems

  -- ── Category multipliers applied to impact_score ─────────────────────────
  category_weight   NUMERIC(4,3) NOT NULL,
  -- feature=1.00  security=1.20  perf=1.10  bug_fix=1.05
  -- refactor=0.90  test=0.70  docs=0.60  infra=0.95

  -- ── Final composite ──────────────────────────────────────────────────────
  raw_pr_score      NUMERIC(6,4) NOT NULL,
  -- = category_weight × (0.55×impact + 0.25×delivery + 0.20×breadth)

  -- ── Week bucket for rollup ────────────────────────────────────────────────
  week_start        DATE NOT NULL,   -- Monday of ISO week of merged_at

  scored_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX pr_scores_author  ON pr_scores (author_login, week_start DESC);
CREATE INDEX pr_scores_week    ON pr_scores (week_start DESC);
```

---

### 2.6 `review_scores` — deterministic review score

Written by: `score-reviews.ts`
Read by: `rollup.ts`

```sql
CREATE TABLE review_scores (
  review_id         BIGINT PRIMARY KEY REFERENCES raw_reviews(id) ON DELETE CASCADE,
  reviewer_login    TEXT   NOT NULL,
  pr_id             BIGINT NOT NULL,
  submitted_at      TIMESTAMPTZ NOT NULL,

  quality_score     NUMERIC(6,4) NOT NULL,
  -- = (0.30×depth + 0.25×actionability + 0.25×correctness_focus
  --    + 0.15×architecture_focus + 0.05×tone_score) / 100

  engagement_bonus  NUMERIC(4,3) NOT NULL DEFAULT 0,
  -- +0.10 if CHANGES_REQUESTED (substantive blocking review)
  -- +0.05 if response_time_hours < 4
  -- +0.05 if n_inline_comments >= 5

  raw_review_score  NUMERIC(6,4) NOT NULL,
  -- = min(1, quality_score + engagement_bonus)

  week_start        DATE NOT NULL,
  scored_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX review_scores_reviewer ON review_scores (reviewer_login, week_start DESC);
```

---

### 2.7 `engineer_weekly_scores` — per-author rollup

Written by: `rollup.ts`
Read by: `/api/leaderboard`, `/api/engineer/:login`

```sql
CREATE TABLE engineer_weekly_scores (
  id                BIGSERIAL PRIMARY KEY,
  author_login      TEXT NOT NULL,
  week_start        DATE NOT NULL,

  -- PR component (70 % weight in composite)
  n_prs_merged      INT          NOT NULL DEFAULT 0,
  avg_pr_score      NUMERIC(6,4) NOT NULL DEFAULT 0,
  sum_pr_score      NUMERIC(8,4) NOT NULL DEFAULT 0,

  -- Review component (30 % weight in composite)
  n_reviews         INT          NOT NULL DEFAULT 0,
  avg_review_score  NUMERIC(6,4) NOT NULL DEFAULT 0,
  sum_review_score  NUMERIC(8,4) NOT NULL DEFAULT 0,

  -- Composite (normalised 0–1 within week's team distribution)
  raw_composite     NUMERIC(6,4) NOT NULL,
  -- = 0.70 × avg_pr_score + 0.30 × avg_review_score
  -- (uses avg so engineers with one landmark PR aren't unfairly penalised)

  -- Team-relative percentile for this week (computed during rollup)
  team_percentile   NUMERIC(5,2),  -- 0–100; NULL if < 3 engineers active that week

  UNIQUE (author_login, week_start)
);

CREATE INDEX ews_author ON engineer_weekly_scores (author_login, week_start DESC);
CREATE INDEX ews_week   ON engineer_weekly_scores (week_start DESC, raw_composite DESC);
```

---

## 3. API Contracts

> All routes live under `src/app/api/` (Next.js 14 App Router).
> All handlers instantiate a Supabase client with `SUPABASE_SERVICE_ROLE_KEY` **server-side only**.
> No Supabase credentials are passed to the client bundle.

---

### 3.1 `GET /api/leaderboard`

Returns ranked engineers for the dashboard's main view, plus team distribution data needed to render the P25–P75 band.

**Query parameters:**

| Param    | Type   | Default | Description |
|----------|--------|---------|-------------|
| `days`   | int    | `90`    | Look-back window (max 120) |
| `limit`  | int    | `30`    | Max engineers returned |
| `offset` | int    | `0`     | Pagination offset |

**Response — `200 OK`:**

```jsonc
{
  "window": {
    "from": "2025-12-03",          // ISO date, days ago from today
    "to":   "2026-03-03"
  },
  "team_distribution": {
    // One entry per ISO week in window
    "weeks": [
      {
        "week_start": "2025-12-09",
        "p25": 0.312,              // 25th percentile raw_composite across all active engineers
        "p50": 0.481,
        "p75": 0.643,
        "n_active": 18             // engineers with >= 1 PR or review that week
      }
      // … 12 more weeks
    ]
  },
  "engineers": [
    {
      "rank":            1,
      "login":           "mariusandra",
      "avatar_url":      "https://avatars.githubusercontent.com/u/...",
      "display_name":    "Marius Andra",
      // 90-day aggregates
      "n_prs":           34,
      "n_reviews":       67,
      "avg_pr_score":    0.821,
      "avg_review_score":0.694,
      "composite_score": 0.783,    // 0.70×avg_pr + 0.30×avg_review
      "avg_percentile":  91.4,     // mean team_percentile across weeks active
      // Weekly timeline for sparkline / chart overlay
      "weekly": [
        {
          "week_start":      "2025-12-09",
          "composite_score": 0.802,
          "team_percentile": 94.0,
          "n_prs":           3,
          "n_reviews":       8
        }
        // … one entry per week in window
      ]
    }
    // … up to `limit` engineers, ordered by composite_score DESC
  ],
  "meta": {
    "total_engineers": 42,
    "generated_at":    "2026-03-03T14:22:01Z"
  }
}
```

**Error responses:**

| Status | Body | Condition |
|--------|------|-----------|
| `400`  | `{"error": "days must be between 1 and 120"}` | Invalid param |
| `500`  | `{"error": "internal server error", "request_id": "..."}` | Supabase / unexpected |

**Server-side implementation sketch:**

```ts
// src/app/api/leaderboard/route.ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!   // ← server env only; never NEXT_PUBLIC_
)

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const days   = Math.min(parseInt(searchParams.get('days')  ?? '90'),  120)
  const limit  = Math.min(parseInt(searchParams.get('limit') ?? '30'),  100)
  const offset =           parseInt(searchParams.get('offset') ?? '0')

  const from = new Date()
  from.setDate(from.getDate() - days)
  const fromISO = from.toISOString().slice(0, 10)

  // 1. Team distribution (one row per week, percentile columns pre-computed)
  const { data: dist } = await supabase
    .from('engineer_weekly_scores')
    .select('week_start, raw_composite')
    .gte('week_start', fromISO)
    .order('week_start')

  // group by week; compute p25/p50/p75 server-side or via Postgres percentile_cont
  const teamDist = computeWeeklyPercentiles(dist ?? [])

  // 2. Per-engineer aggregates
  const { data: engineers, count } = await supabase
    .from('engineer_weekly_scores')
    .select(`
      author_login,
      week_start,
      n_prs_merged,
      n_reviews,
      avg_pr_score,
      avg_review_score,
      raw_composite,
      team_percentile
    `, { count: 'exact' })
    .gte('week_start', fromISO)
    .order('raw_composite', { ascending: false })

  const ranked = aggregateByAuthor(engineers ?? [], limit, offset)

  return Response.json({
    window: { from: fromISO, to: new Date().toISOString().slice(0, 10) },
    team_distribution: { weeks: teamDist },
    engineers: ranked,
    meta: { total_engineers: count ?? 0, generated_at: new Date().toISOString() }
  })
}
```

---

### 3.2 `GET /api/engineer/[login]`

Single-engineer drill-down: full weekly timeline + top PRs.

**Path param:** `login` — GitHub username (case-insensitive)

**Query parameters:**

| Param  | Type | Default | Description |
|--------|------|---------|-------------|
| `days` | int  | `90`    | Look-back window |

**Response — `200 OK`:**

```jsonc
{
  "engineer": {
    "login":        "mariusandra",
    "avatar_url":   "https://avatars.githubusercontent.com/u/...",
    "display_name": "Marius Andra"
  },
  "summary": {
    "n_prs":            34,
    "n_reviews":        67,
    "avg_pr_score":     0.821,
    "avg_review_score": 0.694,
    "composite_score":  0.783,
    "avg_percentile":   91.4,
    "rank":             1           // rank within window across all engineers
  },
  "weekly": [
    {
      "week_start":       "2025-12-09",
      "composite_score":  0.802,
      "avg_pr_score":     0.841,
      "avg_review_score": 0.710,
      "team_percentile":  94.0,
      "n_prs":            3,
      "n_reviews":        8,
      // band for comparison
      "team_p25":         0.312,
      "team_p50":         0.481,
      "team_p75":         0.643
    }
  ],
  "top_prs": [
    {
      "pr_number":     4821,
      "title":         "feat: streaming query engine for large datasets",
      "merged_at":     "2026-02-14T11:03:00Z",
      "pr_category":   "feature",
      "raw_pr_score":  0.934,
      "impact_score":  0.891,
      "delivery_score":0.832,
      "breadth_score": 0.780,
      "complexity_score": 87,
      "risk_score":       72,
      "gemini_rationale": "Introduces async streaming layer touching query engine and API; high complexity, meaningful user impact.",
      "github_url":    "https://github.com/PostHog/posthog/pull/4821"
    }
    // top 10 by raw_pr_score
  ]
}
```

**Error responses:**

| Status | Body | Condition |
|--------|------|-----------|
| `404`  | `{"error": "engineer not found"}` | login not in DB |
| `400`  | `{"error": "days must be between 1 and 120"}` | Invalid param |

---

### 3.3 `GET /api/prs/[login]`

Paginated PR list for an engineer with per-PR score breakdown.

**Query parameters:**

| Param    | Type   | Default | Description |
|----------|--------|---------|-------------|
| `days`   | int    | `90`    | Look-back window |
| `limit`  | int    | `20`    | Page size (max 50) |
| `offset` | int    | `0`     | Pagination offset |
| `sort`   | string | `score` | `score` \| `merged_at` \| `complexity` |

**Response — `200 OK`:**

```jsonc
{
  "login":  "mariusandra",
  "total":  34,
  "prs": [
    {
      "pr_number":      4821,
      "title":          "feat: streaming query engine for large datasets",
      "merged_at":      "2026-02-14T11:03:00Z",
      "pr_category":    "feature",
      "is_breaking_change": false,
      "touches_critical_path": true,
      "raw_pr_score":   0.934,
      "impact_score":   0.891,
      "delivery_score": 0.832,
      "breadth_score":  0.780,
      "category_weight":1.00,
      "complexity_score":   87,
      "risk_score":         72,
      "cross_cutting_score":81,
      "user_facing_score":  70,
      "tech_debt_delta":    15,
      "cycle_time_hours":   28.4,
      "churn_ratio":        0.142,
      "n_files_changed":    23,
      "n_subsystems_touched": 4,
      "gemini_rationale":   "Introduces async streaming layer...",
      "github_url":         "https://github.com/PostHog/posthog/pull/4821"
    }
  ]
}
```

---

## 4. Scoring Formulas (Authoritative Reference)

### PR Score

```
impact_raw   = (0.30 × complexity_score
              + 0.25 × risk_score
              + 0.20 × cross_cutting_score
              + 0.15 × user_facing_score
              + 0.10 × abs(tech_debt_delta) × 2)   /  100

delivery_raw = clamp(1 - cycle_time_hours/336, 0, 1)   -- 336 h = 2 weeks floor→0
             × (1 - churn_ratio × 0.5)                  -- high pure-churn penalised
             × (is_breaking_change ? 0.90 : 1.00)

breadth_raw  = min(1, n_subsystems_touched / 5)
             × (cross_cutting_score / 100)

raw_pr_score = category_weight
             × (0.55 × impact_raw + 0.25 × delivery_raw + 0.20 × breadth_raw)
```

**Category weights:**

| Category   | Weight |
|------------|--------|
| `security` | 1.20   |
| `perf`     | 1.10   |
| `bug_fix`  | 1.05   |
| `feature`  | 1.00   |
| `infra`    | 0.95   |
| `refactor` | 0.90   |
| `test`     | 0.70   |
| `docs`     | 0.60   |

### Review Score

```
quality_raw  = (0.30 × depth_score
              + 0.25 × actionability_score
              + 0.25 × correctness_focus
              + 0.15 × architecture_focus
              + 0.05 × tone_score)              / 100

engagement   = (review_state == 'CHANGES_REQUESTED' ? 0.10 : 0)
             + (response_time_hours < 4            ? 0.05 : 0)
             + (n_inline_comments >= 5             ? 0.05 : 0)

raw_review_score = min(1, quality_raw + engagement)
```

### Weekly Composite

```
raw_composite = 0.70 × avg_pr_score + 0.30 × avg_review_score

-- avg_pr_score    = mean of raw_pr_score for all PRs merged that week by author
-- avg_review_score= mean of raw_review_score for all reviews submitted that week by author
-- engineers with 0 PRs that week still get a composite if they have reviews (and vice versa)
```

---

## 5. Environment Variables

```dotenv
# Server-only (never prefix with NEXT_PUBLIC_)
SUPABASE_SERVICE_ROLE_KEY=...
GEMINI_API_KEY=...

# Public (safe in browser)
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_GITHUB_REPO=PostHog/posthog

# Worker config
GITHUB_TOKEN=ghp_...            # fine-grained PAT, read:pull_request
INGEST_WINDOW_DAYS=90
INGEST_BACKFILL_DAYS=120
GEMINI_MODEL=gemini-2.0-flash
GEMINI_MAX_CONCURRENT=5          # stay within rate limits
```

---

## 6. Cron / Worker Schedule

```
┌─────────────────────────────────────┬────────────────────────────────────┐
│ Job                                 │ Schedule                           │
├─────────────────────────────────────┼────────────────────────────────────┤
│ github-ingest.ts                    │ Every 6 hours                      │
│  (incremental: last ingested_at)    │                                    │
├─────────────────────────────────────┼────────────────────────────────────┤
│ enrich-pr.ts + enrich-review.ts     │ 30 min after ingest completes      │
│  (batch: up to 50 un-enriched rows) │                                    │
├─────────────────────────────────────┼────────────────────────────────────┤
│ score-prs.ts + score-reviews.ts     │ After enrich completes             │
├─────────────────────────────────────┼────────────────────────────────────┤
│ rollup.ts                           │ After scoring completes;           │
│  (re-computes current + prior week) │ also runs at 00:05 UTC Mon         │
└─────────────────────────────────────┴────────────────────────────────────┘
```

---

## 7. UI Component Map

```
/dashboard
  ├─ <TeamBandChart>         // Recharts area chart: P25/P50/P75 band over 13 weeks
  │                          // Individual engineer lines overlaid for top N
  ├─ <LeaderboardTable>      // Rank | Avatar | Name | Composite | PRs | Reviews | Trend
  │   └─ row click → /engineer/[login]
  └─ <WindowSelector>        // 30 / 60 / 90 day toggle; updates ?days= param

/engineer/[login]
  ├─ <EngineerHeader>        // Avatar, name, rank, composite badge
  ├─ <WeeklyCompositeChart>  // Line: engineer score vs team P25–P75 band
  ├─ <ScoreBreakdownBar>     // Stacked: PR impact / delivery / breadth + review quality
  └─ <PRTable>               // Sortable table of PRs with per-row score chips
      └─ expandable row → Gemini rationale + dimension scores
```

---

*Document version: 1.0 — generated 2026-03-03*
