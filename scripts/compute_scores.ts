/**
 * compute_scores.ts
 * ─────────────────
 * Reads the last 90 days of enriched PRs and reviews, computes per-engineer
 * subscores, and writes the results atomically to `engineer_scores_90d`.
 *
 * No LLM calls — pure arithmetic from Gemini outputs already in the DB.
 *
 * Tables read:
 *   prs, pr_features, pr_llm_features
 *   pr_reviews, review_llm_features
 *
 * Tables written:
 *   engineer_scores_90d  (delete-all + batch insert for atomicity)
 *
 * ── PR scoring ────────────────────────────────────────────────────────────
 *
 *   impact_score  = 0.30×complexity + 0.25×risk + 0.20×cross_cutting
 *                 + 0.15×user_facing + 0.10×|tech_debt_delta|×2
 *                 (0–100 scale; from pr_llm_features)
 *
 *   PR_points = (impact_score / 10)
 *             × TYPE_WEIGHT[pr_category]
 *             × PRODUCT_WEIGHT[primary_subsystem]
 *             × (user_facing_score >= 50 ? 1.15 : 1.00)
 *             × SIZE_CAP[size_bucket]   ← cap only, not a driver
 *
 * ── Review scoring ────────────────────────────────────────────────────────
 *
 *   review_base = STATE_WEIGHT[state]
 *               + 0.4  if this APPROVED is the last APPROVED before PR merge
 *               + 0.3  if reviewer had CHANGES_REQUESTED then APPROVED same PR
 *
 *   review_points = review_base
 *                 × (pr_impact_score/10 × pr_product_weight × (pr_user_facing ? 1.1 : 1.0))
 *
 * ── Engineer subscores (0–100, percentile rank across team) ───────────────
 *
 *   Shipping       = sum(PR_points)      / active_PR_weeks   (higher = better)
 *   Unblocking     = sum(review_points)  / active_rev_weeks  (higher = better)
 *   Responsiveness = median response_time_hours              (lower  = better)
 *
 *   Composite = 0.70 × Shipping + 0.20 × Unblocking + 0.10 × Responsiveness
 *
 * Env vars required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import "dotenv/config";
import { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServer } from "../lib/supabase-server";

// ── Constants ────────────────────────────────────────────────────────────────

const WINDOW_DAYS = 90;

/** PR category → score multiplier */
const TYPE_WEIGHT: Record<string, number> = {
  security: 1.20,
  perf:     1.10,
  bug_fix:  1.05,
  feature:  1.00,
  infra:    0.95,
  refactor: 0.90,
  test:     0.70,
  docs:     0.60,
};

/**
 * Primary subsystem prefix → product multiplier.
 * Checked in order; first prefix match wins.
 */
const PRODUCT_WEIGHT_TABLE: Array<[string, number]> = [
  ["ee",              1.20],
  ["posthog/api",     1.15],
  ["posthog/queries", 1.15],
  ["plugin-server",   1.10],
  ["posthog/tasks",   1.10],
  ["posthog/models",  1.10],
  ["frontend",        1.05],
  ["posthog",         1.00],
  ["tests",           0.90],
  ["docs",            0.80],
];

/**
 * Size bucket → maximum fraction of computed PR_points retained.
 * Size bucket is a CAP only — it cannot increase points.
 */
const SIZE_CAP: Record<string, number> = {
  XS: 0.50,
  S:  0.80,
  M:  1.00,
  L:  1.00,
  XL: 1.00,
};

/** Review state → base weight (ordered: CR > APPROVED > COMMENTED > DISMISSED) */
const STATE_WEIGHT: Record<string, number> = {
  CHANGES_REQUESTED: 1.00,
  APPROVED:          0.70,
  COMMENTED:         0.40,
  DISMISSED:         0.20,
};

// ── Row shapes (minimal; only what this script uses) ─────────────────────────

interface PrRow {
  id: string;
  author_login: string;
  merged_at: string;
  additions: number;
  deletions: number;
}

interface PrFeatureRow {
  pr_id: string;
  subsystem_list: string[] | null;
}

interface PrLlmRow {
  pr_id: string;
  complexity_score: number;
  risk_score: number;
  cross_cutting_score: number;
  user_facing_score: number;
  tech_debt_delta: number;
  pr_category: string;
}

