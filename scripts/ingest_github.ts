/**
 * scripts/ingest_github.ts
 * ─────────────────────────
 * Fetches merged PRs from PostHog/posthog for the last 120 days and writes:
 *   prs               – one row per PR, upsert on id (GitHub numeric PR id)
 *   pr_changed_files  – one row per file, upsert on (pr_id, filename)
 *   pr_reviews        – one row per review, upsert on id (GitHub review id)
 *
 * Uses the GitHub GraphQL search API with cursor-based pagination.
 * The 120-day window is split into 14-day chunks to stay well below the
 * 1000-result cap that the search API imposes per query.
 *
 * patch_excerpt is always NULL — GitHub GraphQL does not expose diff content;
 * the enrich-pr.ts prompt only needs filenames + line counts, so this is fine.
 *
 * Run:  npm run ingest
 *
 * Env vars (all loaded from .env.local, falling back to .env):
 *   GITHUB_TOKEN              fine-grained PAT – read access to public repos
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   NEXT_PUBLIC_GITHUB_REPO   default "PostHog/posthog"
 *   INGEST_BACKFILL_DAYS      default 120
 */

import dotenv from "dotenv";

// Load .env.local first (Next.js convention), then fall back to .env
dotenv.config({ path: ".env.local" });
dotenv.config();

import { createSupabaseServer } from "../lib/supabase-server";

// ─── Config ────────────────────────────────────────────────────────────────────

const REPO = (process.env.NEXT_PUBLIC_GITHUB_REPO ?? "PostHog/posthog").trim();
const WINDOW_DAYS = parseInt(process.env.INGEST_BACKFILL_DAYS ?? "120", 10);
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_GRAPHQL_URL = "https://api.github.com/graphql";

const PAGE_SIZE = 50;    // nodes per GraphQL page (max 100; keep lower for large PRs)
const CHUNK_DAYS = 14;   // date-window per search call; keeps results well under 1000
const DB_BATCH = 50;     // rows per Supabase upsert call
const INTER_PAGE_MS = 300; // courtesy delay between consecutive GraphQL requests

// ─── GraphQL types ─────────────────────────────────────────────────────────────

interface GHPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/** Actor can be User, Bot, Mannequin, etc. login is on the interface; databaseId needs fragments. */
interface GHActor {
  login: string;
  databaseId?: number; // present only for User / Bot via inline fragments
}

/** A single file change within a PR (from `files` connection). */
interface GHFileNode {
  path: string;
  additions: number;
  deletions: number;
  changeType: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED" | "COPIED";
}

/** A single inline review comment. */
interface GHReviewComment {
  path: string;
  body: string;
  createdAt: string;
}

/** A single PR review object. */
interface GHReview {
  databaseId: number;
  author: GHActor | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  submittedAt: string | null; // null for PENDING (draft) reviews
  body: string | null;
  comments: {
    totalCount: number; // accurate total even when nodes are truncated
    nodes: GHReviewComment[];
  };
}

/** A single PR node returned from the search query. */
interface GHPullRequest {
  databaseId: number;
  number: number;
  author: GHActor | null;
  title: string;
  body: string | null;
  state: string; // "MERGED" | "OPEN" | "CLOSED"
  mergedAt: string | null;
  createdAt: string;
  closedAt: string | null;
  labels: { nodes: Array<{ name: string }> };
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { nodes: GHFileNode[] };
  reviews: { nodes: GHReview[] };
}

interface SearchData {
  search: {
    pageInfo: GHPageInfo;
    // nodes can be PullRequest | Issue | Repository | … depending on query
    nodes: Array<{ __typename: string } & Partial<GHPullRequest>>;
  };
}

interface GHGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; type?: string; path?: unknown }>;
}

// ─── GraphQL query ─────────────────────────────────────────────────────────────

