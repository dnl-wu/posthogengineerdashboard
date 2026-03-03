/**
 * score-reviews.ts
 * ─────────────────
 * Deterministic scoring: reads `review_llm_features` (joined with `pr_reviews`
 * for state and inline-comment count) and writes `review_scores`.
 * No LLM calls — pure arithmetic.
 *
 * Tables read:    review_llm_features, pr_reviews  (schema: docs/schema.md §3, 6)
 * Tables written: review_scores  (schema: docs/schema.md §8)
 *
 * Processes reviews belonging to PRs merged in the last 90 days.
 * Uses upsert so the script is safe to re-run.
 *
 * Formulas (plan.md §4):
 *
 *   quality_raw = (0.30×depth + 0.25×actionability + 0.25×correctness_focus
 *                + 0.15×architecture_focus + 0.05×tone_score) / 100
 *
 *   engagement  = (state == 'CHANGES_REQUESTED' ? 0.10 : 0)
 *               + (response_time_hours < 4       ? 0.05 : 0)
 *               + (n_inline_comments >= 5         ? 0.05 : 0)
 *
 *   raw_review_score = min(1, quality_raw + engagement)
 *
 * Env vars required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import "dotenv/config";
import { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServer } from "../lib/supabase-server";

const WINDOW_DAYS = 90;

/** Returns the ISO-8601 Monday of the week containing `date`, as 'YYYY-MM-DD'. */
function mondayOf(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 1 - day);
  return d.toISOString().slice(0, 10);
}

async function fetchChunked<T>(
  supabase: SupabaseClient,
  table: string,
  col: string,
  ids: string[],
  select: string,
  chunkSize = 400,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .in(col, ids.slice(i, i + chunkSize));
    if (error) throw new Error(`${table} fetch: ${error.message}`);
    if (data) out.push(...(data as T[]));
  }
  return out;
}

async function main(): Promise<void> {
  const supabase = createSupabaseServer();

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
  console.log(
    `[score-reviews] window: ${windowStart.toISOString().slice(0, 10)} → today`,
  );

  // ── 1. Fetch merged PRs in window to get PR IDs ──────────────────────────

  const { data: prsRaw, error: prsErr } = await supabase
    .from("prs")
    .select("id")
    .gte("merged_at", windowStart.toISOString());

  if (prsErr) throw new Error(`prs fetch: ${prsErr.message}`);
  const prIds = ((prsRaw ?? []) as { id: string }[]).map((p) => String(p.id));

  if (prIds.length === 0) {
    console.log("[score-reviews] No PRs in window.");
    return;
  }
  console.log(`[score-reviews] ${prIds.length} PRs in window`);

  // ── 2. Fetch pr_reviews for those PRs ────────────────────────────────────

  const reviews = await fetchChunked<{
    id: string;
    pr_id: string;
    reviewer_login: string;
    state: string;
    submitted_at: string;
    n_inline_comments: number;
  }>(
    supabase, "pr_reviews", "pr_id", prIds,
    "id, pr_id, reviewer_login, state, submitted_at, n_inline_comments",
  );

  if (reviews.length === 0) {
    console.log("[score-reviews] No reviews found for these PRs.");
    return;
  }

  console.log(`[score-reviews] ${reviews.length} reviews`);

  // ── 3. Identify "final approvals" per PR ─────────────────────────────────

  type ReviewRow = {
    id: string;
    pr_id: string;
    reviewer_login: string;
    state: string;
    submitted_at: string;
    n_inline_comments: number;
  };

  const byPr = new Map<string, ReviewRow[]>();
  for (const r of reviews as ReviewRow[]) {
    const pid = String(r.pr_id);
    const list = byPr.get(pid) ?? [];
    list.push(r);
    byPr.set(pid, list);
  }

  // last-APPROVED review id per PR
  const lastApprovalId = new Map<string, string>(); // pr_id → review.id
  for (const [pid, prRevs] of byPr) {
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

  // ── 4. Compute scores (final-approval indicator) ──────────────────────────

  const rows: object[] = [];

  for (const review of reviews as ReviewRow[]) {
    const rid = String(review.id);
    const pid = String(review.pr_id);

    // score = 1 only if this review is the final APPROVED on the PR
    const isFinalApproval =
      review.state === "APPROVED" && lastApprovalId.get(pid) === rid;

    const quality_raw = isFinalApproval ? 1 : 0;
    const engagement  = 0; // no extra bonuses in LLM-free mode
    const raw_review_score = Math.min(1, quality_raw + engagement);

    rows.push({
      review_id:        rid,
      reviewer_login:   review.reviewer_login,
      pr_id:            pid,
      submitted_at:     review.submitted_at,
      quality_score:    parseFloat(quality_raw.toFixed(4)),
      engagement_bonus: parseFloat(engagement.toFixed(3)),
      raw_review_score: parseFloat(raw_review_score.toFixed(4)),
      week_start:       mondayOf(new Date(review.submitted_at)),
      scored_at:        new Date().toISOString(),
    });
  }

  console.log(`[score-reviews] Computed scores for ${rows.length} reviews`);

  // ── 5. Upsert ─────────────────────────────────────────────────────────────

  const BATCH = 100;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase
      .from("review_scores")
      .upsert(rows.slice(i, i + BATCH), { onConflict: "review_id" });
    if (error) throw new Error(`review_scores upsert: ${error.message}`);
    upserted += rows.slice(i, i + BATCH).length;
  }

  console.log(
    `[score-reviews] Upserted ${upserted} rows into review_scores. Done.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