interface ReviewRow {
  id: string;
  pr_id: string;
  reviewer_login: string;
  state: string;
  submitted_at: string;
}

interface ReviewLlmRow {
  review_id: string;
  response_time_hours: number | null;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function productWeight(subsystemList: string[] | null): number {
  const primary = subsystemList?.[0] ?? "";
  for (const [prefix, w] of PRODUCT_WEIGHT_TABLE) {
    if (primary.startsWith(prefix)) return w;
  }
  return 1.00;
}

function sizeBucket(additions: number, deletions: number): string {
  const total = additions + deletions;
  if (total < 10)   return "XS";
  if (total < 100)  return "S";
  if (total < 500)  return "M";
  if (total < 2000) return "L";
  return "XL";
}

/** ISO week key for grouping active weeks, e.g. "2026-W09" */
function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(
    ((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/**
 * Percentile rank of `value` within `pool` (0–100).
 *   ascending=true  → higher value ranks higher (for shipping/unblocking rates)
 *   ascending=false → lower  value ranks higher (for response time)
 * Ties share the same percentile (count of strictly better values / (N-1)).
 */
function pctRank(value: number, pool: number[], ascending: boolean): number {
  if (pool.length <= 1) return 50;
  const n = pool.length - 1;
  if (ascending) {
    return (pool.filter((v) => v < value).length / n) * 100;
  } else {
    return (pool.filter((v) => v > value).length / n) * 100;
  }
}

// ── Data fetching ─────────────────────────────────────────────────────────────

/**
 * Splits an array into chunks and runs an IN-query for each, concatenating
 * results.  Supabase/PostgREST translates .in() to a URL query parameter so
 * very large ID lists can hit the HTTP request-line limit.
 */
async function fetchByIds<T>(
  supabase: SupabaseClient,
  table: string,
  idColumn: string,
  ids: string[],
  columns: string,
  chunkSize = 400,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .in(idColumn, chunk);
    if (error) throw new Error(`fetch ${table}: ${error.message}`);
    if (data) out.push(...(data as T[]));
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const supabase = createSupabaseServer();

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
  const windowStartISO = windowStart.toISOString();
  console.log(
    `[compute_scores] window ${windowStart.toISOString().slice(0, 10)} → ${new Date().toISOString().slice(0, 10)}`,
  );

  // ── 1. Fetch merged, enriched PRs in window ───────────────────────────────

  const { data: prsRaw, error: prsErr } = await supabase
    .from("prs")
    .select("id, author_login, merged_at, additions, deletions")
    .gte("merged_at", windowStartISO)
    .not("enriched_at", "is", null);

  if (prsErr) throw new Error(`fetch prs: ${prsErr.message}`);
  const prs: PrRow[] = (prsRaw ?? []) as PrRow[];

  if (prs.length === 0) {
    console.log("[compute_scores] No enriched PRs in window — nothing to do.");
    return;
  }
  const prIds = prs.map((p) => String(p.id));
  console.log(`[compute_scores] ${prs.length} PRs`);

  // ── 2. Fetch pr_features + pr_llm_features ────────────────────────────────

  const [prFeats, prLlms] = await Promise.all([
    fetchByIds<PrFeatureRow>(
      supabase, "pr_features", "pr_id", prIds,
      "pr_id, subsystem_list",
    ),
    fetchByIds<PrLlmRow>(
      supabase, "pr_llm_features", "pr_id", prIds,
      "pr_id, complexity_score, risk_score, cross_cutting_score, user_facing_score, tech_debt_delta, pr_category",
    ),
  ]);

  const featuresByPr = new Map(prFeats.map((f) => [String(f.pr_id), f]));
  const llmByPr      = new Map(prLlms.map((f) => [String(f.pr_id), f]));

  // ── 3. Compute PR_points per PR ───────────────────────────────────────────

  interface PrScore {
    pr_id: string;
    author_login: string;
    merged_at: string;
    pr_points: number;
    /** impact_score on 0-100 scale, stored for review multiplier */
    impact100: number;
    product_weight: number;
    user_facing: boolean;
  }

  const prScores: PrScore[] = [];

  for (const pr of prs) {
    const id  = String(pr.id);
    const llm = llmByPr.get(id);
    if (!llm) continue; // unenriched — skip

    const feat = featuresByPr.get(id);

    // impact_score (0–100): weighted average of Gemini dimension scores
    const impact100 =
      0.30 * llm.complexity_score
      + 0.25 * llm.risk_score
      + 0.20 * llm.cross_cutting_score
      + 0.15 * llm.user_facing_score
      + 0.10 * Math.abs(llm.tech_debt_delta) * 2;

    const user_facing    = llm.user_facing_score >= 50;
    const type_w         = TYPE_WEIGHT[llm.pr_category] ?? 1.00;
    const product_w      = productWeight(feat?.subsystem_list ?? null);
    const user_facing_m  = user_facing ? 1.15 : 1.00;

    // Base PR_points
    let pts = (impact100 / 10) * type_w * product_w * user_facing_m;

    // Size bucket applies as cap only
    const bucket = sizeBucket(pr.additions, pr.deletions);
    pts *= SIZE_CAP[bucket] ?? 1.00;

    prScores.push({
      pr_id:          id,
      author_login:   pr.author_login,
      merged_at:      pr.merged_at,
      pr_points:      pts,
      impact100,
      product_weight: product_w,
      user_facing,
    });
  }

  console.log(`[compute_scores] PR_points computed for ${prScores.length} PRs`);
  const prScoreById = new Map(prScores.map((s) => [s.pr_id, s]));

  // ── 4. Fetch pr_reviews for those PRs ────────────────────────────────────
  //    Filter to enriched reviews only (enriched_at IS NOT NULL).

  const reviews = await fetchByIds<ReviewRow>(
    supabase, "pr_reviews", "pr_id", prIds,
    "id, pr_id, reviewer_login, state, submitted_at",
  );
  // Keep only enriched reviews
  const enrichedReviewIds: string[] = [];

  {
    const allRevIds = reviews.map((r) => String(r.id));
    if (allRevIds.length > 0) {
      // Check which have review_llm_features (meaning enriched)
      const existing = await fetchByIds<{ review_id: string }>(
        supabase, "review_llm_features", "review_id", allRevIds,
        "review_id",
      );
      const enrichedSet = new Set(existing.map((e) => String(e.review_id)));
      enrichedReviewIds.push(
        ...reviews.filter((r) => enrichedSet.has(String(r.id))).map((r) => String(r.id)),
      );
    }
  }

  const enrichedReviews = reviews.filter((r) =>
    enrichedReviewIds.includes(String(r.id)),
  );

  console.log(
    `[compute_scores] ${enrichedReviews.length} enriched reviews (of ${reviews.length} total)`,
  );

  // ── 5. Fetch review_llm_features ─────────────────────────────────────────

  const reviewLlms = await fetchByIds<ReviewLlmRow>(
    supabase, "review_llm_features", "review_id", enrichedReviewIds,
    "review_id, response_time_hours",
  );
  const reviewLlmById = new Map(reviewLlms.map((r) => [String(r.review_id), r]));

  // ── 6. Compute review bonuses ────────────────────────────────────────────
  //
  //  (a) Last-APPROVED bonus (+0.4): the APPROVED review with the latest
  //      submitted_at for a given PR — i.e. the review that cleared the PR
  //      for merge.  Only one review per PR can get this.
  //
  //  (b) Unblock-conversion bonus (+0.3): for a (reviewer, pr) pair, the
  //      reviewer first submitted CHANGES_REQUESTED, then later APPROVED.
  //      The APPROVED review gets the bonus.

  // Group all reviews (not just enriched) by pr_id for bonus detection
  const reviewsByPr = new Map<string, ReviewRow[]>();
  for (const r of reviews) {
    const pid = String(r.pr_id);
    const list = reviewsByPr.get(pid) ?? [];
    list.push(r);
    reviewsByPr.set(pid, list);
  }

  // last-APPROVED review id per PR
  const lastApprovalId = new Map<string, string>(); // pr_id → review.id
  for (const [pid, prRevs] of reviewsByPr) {
    const approvals = prRevs
      .filter((r) => r.state === "APPROVED")
      .sort(
        (a, b) =>
          new Date(b.submitted_at).getTime() -
          new Date(a.submitted_at).getTime(),
      );
    if (approvals.length > 0) {
      lastApprovalId.set(pid, String(approvals[0].id));
    }
  }

  // unblock-conversion set: `${reviewer_login}:${pr_id}` keys
  const unblockSet = new Set<string>();
  for (const [pid, prRevs] of reviewsByPr) {
    // group by reviewer within this PR
    const byReviewer = new Map<string, ReviewRow[]>();
    for (const r of prRevs) {
      const list = byReviewer.get(r.reviewer_login) ?? [];
      list.push(r);
      byReviewer.set(r.reviewer_login, list);
    }
    for (const [reviewer, revs] of byReviewer) {
      const sorted = [...revs].sort(
        (a, b) =>
          new Date(a.submitted_at).getTime() -
          new Date(b.submitted_at).getTime(),
      );
      let sawCR = false;
      for (const r of sorted) {
        if (r.state === "CHANGES_REQUESTED") sawCR = true;
        if (r.state === "APPROVED" && sawCR) {
          unblockSet.add(`${reviewer}:${pid}`);
          break;
        }
      }
    }
  }

  // ── 7. Compute review_points per enriched review ──────────────────────────

  interface ReviewScore {
    review_id: string;
    reviewer_login: string;
    pr_id: string;
    submitted_at: string;
    review_points: number;
    response_time_hours: number | null;
  }

  const reviewScores: ReviewScore[] = [];

  for (const r of enrichedReviews) {
    const rid = String(r.id);
    const pid = String(r.pr_id);

    const state_w = STATE_WEIGHT[r.state] ?? 0.20;

    let bonus = 0;
    if (r.state === "APPROVED" && lastApprovalId.get(pid) === rid) {
      bonus += 0.4; // final approval
    }
    if (r.state === "APPROVED" && unblockSet.has(`${r.reviewer_login}:${pid}`)) {
      bonus += 0.3; // unblock conversion
    }

    const review_base = state_w + bonus;

    // Importance of the reviewed PR
    const prData = prScoreById.get(pid);
    let pr_importance = 1.0;
    if (prData) {
      pr_importance =
        (prData.impact100 / 10) *
        prData.product_weight *
        (prData.user_facing ? 1.1 : 1.0);
    }

    const rlf = reviewLlmById.get(rid);

    reviewScores.push({
      review_id:           rid,
      reviewer_login:      r.reviewer_login,
      pr_id:               pid,
      submitted_at:        r.submitted_at,
      review_points:       review_base * pr_importance,
      response_time_hours: rlf?.response_time_hours ?? null,
    });
  }

  console.log(`[compute_scores] review_points computed for ${reviewScores.length} reviews`);

  // ── 8. Aggregate per engineer ─────────────────────────────────────────────

  interface EngAgg {
    login: string;
    prPointsArr:    number[];
    prWeeks:        Set<string>;
    reviewPointsArr: number[];
    reviewWeeks:    Set<string>;
    responseTimes:  number[]; // finite hours only
    nPrs:           number;
    nReviews:       number;
  }

  const engMap = new Map<string, EngAgg>();
  const eng = (login: string): EngAgg => {
    if (!engMap.has(login)) {
      engMap.set(login, {
        login,
        prPointsArr:     [],
        prWeeks:         new Set(),
        reviewPointsArr: [],
        reviewWeeks:     new Set(),
        responseTimes:   [],
        nPrs:            0,
        nReviews:        0,
      });
    }
    return engMap.get(login)!;
  };

  for (const s of prScores) {
    const e = eng(s.author_login);
    e.prPointsArr.push(s.pr_points);
    e.prWeeks.add(isoWeekKey(new Date(s.merged_at)));
    e.nPrs++;
  }

  for (const s of reviewScores) {
    const e = eng(s.reviewer_login);
    e.reviewPointsArr.push(s.review_points);
    e.reviewWeeks.add(isoWeekKey(new Date(s.submitted_at)));
    if (s.response_time_hours !== null && s.response_time_hours >= 0) {
      e.responseTimes.push(s.response_time_hours);
    }
    e.nReviews++;
  }

  // ── 9. Compute raw rates ──────────────────────────────────────────────────

  interface Rates {
    login:           string;
    shippingRate:    number; // PR_points per active PR week
    unblockingRate:  number; // review_points per active review week
    medianResponse:  number; // hours; Infinity if no reviews
    nPrs:            number;
    nReviews:        number;
    sumPrPoints:     number;
    sumReviewPoints: number;
  }

  const allRates: Rates[] = [];
  for (const [, e] of engMap) {
    const sumPr  = e.prPointsArr.reduce((a, v) => a + v, 0);
    const sumRev = e.reviewPointsArr.reduce((a, v) => a + v, 0);
    allRates.push({
      login:           e.login,
      shippingRate:    e.prWeeks.size    > 0 ? sumPr  / e.prWeeks.size    : 0,
      unblockingRate:  e.reviewWeeks.size > 0 ? sumRev / e.reviewWeeks.size : 0,
      medianResponse:  medianOf(e.responseTimes) ?? Infinity,
      nPrs:            e.nPrs,
      nReviews:        e.nReviews,
      sumPrPoints:     sumPr,
      sumReviewPoints: sumRev,
    });
  }

  // ── 10. Percentile-rank each metric across team ────────────────────────────

  const shippingPool    = allRates.map((r) => r.shippingRate);
  const unblockingPool  = allRates.map((r) => r.unblockingRate);
  // For responsiveness, use only finite values; engineers with no reviews → 50
  const finitePool      = allRates
    .filter((r) => r.medianResponse !== Infinity)
    .map((r) => r.medianResponse);

  interface EngScore {
    login:         string;
    shipping:      number; // 0-100
    unblocking:    number; // 0-100
    responsiveness: number; // 0-100
    composite:     number; // 0-100
    nPrs:          number;
    nReviews:      number;
    sumPrPoints:   number;
    sumRevPoints:  number;
  }

  const engScores: EngScore[] = allRates.map((r) => {
    const shipping   = pctRank(r.shippingRate,   shippingPool,   true);
    const unblocking = pctRank(r.unblockingRate, unblockingPool, true);
    const responsiveness =
      r.medianResponse === Infinity || finitePool.length === 0
        ? 50 // neutral for engineers with no reviews in window
        : pctRank(r.medianResponse, finitePool, false); // lower time = higher rank

    const composite = 0.70 * shipping + 0.20 * unblocking + 0.10 * responsiveness;

    return {
      login:          r.login,
      shipping,
      unblocking,
      responsiveness,
      composite,
      nPrs:           r.nPrs,
      nReviews:       r.nReviews,
      sumPrPoints:    r.sumPrPoints,
      sumRevPoints:   r.sumReviewPoints,
    };
  });

  // Ordinal rank by composite descending
  const sortedByComposite = [...engScores].sort((a, b) => b.composite - a.composite);
  const rankOf = new Map(sortedByComposite.map((s, i) => [s.login, i + 1]));

  // ── 11. Write atomically to engineer_scores_90d ───────────────────────────

  const windowEnd  = new Date().toISOString().slice(0, 10);
  const computedAt = new Date().toISOString();

  const insertRows = engScores.map((s) => ({
    author_login:     s.login,
    window_end:       windowEnd,
    n_prs_merged:     s.nPrs,
    // avg_pr_score stores Shipping subscore (0–1) for downstream consumers
    avg_pr_score:     parseFloat((s.shipping    / 100).toFixed(4)),
    n_reviews_given:  s.nReviews,
    // avg_review_score stores Unblocking subscore (0–1)
    avg_review_score: parseFloat((s.unblocking  / 100).toFixed(4)),
    // raw_composite = 0.70×Shipping + 0.20×Unblocking + 0.10×Responsiveness (0–1)
    raw_composite:    parseFloat((s.composite   / 100).toFixed(4)),
    // avg_percentile reuses the composite score (0–100) as a human-readable pct
    avg_percentile:   parseFloat(s.composite.toFixed(2)),
    rank:             rankOf.get(s.login) ?? null,
    computed_at:      computedAt,
  }));

  // Clear the table first, then insert fresh (atomic for a batch cron job)
  const { error: delErr } = await supabase
    .from("engineer_scores_90d")
    .delete()
    .not("author_login", "is", null);

  if (delErr) throw new Error(`clear engineer_scores_90d: ${delErr.message}`);

  const BATCH = 100;
  for (let i = 0; i < insertRows.length; i += BATCH) {
    const { error: insErr } = await supabase
      .from("engineer_scores_90d")
      .insert(insertRows.slice(i, i + BATCH));
    if (insErr) throw new Error(`insert engineer_scores_90d (batch ${i}): ${insErr.message}`);
  }

  console.log(
    `[compute_scores] wrote ${insertRows.length} rows to engineer_scores_90d`,
  );
  console.log("[compute_scores] done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