const SEARCH_PRS_QUERY = /* graphql */ `
  query SearchMergedPRs($query: String!, $first: Int!, $after: String) {
    search(query: $query, type: ISSUE, first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        __typename
        ... on PullRequest {
          databaseId
          number
          author {
            login
            ... on User { databaseId }
            ... on Bot  { databaseId }
          }
          title
          body
          state
          mergedAt
          createdAt
          closedAt
          labels(first: 20) {
            nodes { name }
          }
          additions
          deletions
          changedFiles
          files(first: 100) {
            nodes {
              path
              additions
              deletions
              changeType
            }
          }
          reviews(first: 50) {
            nodes {
              databaseId
              author {
                login
                ... on User { databaseId }
                ... on Bot  { databaseId }
              }
              state
              submittedAt
              body
              comments(first: 50) {
                totalCount
                nodes {
                  path
                  body
                  createdAt
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ─── DB row types (exact column names from schema.md / migration) ───────────────

type PrRow = {
  id: number;
  repo: string;
  number: number;
  author_login: string;
  title: string;
  body: string | null;
  state: string;
  merged_at: string;
  created_at: string;
  closed_at: string | null;
  label_names: string[];
  additions: number;
  deletions: number;
  changed_files: number;
  // enriched_at intentionally omitted — never reset on re-ingest
  ingested_at: string;
};

type PrChangedFileRow = {
  pr_id: number;
  filename: string;
  additions: number;
  deletions: number;
  touch_type: "add" | "modify" | "delete" | "rename";
  patch_excerpt: null; // GraphQL has no diff content
};

type PrReviewRow = {
  id: number;
  pr_id: number;
  pr_number: number;
  reviewer_login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  submitted_at: string;
  body: string | null;
  n_comments: number;
  n_inline_comments: number;
  comments_json: Array<{ path: string; body: string; created_at: string }>;
  // enriched_at intentionally omitted — never reset on re-ingest
  ingested_at: string;
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Map GitHub GraphQL changeType → the touch_type values allowed by the DB CHECK constraint.
 * COPIED has no exact match; treat it as "add" (a new file appears from the author's perspective).
 */
function mapChangeType(
  changeType: GHFileNode["changeType"],
): PrChangedFileRow["touch_type"] {
  switch (changeType) {
    case "ADDED":    return "add";
    case "DELETED":  return "delete";
    case "RENAMED":  return "rename";
    case "COPIED":   return "add";
    default:         return "modify"; // MODIFIED + any unknown future value
  }
}

/**
 * Map GitHub review state → the three values allowed by pr_reviews.state CHECK constraint.
 * DISMISSED reviews were once CHANGES_REQUESTED and are treated as COMMENTED for scoring.
 * PENDING reviews have no submittedAt and are skipped before this function is called.
 */
function normalizeReviewState(
  state: GHReview["state"],
): PrReviewRow["state"] {
  switch (state) {
    case "APPROVED":           return "APPROVED";
    case "CHANGES_REQUESTED":  return "CHANGES_REQUESTED";
    default:                   return "COMMENTED"; // DISMISSED, COMMENTED, any unknown
  }
}

// ─── GitHub GraphQL client ─────────────────────────────────────────────────────

async function ghGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  if (!GH_TOKEN) {
    throw new Error(
      "[ingest] GITHUB_TOKEN is required. Set it in .env.local.\n" +
        "  Create a fine-grained PAT with read access to public repositories at " +
        "https://github.com/settings/tokens",
    );
  }

  const res = await fetch(GH_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "weavedaniel-ingest/1.0",
      "X-Github-Next-Global-ID": "1", // opt-in to stable global IDs
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(
      `[ingest] GitHub GraphQL HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`,
    );
  }

  const json = (await res.json()) as GHGraphQLResponse<T>;

  if (json.errors?.length) {
    const msgs = json.errors.map((e) => `${e.type ?? "ERROR"}: ${e.message}`).join(" | ");
    throw new Error(`[ingest] GitHub GraphQL errors: ${msgs}`);
  }

  if (!json.data) {
    throw new Error("[ingest] GitHub GraphQL returned neither data nor errors");
  }

  return json.data;
}

// ─── Supabase upsert functions ─────────────────────────────────────────────────

type Supabase = ReturnType<typeof createSupabaseServer>;

async function upsertPRs(db: Supabase, rows: PrRow[]): Promise<void> {
  for (const batch of chunk(rows, DB_BATCH)) {
    const { error } = await db
      .from("prs")
      .upsert(batch, {
        onConflict: "id",
        ignoreDuplicates: false, // always update metadata on re-ingest
      });
    if (error) throw new Error(`[ingest] prs upsert: ${error.message}`);
  }
}

async function upsertFiles(db: Supabase, rows: PrChangedFileRow[]): Promise<void> {
  for (const batch of chunk(rows, DB_BATCH)) {
    const { error } = await db
      .from("pr_changed_files")
      .upsert(batch, {
        onConflict: "pr_id,filename",
        ignoreDuplicates: false,
      });
    if (error) throw new Error(`[ingest] pr_changed_files upsert: ${error.message}`);
  }
}

async function upsertReviews(db: Supabase, rows: PrReviewRow[]): Promise<void> {
  for (const batch of chunk(rows, DB_BATCH)) {
    const { error } = await db
      .from("pr_reviews")
      .upsert(batch, {
        onConflict: "id",
        ignoreDuplicates: false,
      });
    if (error) throw new Error(`[ingest] pr_reviews upsert: ${error.message}`);
  }
}

// ─── Transformation ────────────────────────────────────────────────────────────

function transformPR(pr: GHPullRequest, now: string): PrRow {
  return {
    id: pr.databaseId,
    repo: REPO,
    number: pr.number,
    author_login: pr.author?.login ?? "ghost",
    title: pr.title.slice(0, 500),
    body: pr.body ? pr.body.slice(0, 10_000) : null,
    state: pr.state.toLowerCase(), // "merged" for merged PRs
    merged_at: pr.mergedAt!, // only called when mergedAt is non-null
    created_at: pr.createdAt,
    closed_at: pr.closedAt ?? null,
    label_names: pr.labels.nodes.map((l) => l.name),
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changedFiles,
    ingested_at: now,
  };
}

function transformFiles(pr: GHPullRequest): PrChangedFileRow[] {
  return pr.files.nodes.map((f) => ({
    pr_id: pr.databaseId,
    filename: f.path,
    additions: f.additions,
    deletions: f.deletions,
    touch_type: mapChangeType(f.changeType),
    patch_excerpt: null,
  }));
}

function transformReviews(pr: GHPullRequest, now: string): PrReviewRow[] {
  const rows: PrReviewRow[] = [];

  for (const review of pr.reviews.nodes) {
    // Skip PENDING (draft) reviews — they have no submittedAt and no stable state
    if (!review.submittedAt || review.state === "PENDING") continue;

    const inlineCount = review.comments.totalCount;
    // n_comments = inline comments + 1 top-level body (if non-empty)
    const nComments = inlineCount + (review.body?.trim() ? 1 : 0);

    rows.push({
      id: review.databaseId,
      pr_id: pr.databaseId,
      pr_number: pr.number,
      reviewer_login: review.author?.login ?? "ghost",
      state: normalizeReviewState(review.state),
      submitted_at: review.submittedAt,
      body: review.body ?? null,
      n_comments: nComments,
      n_inline_comments: inlineCount,
      comments_json: review.comments.nodes.map((c) => ({
        path: c.path,
        body: c.body,
        created_at: c.createdAt,
      })),
      ingested_at: now,
    });
  }

  return rows;
}

// ─── Core: ingest one date-window ──────────────────────────────────────────────

interface WindowCounts {
  prs: number;
  files: number;
  reviews: number;
}

async function ingestWindow(
  db: Supabase,
  fromDate: Date,
  toDate: Date,
  now: string,
): Promise<WindowCounts> {
  const from = isoDay(fromDate);
  const to = isoDay(toDate);
  // GitHub search syntax: merged:FROM..TO  (both dates inclusive)
  const searchQuery = `repo:${REPO} is:pr is:merged merged:${from}..${to}`;

  let cursor: string | null = null;
  let page = 0;
  const counts: WindowCounts = { prs: 0, files: 0, reviews: 0 };

  while (true) {
    page++;
    process.stdout.write(`    page ${page}${cursor ? "" : " (start)"}…`);

    const data: SearchData = await ghGraphQL<SearchData>(SEARCH_PRS_QUERY, {
      query: searchQuery,
      first: PAGE_SIZE,
      after: cursor,
    });

    const { pageInfo, nodes }: SearchData["search"] = data.search;

    const prRows: PrRow[] = [];
    const fileRows: PrChangedFileRow[] = [];
    const reviewRows: PrReviewRow[] = [];

    for (const node of nodes) {
      // search() can return Issues mixed with PRs; skip non-PRs
      if (node.__typename !== "PullRequest") continue;
      const pr = node as GHPullRequest;
      if (!pr.mergedAt) continue; // guard: only process merged PRs

      prRows.push(transformPR(pr, now));
      fileRows.push(...transformFiles(pr));
      reviewRows.push(...transformReviews(pr, now));
    }

    // PRs must be upserted before files/reviews (FK constraint)
    if (prRows.length) await upsertPRs(db, prRows);
    if (fileRows.length) await upsertFiles(db, fileRows);
    if (reviewRows.length) await upsertReviews(db, reviewRows);

    counts.prs += prRows.length;
    counts.files += fileRows.length;
    counts.reviews += reviewRows.length;

    process.stdout.write(
      ` ${prRows.length} PRs / ${fileRows.length} files / ${reviewRows.length} reviews\n`,
    );

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
    await sleep(INTER_PAGE_MS);
  }

  return counts;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = createSupabaseServer();
  const now = new Date();
  const nowIso = now.toISOString();

  console.log(`[ingest] repo:          ${REPO}`);
  console.log(`[ingest] window:        ${WINDOW_DAYS} days`);
  console.log(`[ingest] chunk size:    ${CHUNK_DAYS} days`);
  console.log(`[ingest] cutoff:        ${isoDay(new Date(now.getTime() - WINDOW_DAYS * 86_400_000))}`);
  console.log();

  // Build ordered list of [from, to) date pairs covering the full window
  const windows: { from: Date; to: Date }[] = [];
  {
    const cutoff = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
    let chunkStart = new Date(cutoff);
    while (chunkStart < now) {
      const chunkEnd = new Date(
        Math.min(
          chunkStart.getTime() + CHUNK_DAYS * 86_400_000,
          now.getTime(),
        ),
      );
      windows.push({ from: new Date(chunkStart), to: new Date(chunkEnd) });
      chunkStart = chunkEnd;
    }
  }

  const grand: WindowCounts = { prs: 0, files: 0, reviews: 0 };

  for (const win of windows) {
    console.log(`[ingest] chunk ${isoDay(win.from)} → ${isoDay(win.to)}`);
    const counts = await ingestWindow(db, win.from, win.to, nowIso);
    grand.prs += counts.prs;
    grand.files += counts.files;
    grand.reviews += counts.reviews;
    console.log(
      `  subtotal: ${counts.prs} PRs, ${counts.files} files, ${counts.reviews} reviews\n`,
    );
    await sleep(INTER_PAGE_MS);
  }

  console.log(
    `[ingest] ✓ complete — ${grand.prs} PRs, ${grand.files} files, ${grand.reviews} reviews`,
  );
}

main().catch((err: unknown) => {
  console.error("[ingest] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
