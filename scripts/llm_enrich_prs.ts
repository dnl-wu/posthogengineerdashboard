/**
 * llm_enrich_prs.ts
 * ─────────────────
 * LLM enrichment for merged PRs using Gemini.
 * No diffs, no comment text — compact context packet only.
 *
 * Pipeline position:
 *   build_features.ts  →  llm_enrich_prs.ts  →  score-prs.ts
 *
 * Tables read:    prs, pr_features, pr_changed_files, pr_llm_features (existing hashes)
 * Tables written: pr_llm_features, prs.enriched_at (stamped on success)
 *
 * Run via:  npm run llm_enrich
 *
 * Required env vars:
 *   GEMINI_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 * Optional:
 *   GEMINI_MODEL              default "gemini-2.0-flash"
 *   GEMINI_MAX_CONCURRENT     default 5
 *   INGEST_BACKFILL_DAYS      default 120
 */

import "dotenv/config";
import { createHash } from "crypto";
import { createSupabaseServer } from "../lib/supabase-server";

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Semver. Bump this string whenever SYSTEM_PROMPT, MODEL_NAME default, or the
 * response schema changes — all existing rows with a different prompt_version
 * will be re-enriched on the next run.
 */
const PROMPT_VERSION = "1.0.1";

const MODEL_NAME        = process.env.GEMINI_MODEL            ?? "gemini-2.5-flash";
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY          ?? "";
const MAX_CONCURRENT    = parseInt(process.env.GEMINI_MAX_CONCURRENT ?? "5",   10);
const WINDOW_DAYS       = parseInt(process.env.INGEST_BACKFILL_DAYS  ?? "120", 10);

const READ_BATCH        = 50;   // PRs fetched per Supabase page
const UPSERT_BATCH      = 25;   // rows per pr_llm_features upsert call
const BODY_EXCERPT_LEN  = 1200; // chars of PR body included in prompt
const MAX_FILES         = 30;   // file paths included in prompt

// ─── PostHog product taxonomy ─────────────────────────────────────────────────

const PRODUCT_SLUGS = [
  "analytics",         // Product Analytics — events, insights, funnels, trends
  "session_replay",    // Session Replay — recordings, heatmaps
  "feature_flags",     // Feature Flags
  "experiments",       // A/B Testing / Experiments
  "data_pipelines",    // Data Pipelines — ingestion, transformations, apps
  "cdp",               // CDP / Data Warehouse
  "surveys",           // Surveys
  "error_tracking",    // Error Tracking
  "web_analytics",     // Web Analytics
  "llm_observability", // LLM Observability
  "billing",           // Billing & Subscriptions
  "auth",              // Auth, SSO, Permissions
  "infra",             // Infrastructure, CI, Deployment
  "platform",          // Core Platform, API, Settings (catch-all)
] as const;

type ProductSlug = (typeof PRODUCT_SLUGS)[number];

/** Products that form the critical path (billing / auth / core ingestion). */
const CRITICAL_PATH_PRODUCTS = new Set<string>(["billing", "auth", "data_pipelines"]);

// ─── Exact Gemini prompt template ─────────────────────────────────────────────
//
// SYSTEM_PROMPT is embedded as `systemInstruction` on every generateContent call.
// PROMPT_VERSION MUST be bumped whenever this string changes.
//
// The user turn is built by buildUserTurn() from a normalised InputPacket.
//
export const SYSTEM_PROMPT =
`You are a senior PostHog engineer classifying a pull request for an engineering velocity dashboard.
Respond with ONLY a valid JSON object — no markdown fences, no prose, no trailing commas.

Allowed slugs for primary_product and secondary_products:
${PRODUCT_SLUGS.join(" | ")}

Return exactly this JSON shape:
{
  "primary_product":    <string — one slug from the list above; the main product area affected>,
  "secondary_products": <array of 0–3 slugs from the list; other products meaningfully touched; exclude primary>,
  "type":               <"feat" | "fix" | "chore" | "ci">,
  "user_facing":        <boolean — true if a product end-user would notice this change>,
  "impact_score_0_10":  <number 0.0–10.0, one decimal — engineering impact depth; 1=trivial, 5=meaningful, 10=major cross-system overhaul>,
  "confidence_0_1":     <number 0.00–1.00 — your confidence in this classification>,
  "impact_drivers":     <array of 1–4 short strings — key reasons this PR has the given impact score>,
  "one_liner":          <string ≤ 120 chars — terse, present-tense description of what the PR does>
}`;

