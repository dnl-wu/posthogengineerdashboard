/**
 * rollup.ts
 * ─────────
 * Aggregates per-author per-week scores and writes five rollup tables.
 * Re-computes the current week and the prior week on every run (idempotent).
 *
 * Tables read:    pr_scores, review_scores, prs, pr_changed_files, pr_llm_features
 * Tables written: engineer_weekly_velocity  (upsert by author_login, week_start)
 *                 team_weekly_velocity       (upsert by week_start)
 *                 engineer_scores_90d        (upsert by author_login)
 *                 engineer_evidence          (delete+insert per author)
 *                 engineer_areas             (upsert by author_login, area)
 *
 * Composite formula (cumulative weighted sum):
 *   raw_composite = 0.70 × sum(raw_pr_score) + 0.30 × sum(raw_review_score)
 *   Rewards volume × quality — prolific engineers score higher than cherry-pickers.
 *
 * Env vars required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import "dotenv/config";
import { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServer } from "../lib/supabase-server";

const WINDOW_DAYS    = 90;
const WINDOW_DAYS_30 = 30;
const BATCH          = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

function mondayOf(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 1 - day);
  return d.toISOString().slice(0, 10);
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo  = Math.floor(pos);
  const hi  = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
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
    if (error) throw new Error(`${table}: ${error.message}`);
    if (data) out.push(...(data as T[]));
  }
  return out;
}

async function upsertBatch(
  supabase: SupabaseClient,
  table: string,
  rows: object[],
  onConflict: string,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase
      .from(table)
      .upsert(rows.slice(i, i + BATCH), { onConflict });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const supabase = createSupabaseServer();

  const now         = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
  const windowStartISO = windowStart.toISOString();

  // 30-day sub-window: calendar days, mirrors the 90d approach above
  const window30Start = new Date(now);
  window30Start.setDate(window30Start.getDate() - WINDOW_DAYS_30);
  const window30StartISO = window30Start.toISOString();

  const computedAt = now.toISOString();
  const windowEnd  = now.toISOString().slice(0, 10);

  console.log(`[rollup] window ${windowStart.toISOString().slice(0, 10)} → ${windowEnd}`);

  // ── 1. Load pr_scores in window ───────────────────────────────────────────

  const { data: prScoresRaw, error: psErr } = await supabase
    .from("pr_scores")
    .select("pr_id, author_login, merged_at, raw_pr_score, week_start")
    .gte("merged_at", windowStartISO);

  if (psErr) throw new Error(`pr_scores: ${psErr.message}`);
  const prScores = (prScoresRaw ?? []) as {
    pr_id: string;
    author_login: string;
    merged_at: string;
    raw_pr_score: number;
    week_start: string;
  }[];
  console.log(`[rollup] ${prScores.length} pr_scores`);

  // ── 2. Load review_scores in window ──────────────────────────────────────
  //    Filter by the PR's merged_at window: join via pr_id.
  //    Simple approach: load all review_scores and filter by week_start >= window.

  const { data: revScoresRaw, error: rsErr } = await supabase
    .from("review_scores")
    .select("review_id, reviewer_login, pr_id, submitted_at, raw_review_score, week_start")
    .gte("submitted_at", windowStartISO);

  if (rsErr) throw new Error(`review_scores: ${rsErr.message}`);
  const revScores = (revScoresRaw ?? []) as {
    review_id: string;
    reviewer_login: string;
    pr_id: string;
    submitted_at: string;
    raw_review_score: number;
    week_start: string;
  }[];
  console.log(`[rollup] ${revScores.length} review_scores`);

  // 30-day subsets — re-use the already-fetched arrays; no extra DB round-trip
  const prScores30  = prScores.filter(s => s.merged_at   >= window30StartISO);
  const revScores30 = revScores.filter(s => s.submitted_at >= window30StartISO);
  console.log(`[rollup] ${prScores30.length} pr_scores (30d), ${revScores30.length} review_scores (30d)`);

  // ── 3. Aggregate per (author, week) ──────────────────────────────────────

  type WeekKey = string; // `${login}|${week_start}`

  interface WeekAgg {
    author_login: string;
    week_start:   string;
    prScores:     number[];
    revScores:    number[];
  }

  const weekMap = new Map<WeekKey, WeekAgg>();

  const weekAgg = (login: string, week: string): WeekAgg => {
    const key = `${login}|${week}`;
    if (!weekMap.has(key)) {
      weekMap.set(key, { author_login: login, week_start: week, prScores: [], revScores: [] });
    }
    return weekMap.get(key)!;
  };

  for (const s of prScores) {
    weekAgg(s.author_login, s.week_start).prScores.push(Number(s.raw_pr_score));
  }
  for (const s of revScores) {
    weekAgg(s.reviewer_login, s.week_start).revScores.push(Number(s.raw_review_score));
  }

  // ── 4. Build engineer_weekly_velocity rows ────────────────────────────────

  const ewvRows = [...weekMap.values()].map((w) => {
    const sumPr  = w.prScores.reduce((a, v) => a + v, 0);
    const sumRev = w.revScores.reduce((a, v) => a + v, 0);
    const avgPr  = w.prScores.length  > 0 ? sumPr  / w.prScores.length  : 0;
    const avgRev = w.revScores.length > 0 ? sumRev / w.revScores.length : 0;
    // Weekly Product Impact Units (PIUs) from PRs only — additive across PRs
    const composite = sumPr * 100;
    return {
      author_login:      w.author_login,
      week_start:        w.week_start,
      n_prs_merged:      w.prScores.length,
      avg_pr_score:      parseFloat(avgPr.toFixed(4)),
      sum_pr_score:      parseFloat(sumPr.toFixed(4)),
      n_reviews:         w.revScores.length,
      avg_review_score:  parseFloat(avgRev.toFixed(4)),
      sum_review_score:  parseFloat(sumRev.toFixed(4)),
      raw_composite:     parseFloat(composite.toFixed(1)),
      team_percentile:   null as number | null,
      computed_at:       computedAt,
    };
  });

  // ── 5. Compute team percentiles per week and stamp team_weekly_velocity ───

  // Identify the top-N engineers globally (by average composite) so the team
  // band represents the *rest* of the engineering team, not the top performers.
  const TOP_BAND_EXCLUDE = 5;
  const loginAvgMap = new Map<string, number[]>();
  for (const r of ewvRows) {
    if (!loginAvgMap.has(r.author_login)) loginAvgMap.set(r.author_login, []);
    loginAvgMap.get(r.author_login)!.push(r.raw_composite);
  }
  const sortedByAvg = [...loginAvgMap.entries()]
    .map(([login, vals]) => ({ login, avg: vals.reduce((a, v) => a + v, 0) / vals.length }))
    .sort((a, b) => b.avg - a.avg);
  const topNSet = new Set(sortedByAvg.slice(0, TOP_BAND_EXCLUDE).map((e) => e.login));

  // Group ewvRows by week_start
  const byWeek = new Map<string, typeof ewvRows>();
  for (const r of ewvRows) {
    const list = byWeek.get(r.week_start) ?? [];
    list.push(r);
    byWeek.set(r.week_start, list);
  }

  const teamRows: object[] = [];

  for (const [week_start, weekEngineers] of byWeek) {
    const allComposites = weekEngineers
      .map((e) => e.raw_composite)
      .sort((a, b) => a - b);

    const n_active = allComposites.length;

    // Assign team_percentile to each engineer vs the full team this week
    for (const e of weekEngineers) {
      if (n_active >= 3) {
        const below = allComposites.filter((v) => v < e.raw_composite).length;
        e.team_percentile = parseFloat(
          ((below / Math.max(n_active - 1, 1)) * 100).toFixed(2),
        );
      } else {
        e.team_percentile = null;
      }
    }

    // Band percentiles use only the non-top-N engineers (rest of team).
    // Fall back to all engineers if not enough "rest" data for percentiles.
    const restEngineers = weekEngineers.filter((e) => !topNSet.has(e.author_login));
    const bandSource = restEngineers.length >= 3 ? restEngineers : weekEngineers;
    const composites = bandSource.map((e) => e.raw_composite).sort((a, b) => a - b);

    teamRows.push({
      week_start,
      n_active,
      mean_composite: composites.length > 0
        ? parseFloat((composites.reduce((a, v) => a + v, 0) / composites.length).toFixed(4))
        : null,
      p25_composite: quantile(composites, 0.25) !== null
        ? parseFloat((quantile(composites, 0.25)!).toFixed(4)) : null,
      p50_composite: quantile(composites, 0.50) !== null
        ? parseFloat((quantile(composites, 0.50)!).toFixed(4)) : null,
      p75_composite: quantile(composites, 0.75) !== null
        ? parseFloat((quantile(composites, 0.75)!).toFixed(4)) : null,
      computed_at: computedAt,
    });
  }

  // Upsert engineer_weekly_velocity
  await upsertBatch(supabase, "engineer_weekly_velocity", ewvRows, "author_login,week_start");
  console.log(`[rollup] Upserted ${ewvRows.length} rows into engineer_weekly_velocity`);

  // Upsert team_weekly_velocity
  await upsertBatch(supabase, "team_weekly_velocity", teamRows, "week_start");
  console.log(`[rollup] Upserted ${teamRows.length} rows into team_weekly_velocity`);

  // ── 6. Compute engineer_scores_90d ───────────────────────────────────────

  // Group pr_scores and review_scores by engineer across the full window
  const engPrMap  = new Map<string, number[]>();
  const engRevMap = new Map<string, number[]>();
  const engWeekPctMap = new Map<string, number[]>(); // team_percentile values per active week

  for (const s of prScores) {
    const list = engPrMap.get(s.author_login) ?? [];
    list.push(Number(s.raw_pr_score));
    engPrMap.set(s.author_login, list);
  }
  for (const s of revScores) {
    const list = engRevMap.get(s.reviewer_login) ?? [];
    list.push(Number(s.raw_review_score));
    engRevMap.set(s.reviewer_login, list);
  }

  // Collect team_percentile from ewvRows per engineer
  for (const r of ewvRows) {
    if (r.team_percentile !== null) {
      const list = engWeekPctMap.get(r.author_login) ?? [];
      list.push(r.team_percentile);
      engWeekPctMap.set(r.author_login, list);
    }
  }

  // Union of all engineers seen (across both windows)
  const allLogins = new Set([...engPrMap.keys(), ...engRevMap.keys()]);

  // ── 30-day aggregate maps ─────────────────────────────────────────────────
  const engPrMap30  = new Map<string, number[]>();
  const engRevMap30 = new Map<string, number[]>();
  for (const s of prScores30) {
    const list = engPrMap30.get(s.author_login) ?? [];
    list.push(Number(s.raw_pr_score));
    engPrMap30.set(s.author_login, list);
  }
  for (const s of revScores30) {
    const list = engRevMap30.get(s.reviewer_login) ?? [];
    list.push(Number(s.raw_review_score));
    engRevMap30.set(s.reviewer_login, list);
  }

  const es90Rows = [...allLogins].map((login) => {
    // 90d
    const prs    = engPrMap.get(login)  ?? [];
    const revs   = engRevMap.get(login) ?? [];
    const pcts   = engWeekPctMap.get(login) ?? [];

    const sumPr  = prs.reduce((a, v) => a + v, 0);
    const sumRev = revs.reduce((a, v) => a + v, 0);
    const avgPr  = prs.length  > 0 ? sumPr  / prs.length  : 0;
    const avgRev = revs.length > 0 ? sumRev / revs.length : 0;
    // 90-day Product Impact Units (PIUs) from PRs only — sum of per-PR PIUs
    const composite = sumPr * 100;
    const avgPct = pcts.length > 0 ? pcts.reduce((a, v) => a + v, 0) / pcts.length : null;

    // 30d sub-window
    const prs30  = engPrMap30.get(login)  ?? [];
    const revs30 = engRevMap30.get(login) ?? [];
    const sumPr30  = prs30.reduce((a, v) => a + v, 0);
    const sumRev30 = revs30.reduce((a, v) => a + v, 0);
    const avgPr30  = prs30.length  > 0 ? sumPr30  / prs30.length  : 0;
    const avgRev30 = revs30.length > 0 ? sumRev30 / revs30.length : 0;
    const composite30 = sumPr30 * 100;

    return {
      author_login:         login,
      window_end:           windowEnd,
      // 90d columns (unchanged)
      n_prs_merged:         prs.length,
      avg_pr_score:         parseFloat(avgPr.toFixed(4)),
      n_reviews_given:      revs.length,
      avg_review_score:     parseFloat(avgRev.toFixed(4)),
      raw_composite:        parseFloat(composite.toFixed(4)),
      avg_percentile:       avgPct !== null ? parseFloat(avgPct.toFixed(2)) : null,
      rank:                 null as number | null, // filled below
      // 30d columns
      n_prs_merged_30d:     prs30.length,
      avg_pr_score_30d:     parseFloat(avgPr30.toFixed(4)),
      n_reviews_given_30d:  revs30.length,
      avg_review_score_30d: parseFloat(avgRev30.toFixed(4)),
      raw_composite_30d:    parseFloat(composite30.toFixed(4)),
      rank_30d:             null as number | null, // filled below
      computed_at:          computedAt,
    };
  });

  // Assign 90d rank by composite descending
  es90Rows.sort((a, b) => b.raw_composite - a.raw_composite);
  es90Rows.forEach((r, i) => {
    if (r.n_prs_merged > 0 || r.n_reviews_given > 0) r.rank = i + 1;
  });

  // Assign 30d rank by 30d composite descending (only engineers active in 30d window)
  const sorted30 = [...es90Rows]
    .filter(r => r.n_prs_merged_30d > 0 || r.n_reviews_given_30d > 0)
    .sort((a, b) => b.raw_composite_30d - a.raw_composite_30d);
  sorted30.forEach((r, i) => { r.rank_30d = i + 1; });

  await upsertBatch(supabase, "engineer_scores_90d", es90Rows, "author_login");
  console.log(`[rollup] Upserted ${es90Rows.length} rows into engineer_scores_90d`);

  // ── 7. engineer_evidence — top PRs per engineer ───────────────────────────
  //
  //  Join pr_scores ↔ pr_llm_features to get category + critical_path flags.
  //  For each engineer: top 10 by raw_pr_score → 'top_pr'
  //  Additional tags (same PR can appear multiple times with different evidence_type):
  //    'security'        if pr_category == 'security'
  //    'high_complexity' if complexity_score >= 80
  //    'critical_path'   if touches_critical_path == true
  //    'high_impact'     if raw_pr_score >= 0.80

  const prScorePrIds = prScores.map((s) => String(s.pr_id));

  const prLlmForEvidence = prScorePrIds.length > 0
    ? await fetchChunked<{
        pr_id: string;
        pr_category: string;
        complexity_score: number;
        touches_critical_path: boolean;
      }>(
        supabase, "pr_llm_features", "pr_id", prScorePrIds,
        "pr_id, pr_category, complexity_score, touches_critical_path",
      )
    : [];

  const llmEvMap = new Map(prLlmForEvidence.map((l) => [String(l.pr_id), l]));

  // Group pr_scores by author
  const prsByAuthor = new Map<string, typeof prScores>();
  for (const s of prScores) {
    const list = prsByAuthor.get(s.author_login) ?? [];
    list.push(s);
    prsByAuthor.set(s.author_login, list);
  }

  // Build evidence rows for each author
  const evidenceRows: object[] = [];

  for (const [author, authorPrs] of prsByAuthor) {
    const sorted = [...authorPrs].sort(
      (a, b) => Number(b.raw_pr_score) - Number(a.raw_pr_score),
    );

    for (const pr of sorted.slice(0, 10)) {
      evidenceRows.push({
        author_login:  author,
        pr_id:         String(pr.pr_id),
        evidence_type: "top_pr",
        raw_pr_score:  parseFloat(Number(pr.raw_pr_score).toFixed(4)),
        week_start:    pr.week_start,
      });
    }

    // Additional evidence tags for noteworthy PRs (all PRs, not just top 10)
    for (const pr of authorPrs) {
      const llm   = llmEvMap.get(String(pr.pr_id));
      const score = Number(pr.raw_pr_score);

      if (llm?.pr_category === "security") {
        evidenceRows.push({
          author_login:  author,
          pr_id:         String(pr.pr_id),
          evidence_type: "security",
          raw_pr_score:  parseFloat(score.toFixed(4)),
          week_start:    pr.week_start,
        });
      }
      if (llm && llm.complexity_score >= 80) {
        evidenceRows.push({
          author_login:  author,
          pr_id:         String(pr.pr_id),
          evidence_type: "high_complexity",
          raw_pr_score:  parseFloat(score.toFixed(4)),
          week_start:    pr.week_start,
        });
      }
      if (llm?.touches_critical_path) {
        evidenceRows.push({
          author_login:  author,
          pr_id:         String(pr.pr_id),
          evidence_type: "critical_path",
          raw_pr_score:  parseFloat(score.toFixed(4)),
          week_start:    pr.week_start,
        });
      }
      if (score >= 0.80) {
        evidenceRows.push({
          author_login:  author,
          pr_id:         String(pr.pr_id),
          evidence_type: "high_impact",
          raw_pr_score:  parseFloat(score.toFixed(4)),
          week_start:    pr.week_start,
        });
      }
    }
  }

  // Upsert by the unique constraint (author_login, pr_id, evidence_type)
  await upsertBatch(
    supabase, "engineer_evidence", evidenceRows,
    "author_login,pr_id,evidence_type",
  );
  console.log(`[rollup] Upserted ${evidenceRows.length} rows into engineer_evidence`);

  // ── 8. engineer_areas — product areas per engineer ───────────────────────
  // Source: pr_llm_features.primary_product + secondary_products
  // This gives actual PostHog products being moved forward, not file directories.

  if (prScorePrIds.length === 0) {
    console.log("[rollup] No PRs — skipping engineer_areas.");
    console.log("[rollup] Done.");
    return;
  }

  // Fetch product classification from LLM features
  const prProducts = await fetchChunked<{
    pr_id: string;
    primary_product: string | null;
    secondary_products: string[];
  }>(
    supabase, "pr_llm_features", "pr_id", prScorePrIds,
    "pr_id, primary_product, secondary_products",
  );

  const prAuthorMap = new Map(prScores.map((s) => [String(s.pr_id), s.author_login]));
  const prMergedAt  = new Map(prScores.map((s) => [String(s.pr_id), s.merged_at]));

  // Accumulate per (author, product)
  type AreaKey = string; // `${author}|${product}`
  const areaMap = new Map<
    AreaKey,
    { author_login: string; area: string; prIds: Set<string>; latestMerged: string }
  >();

  const addProduct = (prId: string, product: string) => {
    const author = prAuthorMap.get(prId);
    if (!author || !product) return;
    const key = `${author}|${product}`;
    if (!areaMap.has(key)) {
      areaMap.set(key, { author_login: author, area: product, prIds: new Set(), latestMerged: "" });
    }
    const entry = areaMap.get(key)!;
    entry.prIds.add(prId);
    const mergedAt = prMergedAt.get(prId) ?? "";
    if (mergedAt > entry.latestMerged) entry.latestMerged = mergedAt;
  };

  for (const row of prProducts) {
    const prId = String(row.pr_id);
    if (row.primary_product) addProduct(prId, row.primary_product);
    for (const p of row.secondary_products ?? []) addProduct(prId, p);
  }

  const areaRows = [...areaMap.values()].map((e) => ({
    author_login:    e.author_login,
    area:            e.area,
    n_prs:           e.prIds.size,
    n_files_touched: e.prIds.size, // repurposed: same as n_prs for product-based areas
    last_touched_at: e.latestMerged || null,
  }));

  await upsertBatch(supabase, "engineer_areas", areaRows, "author_login,area");
  console.log(`[rollup] Upserted ${areaRows.length} rows into engineer_areas`);

  console.log("[rollup] Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
