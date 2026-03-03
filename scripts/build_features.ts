/**
 * build_features.ts
 * ─────────────────
 * Deterministic feature extraction — no LLM calls.
 *
 * For every PR merged within the last WINDOW_DAYS (default 120), reads
 * `prs`, `pr_changed_files`, and `pr_reviews`, computes structural signals
 * and touch hints, then upserts the result into `pr_features`.
 *
 * Tables read:    prs, pr_changed_files, pr_reviews
 * Tables written: pr_features  (schema §4 + migration 002_pr_features_extend)
 *
 * Run via:  npm run features
 *
 * Required env vars (loaded from .env.local via dotenv):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   INGEST_BACKFILL_DAYS   (optional, default 120)
 */

import "dotenv/config";
import { createSupabaseServer } from "../lib/supabase-server";

// ─── Config ──────────────────────────────────────────────────────────────────

/** Look-back window in days. */
const WINDOW_DAYS = parseInt(process.env.INGEST_BACKFILL_DAYS ?? "120", 10);

/** PRs fetched per read call (stay well under Supabase's 1000-row default). */
const READ_BATCH = 200;

/** Rows per `pr_features` upsert call. */
const UPSERT_BATCH = 50;

/**
 * Path-prefix routing config.
 * A file "touches" a category when its repo-relative path starts with
 * any of the listed prefixes (case-insensitive).
 *
 * Targets: PostHog/posthog directory layout.
 * Adjust prefixes here without changing any other code.
 */
const TOUCH_PREFIXES = {
  frontend: [
    "frontend/",
  ],
  backend: [
    "posthog/",
    "ee/",
    "plugin-server/",
  ],
  infra: [
    ".github/",
    "docker/",
    "helm/",
    "k8s/",
    "ansible/",
    "terraform/",
    "Dockerfile",       // exact file or Dockerfile.* variants
    "docker-compose",   // docker-compose.yml, docker-compose.dev.yml, etc.
  ],
  tests: [
    "posthog/tests/",
    "ee/tests/",
    "frontend/src/__tests__/",
    "cypress/",
    "playwright/",
    "e2e/",
  ],
} as const satisfies Record<"frontend" | "backend" | "infra" | "tests", readonly string[]>;

/**
 * Regex patterns for test-file detection (`has_tests`).
 * Applied to each repo-relative filename.
 */
const TEST_FILE_REGEXES: readonly RegExp[] = [
  /\.test\.[jt]sx?$/i,          // foo.test.ts / foo.test.tsx
  /\.spec\.[jt]sx?$/i,          // foo.spec.ts
  /\/test_[^/]+\.py$/i,         // test_feature.py
  /_test\.py$/i,                 // feature_test.py
  /_test\.go$/i,                 // feature_test.go
  /\/__tests__\//i,              // __tests__/ directory
  /\/tests?\//i,                 // /test/ or /tests/ segment
];

// ─── Size bucket ─────────────────────────────────────────────────────────────

type SizeBucket = "XS" | "S" | "M" | "L" | "XL";

/**
 * Classifies a PR by total lines changed (additions + deletions).
 * Used for routing / per-bucket score caps only — not an impact signal.
 */
function sizeBucket(additions: number, deletions: number): SizeBucket {
  const lines = additions + deletions;
  if (lines <   10) return "XS";
  if (lines <  100) return "S";
  if (lines <  500) return "M";
  if (lines < 1000) return "L";
  return "XL";
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PrRow {
  id: number;
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  merged_at: string;
  body: string | null;
}

interface FileRow {
  pr_id: number;
  filename: string;
}

interface ReviewRow {
  pr_id: number;
  reviewer_login: string;
  state: string;
  submitted_at: string;
}

/** Shape written to `pr_features` — covers all columns from 001 + 002. */
interface PrFeatureRow {
  pr_id: number;
  // ── 001: structural columns ──────────────────────────────────────────────
  subsystem_list: string[];
  n_files_changed: number;
  n_subsystems_touched: number;
  churn_ratio: number | null;
  cycle_time_hours: number;
  review_lag_hours: number | null;
  // ── 002: flow + touch-hint columns ───────────────────────────────────────
  review_cycles: number;
  review_coverage: number;
  has_description: boolean;
  is_merge_to_main: boolean;
  touches_frontend: boolean;
  touches_backend: boolean;
  touches_infra: boolean;
  touches_tests: boolean;
  has_tests: boolean;
  size_bucket: SizeBucket;
  total_comments_received: number;
  computed_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Top-level directory of a repo-relative path. */
function topLevelDir(filename: string): string {
  const slash = filename.indexOf("/");
  return slash === -1 ? filename : filename.slice(0, slash);
}

/** True if `filename` starts with any prefix in `prefixes` (case-insensitive). */
function matchesPrefixes(filename: string, prefixes: readonly string[]): boolean {
  const lower = filename.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p.toLowerCase()));
}

/** True when any filename in `filenames` matches a test-file pattern. */
function hasTestFile(filenames: string[]): boolean {
  return filenames.some((f) => TEST_FILE_REGEXES.some((re) => re.test(f)));
}

// ─── Core computation ────────────────────────────────────────────────────────