/**
 * Builds the Gemini user turn from a normalised InputPacket.
 * The packet fields and their order here MUST match buildInputPacket().
 */
function buildUserTurn(ctx: InputPacket): string {
  const fileLines = ctx.files.length > 0
    ? ctx.files.map((f) => `  ${f}`).join("\n")
    : "  (no file data available)";
  const truncNote = ctx.files_truncated > 0
    ? `\n  … and ${ctx.files_truncated} more file(s) not shown`
    : "";
  return (
    `PR Title: ${ctx.title}\n` +
    `Labels: ${ctx.labels.length > 0 ? ctx.labels.join(", ") : "(none)"}\n` +
    `Base branch: ${ctx.base_branch}\n` +
    `Body (first ${BODY_EXCERPT_LEN} chars):\n${ctx.body || "(no description provided)"}\n\n` +
    `Changed files (top ${ctx.files.length} of ${ctx.files.length + ctx.files_truncated} shown):\n` +
    `${fileLines}${truncNote}\n\n` +
    `Touch hints — frontend:${ctx.touch_frontend} backend:${ctx.touch_backend} infra:${ctx.touch_infra} tests:${ctx.touch_tests}\n` +
    `Has test files: ${ctx.has_tests}\n` +
    `Size bucket: ${ctx.size_bucket}  (XS<10 lines · S<100 · M<500 · L<1000 · XL≥1000 total lines changed)`
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Normalised input packet — hashed to form the cache key. */
interface InputPacket {
  title: string;
  body: string;
  labels: string[];
  base_branch: string;
  files: string[];          // top MAX_FILES sorted file paths
  files_truncated: number;
  touch_frontend: boolean;
  touch_backend: boolean;
  touch_infra: boolean;
  touch_tests: boolean;
  has_tests: boolean;
  size_bucket: string;
}

type GeminiType = "feat" | "fix" | "chore" | "ci";

/** Validated Gemini JSON output. */
interface GeminiOutput {
  primary_product: string;
  secondary_products: string[];
  type: GeminiType;
  user_facing: boolean;
  impact_score_0_10: number;
  confidence_0_1: number;
  impact_drivers: string[];
  one_liner: string;
}

type PrCategory =
  | "feature" | "bug_fix" | "refactor" | "test"
  | "docs" | "infra" | "perf" | "security";

/** Row shape for pr_llm_features (covers 001 columns + 003 extension). */
interface PrLlmFeatureRow {
  pr_id: number;
  // ── auditability (001) ──
  model_name: string;
  prompt_version: string;
  input_hash: string;
  raw_response: unknown;
  // ── scored dimensions (001) ──
  complexity_score: number;
  risk_score: number;
  cross_cutting_score: number;
  user_facing_score: number;
  tech_debt_delta: number;
  // ── classification (001) ──
  pr_category: PrCategory;
  is_breaking_change: boolean;
  touches_critical_path: boolean;
  gemini_rationale: string | null;
  // ── new Gemini fields (003) ──
  primary_product: string;
  secondary_products: string[];
  impact_signal: number;
  confidence: number;
  impact_drivers: string[];
  one_liner: string | null;
  fallback_used: boolean;
  enriched_at: string;
}

interface PrRow {
  id: number;
  title: string;
  body: string | null;
  label_names: string[];
}

interface PrFeatureRow {
  pr_id: number;
  n_subsystems_touched: number;
  touches_frontend: boolean;
  touches_backend: boolean;
  touches_infra: boolean;
  touches_tests: boolean;
  has_tests: boolean;
  size_bucket: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Builds a deterministic, normalised InputPacket from raw DB rows.
 * All normalisation (trim, sort, truncate) lives here so the hash is stable.
 */
function buildInputPacket(
  pr: PrRow,
  pf: PrFeatureRow,
  filenames: string[],
): InputPacket {
  const title  = pr.title.trim();
  const body   = (pr.body ?? "").replace(/\r\n/g, "\n").trim().slice(0, BODY_EXCERPT_LEN);
  const labels = Array.from(new Set((pr.label_names ?? []).map((l) => l.toLowerCase()))).sort();

  const allFilesSorted = [...filenames].sort();
  const files           = allFilesSorted.slice(0, MAX_FILES);
  const files_truncated = Math.max(0, allFilesSorted.length - MAX_FILES);

  return {
    title,
    body,
    labels,
    base_branch:    "main",  // base_ref not stored in prs; PostHog merges to main
    files,
    files_truncated,
    touch_frontend: pf.touches_frontend  ?? false,
    touch_backend:  pf.touches_backend   ?? false,
    touch_infra:    pf.touches_infra     ?? false,
    touch_tests:    pf.touches_tests     ?? false,
    has_tests:      pf.has_tests         ?? false,
    size_bucket:    pf.size_bucket       ?? "M",
  };
}

function hashInputPacket(pkt: InputPacket): string {
  // JSON.stringify of a plain object with interface-order keys is stable
  // across runs because V8 iterates object properties in insertion order.
  return sha256(JSON.stringify(pkt));
}

// ─── Deterministic Gemini-output → pr_llm_features mapping ───────────────────

/**
 * Maps Gemini's `type` to the canonical pr_category enum.
 * Uses pr_features touch hints for secondary disambiguation of "chore".
 */
function mapCategory(
  type: GeminiType,
  product: string,
  pf: Pick<PrFeatureRow, "touches_infra" | "has_tests">,
): PrCategory {
  switch (type) {
    case "feat": return "feature";
    case "fix":  return "bug_fix";
    case "ci":   return "infra";
    case "chore":
      if (pf.has_tests && !pf.touches_infra) return "test";
      if (pf.touches_infra || product === "infra" || product === "platform") return "infra";
      return "refactor";
  }
}

const SIZE_BUCKET_SCORE: Record<string, number> = {
  XS: 5, S: 20, M: 45, L: 70, XL: 90,
};

const TECH_DEBT_BY_TYPE: Record<GeminiType, number> = {
  feat:  -5,
  fix:    5,
  chore: 15,
  ci:    10,
};

const BREAKING_RE =
  /breaking[- ]change|backward[- ]incompat|removes?\s+(api|endpoint|support|param)/i;

/**
 * Deterministically maps a validated GeminiOutput + pr_features context
 * into the full PrLlmFeatureRow to be upserted.
 */
function mapToRow(
  pr_id: number,
  input_hash: string,
  out: GeminiOutput,
  pf: PrFeatureRow,
  fallback_used: boolean,
): PrLlmFeatureRow {
  const impactBase = clamp(Math.round(out.impact_score_0_10 * 10), 0, 100);
  const sizeScore  = SIZE_BUCKET_SCORE[pf.size_bucket ?? "M"] ?? 45;

  // complexity: 70% driven by Gemini impact, 30% by size bucket
  const complexity_score = clamp(Math.round(impactBase * 0.7 + sizeScore * 0.3), 0, 100);

  // risk: direct from impact signal
  const risk_score = clamp(impactBase, 0, 100);

  // cross_cutting: blend of impact depth and subsystem breadth
  const subsystemContrib = clamp((pf.n_subsystems_touched ?? 1) * 20, 0, 100);
  const cross_cutting_score = clamp(
    Math.round(impactBase * 0.5 + subsystemContrib * 0.5),
    0, 100,
  );

  // user_facing: full impact score if visible to users; steep discount otherwise
  const user_facing_score = out.user_facing
    ? clamp(impactBase, 0, 100)
    : clamp(Math.round(impactBase * 0.25), 0, 100);

  // tech_debt_delta: type-based baseline, scaled by model confidence
  const tech_debt_delta = clamp(
    Math.round((TECH_DEBT_BY_TYPE[out.type] ?? 0) * out.confidence_0_1),
    -50, 50,
  );

  const pr_category = mapCategory(out.type, out.primary_product, pf);

  const is_breaking_change =
    out.impact_drivers.some((d) => BREAKING_RE.test(d)) ||
    BREAKING_RE.test(out.one_liner);

  const touches_critical_path =
    CRITICAL_PATH_PRODUCTS.has(out.primary_product) ||
    out.secondary_products.some((p) => CRITICAL_PATH_PRODUCTS.has(p));

  return {
    pr_id,
    model_name:           MODEL_NAME,
    prompt_version:       PROMPT_VERSION,
    input_hash,
    raw_response:         out,
    complexity_score,
    risk_score,
    cross_cutting_score,
    user_facing_score,
    tech_debt_delta,
    pr_category,
    is_breaking_change,
    touches_critical_path,
    gemini_rationale:     out.one_liner.slice(0, 200),
    primary_product:      out.primary_product,
    secondary_products:   out.secondary_products,
    impact_signal:        Math.round(out.impact_score_0_10 * 10) / 10,
    confidence:           Math.round(out.confidence_0_1 * 100) / 100,
    impact_drivers:       out.impact_drivers,
    one_liner:            out.one_liner.slice(0, 200),
    fallback_used,
    enriched_at:          new Date().toISOString(),
  };
}

/**
 * Safe neutral row used when the Gemini call fails entirely.
 * fallback_used=true lets score-prs.ts apply a score floor instead of skipping.
 */
function makeFallbackRow(
  pr_id: number,
  input_hash: string,
  pf: PrFeatureRow,
): PrLlmFeatureRow {
  const sizeScore       = SIZE_BUCKET_SCORE[pf.size_bucket ?? "M"] ?? 45;
  const subsystemContrib = clamp((pf.n_subsystems_touched ?? 1) * 20, 0, 100);
  return {
    pr_id,
    model_name:           MODEL_NAME,
    prompt_version:       PROMPT_VERSION,
    input_hash,
    raw_response:         null,
    complexity_score:     sizeScore,
    risk_score:           30,
    cross_cutting_score:  Math.round(sizeScore * 0.4 + subsystemContrib * 0.6),
    user_facing_score:    25,
    tech_debt_delta:      0,
    pr_category:          "feature",
    is_breaking_change:   false,
    touches_critical_path: false,
    gemini_rationale:     null,
    primary_product:      "platform",
    secondary_products:   [],
    impact_signal:        3.0,
    confidence:           0.0,
    impact_drivers:       [],
    one_liner:            null,
    fallback_used:        true,
    enriched_at:          new Date().toISOString(),
  };
}

// ─── Gemini API ────────────────────────────────────────────────────────────────

interface GeminiApiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message: string };
}

class GeminiApiError   extends Error { constructor(m: string) { super(m); this.name = "GeminiApiError"; } }
class GeminiParseError extends Error { constructor(m: string) { super(m); this.name = "GeminiParseError"; } }

const VALID_TYPES = new Set<string>(["feat", "fix", "chore", "ci"]);
const PRODUCT_SLUG_SET = new Set<string>(PRODUCT_SLUGS);

/** Coerces and validates raw model output; fills safe defaults for bad fields. */
function validateOutput(raw: unknown): GeminiOutput {
  if (typeof raw !== "object" || raw === null) {
    throw new GeminiParseError("response is not a JSON object");
  }
  const o = raw as Record<string, unknown>;

  const primary_product =
    typeof o.primary_product === "string" && PRODUCT_SLUG_SET.has(o.primary_product)
      ? o.primary_product
      : "platform";

  const secondary_products = Array.isArray(o.secondary_products)
    ? (o.secondary_products as unknown[])
        .filter((p): p is string => typeof p === "string" && PRODUCT_SLUG_SET.has(p))
        .filter((p) => p !== primary_product)
        .slice(0, 3)
    : [];

  const type: GeminiType = VALID_TYPES.has(o.type as string)
    ? (o.type as GeminiType)
    : "feat";

  const user_facing = typeof o.user_facing === "boolean" ? o.user_facing : false;

  const impact_score_0_10 = clamp(
    typeof o.impact_score_0_10 === "number" ? o.impact_score_0_10 : 5.0,
    0, 10,
  );

  const confidence_0_1 = clamp(
    typeof o.confidence_0_1 === "number" ? o.confidence_0_1 : 0.5,
    0, 1,
  );

  const impact_drivers = Array.isArray(o.impact_drivers)
    ? (o.impact_drivers as unknown[])
        .filter((d): d is string => typeof d === "string")
        .slice(0, 4)
    : [];

  const one_liner =
    typeof o.one_liner === "string" ? o.one_liner.slice(0, 200) : "";

  return { primary_product, secondary_products, type, user_facing,
           impact_score_0_10, confidence_0_1, impact_drivers, one_liner };
}

/** Single Gemini generateContent call. Throws on HTTP error or invalid JSON. */
async function callGeminiOnce(userTurn: string): Promise<GeminiOutput> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

  const reqBody = {
    contents: [{ role: "user", parts: [{ text: userTurn }] }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1,
      maxOutputTokens: 512,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "(no body)");
    throw new GeminiApiError(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = (await res.json()) as GeminiApiResponse;
  if (data.error) throw new GeminiApiError(data.error.message);

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new GeminiParseError(`Model returned invalid JSON: ${rawText.slice(0, 300)}`);
  }

  return validateOutput(parsed);
}

/**
 * Calls Gemini with exactly one retry on GeminiParseError (invalid JSON).
 * On any API-level failure, sets fallback_used=true instead of throwing.
 */
async function callGemini(
  userTurn: string,
): Promise<{ output: GeminiOutput | null; fallback_used: boolean }> {
  try {
    return { output: await callGeminiOnce(userTurn), fallback_used: false };
  } catch (err) {
    if (err instanceof GeminiParseError) {
      // Retry once with an explicit reminder appended to the user turn
      const retryTurn =
        userTurn +
        "\n\nIMPORTANT: Your previous response was not valid JSON. " +
        "Respond with ONLY the JSON object described above — no markdown fences, no extra text.";
      try {
        return { output: await callGeminiOnce(retryTurn), fallback_used: false };
      } catch {
        // fall through to fallback
      }
    }
    // GeminiApiError or second parse failure → safe fallback
    console.warn(
      `  [warn] Gemini failed (fallback_used=true): ${(err as Error).message?.slice(0, 140)}`,
    );
    return { output: null, fallback_used: true };
  }
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const iter = items[Symbol.iterator]();
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (let step = iter.next(); !step.done; step = iter.next()) {
        await fn(step.value);
      }
    },
  );
  await Promise.all(workers);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");

  const supabase = createSupabaseServer();

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
  const windowISO = windowStart.toISOString();

  console.log(
    `llm_enrich_prs: window >= ${windowISO.slice(0, 10)}  ` +
    `model=${MODEL_NAME}  prompt_version=${PROMPT_VERSION}  concurrency=${MAX_CONCURRENT}`,
  );

  let totalEnriched = 0;
  let totalSkipped  = 0;
  let totalFallback = 0;
  let offset = 0;

  while (true) {
    // ── 1. Read a page of PRs in the window ──────────────────────────────
    const { data: prs, error: prsErr } = await supabase
      .from("prs")
      .select("id, title, body, label_names")
      .gte("merged_at", windowISO)
      .order("id", { ascending: true })
      .range(offset, offset + READ_BATCH - 1);

    if (prsErr) throw new Error(`prs fetch: ${prsErr.message}`);
    if (!prs || prs.length === 0) break;

    const prIds = (prs as PrRow[]).map((p) => p.id);

    // ── 2. Batch-read supporting data in parallel ─────────────────────────
    const [pfRes, filesRes, existRes] = await Promise.all([
      supabase
        .from("pr_features")
        .select(
          "pr_id, n_subsystems_touched, " +
          "touches_frontend, touches_backend, touches_infra, touches_tests, " +
          "has_tests, size_bucket",
        )
        .in("pr_id", prIds),

      supabase
        .from("pr_changed_files")
        .select("pr_id, filename")
        .in("pr_id", prIds),

      supabase
        .from("pr_llm_features")
        .select("pr_id, input_hash, prompt_version")
        .in("pr_id", prIds),
    ]);

    if (pfRes.error)    throw new Error(`pr_features fetch: ${pfRes.error.message}`);
    if (filesRes.error) throw new Error(`pr_changed_files fetch: ${filesRes.error.message}`);
    if (existRes.error) throw new Error(`pr_llm_features fetch (existing): ${existRes.error.message}`);

    // Index supporting rows by pr_id
    const pfByPr = new Map<number, PrFeatureRow>();
    for (const r of (pfRes.data ?? []) as unknown as PrFeatureRow[]) pfByPr.set(r.pr_id, r);

    const filesByPr = new Map<number, string[]>();
    for (const r of (filesRes.data ?? []) as { pr_id: number; filename: string }[]) {
      const arr = filesByPr.get(r.pr_id) ?? [];
      arr.push(r.filename);
      filesByPr.set(r.pr_id, arr);
    }

    const existByPr = new Map<number, { input_hash: string; prompt_version: string }>();
    for (const r of (existRes.data ?? []) as {
      pr_id: number; input_hash: string; prompt_version: string;
    }[]) {
      existByPr.set(r.pr_id, r);
    }

    // ── 3. Determine which PRs need (re)enrichment ────────────────────────
    type WorkItem = {
      pr: PrRow;
      pf: PrFeatureRow;
      pkt: InputPacket;
      input_hash: string;
    };
    const todo: WorkItem[] = [];

    for (const pr of prs as PrRow[]) {
      const pf = pfByPr.get(pr.id);
      if (!pf) continue; // build_features.ts must run first

      const pkt        = buildInputPacket(pr, pf, filesByPr.get(pr.id) ?? []);
      const input_hash = hashInputPacket(pkt);
      const existing   = existByPr.get(pr.id);

      if (
        existing &&
        existing.prompt_version === PROMPT_VERSION &&
        existing.input_hash     === input_hash
      ) {
        totalSkipped++;
        continue;
      }
      todo.push({ pr, pf, pkt, input_hash });
    }

    if (todo.length === 0) {
      offset += prs.length;
      if (prs.length < READ_BATCH) break;
      continue;
    }

    // ── 4. Call Gemini concurrently ───────────────────────────────────────
    const outputRows: PrLlmFeatureRow[] = [];

    await runConcurrent(todo, MAX_CONCURRENT, async ({ pr, pf, pkt, input_hash }) => {
      const userTurn = buildUserTurn(pkt);
      const { output, fallback_used } = await callGemini(userTurn);

      const row =
        output !== null
          ? mapToRow(pr.id, input_hash, output, pf, false)
          : makeFallbackRow(pr.id, input_hash, pf);

      if (fallback_used) totalFallback++;
      outputRows.push(row);
    });

    // ── 5. Upsert pr_llm_features ─────────────────────────────────────────
    for (let i = 0; i < outputRows.length; i += UPSERT_BATCH) {
      const chunk = outputRows.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from("pr_llm_features")
        .upsert(chunk, { onConflict: "pr_id" });
      if (error) throw new Error(`pr_llm_features upsert: ${error.message}`);
    }

    // ── 6. Stamp prs.enriched_at (both pr_features and pr_llm_features now exist) ──
    const enrichedIds = outputRows.map((r) => r.pr_id);
    const { error: stampErr } = await supabase
      .from("prs")
      .update({ enriched_at: new Date().toISOString() })
      .in("id", enrichedIds);
    if (stampErr) throw new Error(`prs enriched_at stamp: ${stampErr.message}`);

    totalEnriched += outputRows.length;
    console.log(
      `  … enriched=${outputRows.length} (fallback=${totalFallback}) ` +
      `| running total: enriched=${totalEnriched} skipped=${totalSkipped}`,
    );

    offset += prs.length;
    if (prs.length < READ_BATCH) break;
  }

  console.log(
    `llm_enrich_prs: done — enriched=${totalEnriched}  skipped=${totalSkipped}  fallback=${totalFallback}`,
  );
}

main().catch((err: unknown) => {
  console.error("[llm_enrich_prs] fatal:", err);
  process.exit(1);
});
