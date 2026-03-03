/**
 * score-prs.ts
 * ────────────
 * Deterministic scoring: reads `pr_features` + `pr_llm_features` and writes
 * `pr_scores` using the formulas in docs/plan.md §4.
 * No LLM calls — pure arithmetic.
 *
 * Tables read:    pr_features, pr_llm_features  (schema: docs/schema.md §4–5)
 * Tables written: pr_scores  (schema: docs/schema.md §7)
 *
 * Processes the last 90 days of merged, enriched PRs.
 * Uses upsert so the script is safe to re-run.
 *
 * Formulas (plan.md §4):
 *
 *   impact_raw   = (0.30×complexity + 0.25×risk + 0.20×cross_cutting
 *                 + 0.15×user_facing + 0.10×|tech_debt_delta|×2) / 100
 *
 *   delivery_raw = clamp(1 − cycle_time_hours/336, 0, 1)
 *                × (1 − churn_ratio × 0.5)
 *                × (is_breaking_change ? 0.90 : 1.00)
 *
 *   breadth_raw  = min(1, n_subsystems_touched / 5)
 *                × (cross_cutting_score / 100)
 *
 *   category_weight: security=1.20 perf=1.10 bug_fix=1.05 feature=1.00
 *                    infra=0.95 refactor=0.90 test=0.70 docs=0.60
 *
 *   raw_pr_score = category_weight
 *                × (0.55×impact_raw + 0.25×delivery_raw + 0.20×breadth_raw)
 *
 * Env vars required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import "dotenv/config";
import { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServer } from "../lib/supabase-server";

const WINDOW_DAYS = 90;

const CATEGORY_WEIGHT: Record<string, number> = {
  security: 1.20,
  perf:     1.10,
  bug_fix:  1.05,
  feature:  1.00,
  infra:    0.95,
  refactor: 0.90,
  test:     0.70,
  docs:     0.60,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Returns the ISO-8601 Monday of the week containing `date`, as 'YYYY-MM-DD'. */
function mondayOf(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = d.getUTCDay() || 7; // treat Sunday (0) as 7
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
    `[score-prs] window: ${windowStart.toISOString().slice(0, 10)} → today`,
  );

  // Fetch merged, enriched PRs in window
  const { data: prsRaw, error: prsErr } = await supabase
    .from("prs")
    .select("id, author_login, merged_at")
    .gte("merged_at", windowStart.toISOString())
    .not("enriched_at", "is", null);

  if (prsErr) throw new Error(`prs fetch: ${prsErr.message}`);
  const prs = (prsRaw ?? []) as { id: string; author_login: string; merged_at: string }[];

  if (prs.length === 0) {
    console.log("[score-prs] No enriched PRs in window.");
    return;
  }
  const prIds = prs.map((p) => String(p.id));
  console.log(`[score-prs] ${prs.length} PRs`);

  // Fetch structural features and LLM features
  const [feats, llms] = await Promise.all([
    fetchChunked<{
      pr_id: string;
      n_subsystems_touched: number;
      cycle_time_hours: number | null;
      churn_ratio: number | null;
    }>(supabase, "pr_features", "pr_id", prIds,
      "pr_id, n_subsystems_touched, cycle_time_hours, churn_ratio"),

    fetchChunked<{
      pr_id: string;
      complexity_score: number;
      risk_score: number;
      cross_cutting_score: number;
      user_facing_score: number;
      tech_debt_delta: number;
      pr_category: string;
      is_breaking_change: boolean;
    }>(supabase, "pr_llm_features", "pr_id", prIds,
      "pr_id, complexity_score, risk_score, cross_cutting_score, user_facing_score, tech_debt_delta, pr_category, is_breaking_change"),
  ]);

  const featMap = new Map(feats.map((f) => [String(f.pr_id), f]));
  const llmMap  = new Map(llms.map((f)  => [String(f.pr_id), f]));

  // Compute scores
  const rows: object[] = [];

  for (const pr of prs) {
    const id   = String(pr.id);
    const feat = featMap.get(id);
    const llm  = llmMap.get(id);
    if (!feat || !llm) continue; // missing features — skip

    // impact
    const impact_raw = clamp(
      (0.30 * llm.complexity_score
       + 0.25 * llm.risk_score
       + 0.20 * llm.cross_cutting_score
       + 0.15 * llm.user_facing_score
       + 0.10 * Math.abs(llm.tech_debt_delta) * 2) / 100,
      0, 1,
    );

    // delivery
    const cycle   = feat.cycle_time_hours ?? 0;
    const churn   = feat.churn_ratio      ?? 0;
    const delivery_raw = clamp(
      clamp(1 - cycle / 336, 0, 1)
      * (1 - churn * 0.5)
      * (llm.is_breaking_change ? 0.90 : 1.00),
      0, 1,
    );

    // breadth
    const breadth_raw = clamp(
      Math.min(1, feat.n_subsystems_touched / 5)
      * (llm.cross_cutting_score / 100),
      0, 1,
    );

    const category_weight = CATEGORY_WEIGHT[llm.pr_category] ?? 1.00;

    const raw_pr_score = clamp(
      category_weight
      * (0.55 * impact_raw + 0.25 * delivery_raw + 0.20 * breadth_raw),
      0, 1.2, // category_weight can push above 1; cap at 1.2 (max weight)
    );

    rows.push({
      pr_id:          id,
      author_login:   pr.author_login,
      merged_at:      pr.merged_at,
      impact_score:   parseFloat(impact_raw.toFixed(4)),
      delivery_score: parseFloat(delivery_raw.toFixed(4)),
      breadth_score:  parseFloat(breadth_raw.toFixed(4)),
      category_weight: parseFloat(category_weight.toFixed(3)),
      raw_pr_score:   parseFloat(raw_pr_score.toFixed(4)),
      week_start:     mondayOf(new Date(pr.merged_at)),
      scored_at:      new Date().toISOString(),
    });
  }

  console.log(`[score-prs] Computed scores for ${rows.length} PRs`);

  // Upsert in batches
  const BATCH = 100;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await supabase
      .from("pr_scores")
      .upsert(rows.slice(i, i + BATCH), { onConflict: "pr_id" });
    if (error) throw new Error(`pr_scores upsert: ${error.message}`);
    upserted += rows.slice(i, i + BATCH).length;
  }

  console.log(`[score-prs] Upserted ${upserted} rows into pr_scores. Done.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