function computeFeatures(
  pr: PrRow,
  files: FileRow[],
  reviews: ReviewRow[],
): PrFeatureRow {
  const filenames = files.map((f) => f.filename);

  // Subsystems: distinct top-level dirs from changed files
  const subsystemSet = new Set(filenames.map(topLevelDir));
  const subsystem_list = Array.from(subsystemSet).sort();

  // Churn ratio: deletions / total lines; null when no lines changed
  const totalLines = pr.additions + pr.deletions;
  const churn_ratio =
    totalLines > 0
      ? Math.round((pr.deletions / totalLines) * 1000) / 1000
      : null;

  // Cycle time: PR created → merged (hours)
  const createdMs = Date.parse(pr.created_at);
  const mergedMs  = Date.parse(pr.merged_at);
  const cycle_time_hours = Math.round(((mergedMs - createdMs) / 3_600_000) * 100) / 100;

  // Review lag: PR created → first review submitted (hours); null if no reviews
  let review_lag_hours: number | null = null;
  if (reviews.length > 0) {
    const earliest = reviews.reduce((best, r) =>
      Date.parse(r.submitted_at) < Date.parse(best.submitted_at) ? r : best,
    );
    review_lag_hours =
      Math.round(((Date.parse(earliest.submitted_at) - createdMs) / 3_600_000) * 100) / 100;
  }

  // Review cycles: count of CHANGES_REQUESTED events
  const review_cycles = reviews.filter((r) => r.state === "CHANGES_REQUESTED").length;

  // Review coverage: distinct reviewer logins
  const review_coverage = new Set(reviews.map((r) => r.reviewer_login)).size;

  return {
    pr_id: pr.id,

    // structural (001)
    subsystem_list,
    n_files_changed:     pr.changed_files,
    n_subsystems_touched: subsystem_list.length,
    churn_ratio,
    cycle_time_hours,
    review_lag_hours,

    // flow + touch hints (002)
    review_cycles,
    review_coverage,
    has_description:     Boolean(pr.body?.trim()),
    is_merge_to_main:    true, // base_ref not stored in `prs`; PostHog merges to main

    touches_frontend: filenames.some((f) => matchesPrefixes(f, TOUCH_PREFIXES.frontend)),
    touches_backend:  filenames.some((f) => matchesPrefixes(f, TOUCH_PREFIXES.backend)),
    touches_infra:    filenames.some((f) => matchesPrefixes(f, TOUCH_PREFIXES.infra)),
    touches_tests:    filenames.some((f) => matchesPrefixes(f, TOUCH_PREFIXES.tests)),
    has_tests:        hasTestFile(filenames),
    size_bucket:      sizeBucket(pr.additions, pr.deletions),
    total_comments_received: 0, // populated by a future comment-aggregation worker

    computed_at: new Date().toISOString(),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const supabase = createSupabaseServer();

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
  const windowISO = windowStart.toISOString();

  console.log(
    `build_features: window >= ${windowISO.slice(0, 10)} (${WINDOW_DAYS}d)`,
  );

  let totalProcessed = 0;
  let offset = 0;

  while (true) {
    // ── 1. Read a page of merged PRs within window ────────────────────────
    const { data: prs, error: prsErr } = await supabase
      .from("prs")
      .select("id, additions, deletions, changed_files, created_at, merged_at, body")
      .gte("merged_at", windowISO)
      .order("id", { ascending: true })
      .range(offset, offset + READ_BATCH - 1);

    if (prsErr) throw new Error(`prs fetch: ${prsErr.message}`);
    if (!prs || prs.length === 0) break;

    const prIds = (prs as PrRow[]).map((p) => p.id);

    // ── 2. Batch-read files and reviews for this page in parallel ─────────
    const [filesRes, reviewsRes] = await Promise.all([
      supabase
        .from("pr_changed_files")
        .select("pr_id, filename")
        .in("pr_id", prIds),
      supabase
        .from("pr_reviews")
        .select("pr_id, reviewer_login, state, submitted_at")
        .in("pr_id", prIds),
    ]);

    if (filesRes.error)   throw new Error(`pr_changed_files fetch: ${filesRes.error.message}`);
    if (reviewsRes.error) throw new Error(`pr_reviews fetch: ${reviewsRes.error.message}`);

    // Group rows by pr_id for O(1) lookup
    const filesByPr = new Map<number, FileRow[]>();
    for (const row of (filesRes.data ?? []) as FileRow[]) {
      const bucket = filesByPr.get(row.pr_id) ?? [];
      bucket.push(row);
      filesByPr.set(row.pr_id, bucket);
    }

    const reviewsByPr = new Map<number, ReviewRow[]>();
    for (const row of (reviewsRes.data ?? []) as ReviewRow[]) {
      const bucket = reviewsByPr.get(row.pr_id) ?? [];
      bucket.push(row);
      reviewsByPr.set(row.pr_id, bucket);
    }

    // ── 3. Compute feature rows ───────────────────────────────────────────
    const rows: PrFeatureRow[] = (prs as PrRow[]).map((pr) =>
      computeFeatures(
        pr,
        filesByPr.get(pr.id) ?? [],
        reviewsByPr.get(pr.id) ?? [],
      ),
    );

    // ── 4. Upsert in sub-batches to stay within request-size limits ───────
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const chunk = rows.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from("pr_features")
        .upsert(chunk, { onConflict: "pr_id" });

      if (error) throw new Error(`pr_features upsert: ${error.message}`);
    }

    totalProcessed += prs.length;
    console.log(`  … upserted ${prs.length} rows (total: ${totalProcessed})`);

    if (prs.length < READ_BATCH) break;
    offset += READ_BATCH;
  }

  console.log(`build_features: done — ${totalProcessed} PRs processed`);
}

main().catch((err: unknown) => {
  console.error("[build_features] fatal:", err);
  process.exit(1);
});
