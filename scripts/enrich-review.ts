/**
 * enrich-review.ts
 * ─────────────────
 * Reads recent PR reviews, calls Gemini for review-quality signals, and writes
 * structured results to `review_llm_features`. Stamps `pr_reviews.enriched_at`
 * for all successfully processed reviews.
 *
 * Tables read:
 *   - pr_reviews
 *   - prs (for PR title / author / created_at used in the prompt + response time)
 *
 * Tables written:
 *   - review_llm_features
 *   - pr_reviews (enriched_at)
 *
 * Safe to re-run: existing rows are skipped when `prompt_version` and
 * `input_hash` match the current prompt; otherwise they are re-enriched.
 *
 * Env vars required:
 *   GEMINI_API_KEY
 *   GEMINI_MODEL            default "gemini-2.5-flash"
 *   GEMINI_MAX_CONCURRENT   default 5
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   INGEST_BACKFILL_DAYS    default 120 (window for submitted_at)
 */

import "dotenv/config";
import { createHash } from "crypto";
import { createSupabaseServer } from "../lib/supabase-server";

// ─── Config ────────────────────────────────────────────────────────────────────

/**
 * Bump when the review SYSTEM_PROMPT or response schema changes.
 * Existing rows with a different prompt_version will be re-enriched.
 */
const PROMPT_VERSION = "1.0.0";

const MODEL_NAME        = process.env.GEMINI_MODEL            ?? "gemini-2.5-flash";
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY          ?? "";
const MAX_CONCURRENT    = parseInt(process.env.GEMINI_MAX_CONCURRENT ?? "5",   10);
const WINDOW_DAYS       = parseInt(process.env.INGEST_BACKFILL_DAYS  ?? "120", 10);

const READ_BATCH        = 100; // reviews per Supabase page
const UPSERT_BATCH      = 50;  // rows per review_llm_features upsert call

// ─── Review prompt ─────────────────────────────────────────────────────────────

/**
 * Review-quality system prompt.
 *
 * The model receives:
 *   - PR metadata (title, author, number)
 *   - review state (APPROVED / CHANGES_REQUESTED / COMMENTED)
 *   - top-level review body
 *   - up to 10 inline comments (path + body)
 *   - aggregate counts
 *
 * It must return ONLY a JSON object with the fields below.
 */
const SYSTEM_PROMPT =
`You are a senior engineer evaluating the quality of a code review for an engineering velocity dashboard.
Respond with ONLY a valid JSON object — no markdown, no prose, no trailing commas.

Return exactly this JSON shape:
{
  "depth_score":         <integer 0–100 — how deeply the review engages with the change>,
  "actionability_score": <integer 0–100 — how clear and actionable the feedback is>,
  "correctness_focus":   <integer 0–100 — how much the review focuses on correctness and bugs>,
  "architecture_focus":  <integer 0–100 — attention to architecture, design, and long-term quality>,
  "tone_score":          <integer 0–100 — professionalism and constructiveness of tone>,
  "rationale":           <string ≤ 200 chars — one sentence explaining the scores>
}

Guidelines:
- Depth should reward concrete, specific observations over general praise.
- Actionability should reward suggestions that include clear next steps or examples.
- Correctness and architecture should reflect how much the review addresses bugs and design.
- Tone should reflect how respectful and supportive the feedback is, even when firm.
- Use the full 0–100 range; 50 is an average review.`;

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ReviewRow {
  id: number;
  pr_id: number;
  reviewer_login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | string;
  submitted_at: string;
  body: string | null;
  n_comments: number;
  n_inline_comments: number;
  comments_json: Array<{ path: string; body: string; created_at: string }>;
}

interface PrMetaRow {
  id: number;
  number: number;
  author_login: string;
  title: string;
  created_at: string;
}

interface InputPacket {
  pr_number: number;
  pr_title: string;
  pr_author: string;
  reviewer_login: string;
  state: string;
  n_comments: number;
  n_inline_comments: number;
  top_level_body: string;
  inline_comments: string[];
}

interface ReviewOutput {
  depth_score: number;
  actionability_score: number;
  correctness_focus: number;
  architecture_focus: number;
  tone_score: number;
  rationale: string;
}

interface ReviewLlmFeatureRow {
  review_id: number;
  pr_id: number;
  reviewer_login: string;
  model_name: string;
  prompt_version: string;
  input_hash: string;
  raw_response: unknown;
  depth_score: number;
  actionability_score: number;
  correctness_focus: number;
  architecture_focus: number;
  tone_score: number;
  gemini_rationale: string | null;
  response_time_hours: number | null;
  enriched_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildInputPacket(
  review: ReviewRow,
  pr: PrMetaRow,
): InputPacket {
  const topBody = (review.body ?? "").replace(/\r\n/g, "\n").trim();
  const inline = (review.comments_json ?? [])
    .slice(0, 10)
    .map((c) => `[${c.path}] ${c.body.replace(/\s+/g, " ").trim()}`)
    .filter((s) => s.length > 0);

  return {
    pr_number:        pr.number,
    pr_title:         pr.title.slice(0, 300),
    pr_author:        pr.author_login,
    reviewer_login:   review.reviewer_login,
    state:            review.state,
    n_comments:       review.n_comments ?? 0,
    n_inline_comments: review.n_inline_comments ?? 0,
    top_level_body:   topBody.slice(0, 4000),
    inline_comments:  inline,
  };
}

function hashInputPacket(pkt: InputPacket): string {
  return sha256(JSON.stringify(pkt));
}

function hoursBetween(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end   = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const diffMs = end - start;
  if (!Number.isFinite(diffMs)) return null;
  const hours = diffMs / 3_600_000;
  return hours < 0 ? null : Math.round(hours * 100) / 100;
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

function validateOutput(raw: unknown): ReviewOutput {
  if (typeof raw !== "object" || raw === null) {
    throw new GeminiParseError("response is not a JSON object");
  }
  const o = raw as Record<string, unknown>;

  const depth = clamp(
    typeof o.depth_score === "number" ? Math.round(o.depth_score) : 50,
    0, 100,
  );
  const action = clamp(
    typeof o.actionability_score === "number" ? Math.round(o.actionability_score) : 50,
    0, 100,
  );
  const correctness = clamp(
    typeof o.correctness_focus === "number" ? Math.round(o.correctness_focus) : 50,
    0, 100,
  );
  const arch = clamp(
    typeof o.architecture_focus === "number" ? Math.round(o.architecture_focus) : 50,
    0, 100,
  );
  const tone = clamp(
    typeof o.tone_score === "number" ? Math.round(o.tone_score) : 70,
    0, 100,
  );

  const rationale =
    typeof o.rationale === "string"
      ? o.rationale.slice(0, 200)
      : "";

  return {
    depth_score:         depth,
    actionability_score: action,
    correctness_focus:   correctness,
    architecture_focus:  arch,
    tone_score:          tone,
    rationale,
  };
}

function extractJsonObject(rawText: string): unknown {
  const text = rawText.trim();

  // Strip ```json ... ``` fences if present
  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    const withoutFence = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    const closingFence = withoutFence.lastIndexOf("```");
    const inner = closingFence === -1 ? withoutFence : withoutFence.slice(0, closingFence);
    const start = inner.indexOf("{");
    const end = inner.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(inner.slice(start, end + 1));
    }
    // fall through to generic extraction below
  }

  // Generic: grab the first {...} block in the text
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }

  // Last resort: try parsing the whole thing
  return JSON.parse(text);
}

async function callGeminiOnce(userTurn: string): Promise<ReviewOutput> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

  const reqBody = {
    contents: [{ role: "user", parts: [{ text: userTurn }] }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1,
      maxOutputTokens: 256,
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
  try {
    const parsed = extractJsonObject(rawText);
    return validateOutput(parsed);
  } catch {
    throw new GeminiParseError(`Model returned invalid JSON: ${rawText.slice(0, 300)}`);
  }
}

async function callGemini(
  userTurn: string,
): Promise<ReviewOutput | null> {
  try {
    return await callGeminiOnce(userTurn);
  } catch (err) {
    if (err instanceof GeminiParseError) {
      const retryTurn =
        userTurn +
        "\n\nIMPORTANT: Your previous response was not valid JSON. " +
        "Respond with ONLY the JSON object described above — no markdown fences, no extra text.";
      try {
        return await callGeminiOnce(retryTurn);
      } catch {
        // fall through to fallback
      }
    }
    console.warn(
      `[enrich-review] Gemini failed, using fallback: ${(err as Error).message?.slice(0, 140)}`,
    );
    return null;
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

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function buildUserTurn(pkt: InputPacket): string {
  const inline =
    pkt.inline_comments.length > 0
      ? pkt.inline_comments.map((c) => `- ${c}`).join("\n")
      : "(no inline comments)";

  return (
    `PR #${pkt.pr_number}: ${pkt.pr_title}\n` +
    `Author: ${pkt.pr_author}\n` +
    `Reviewer: ${pkt.reviewer_login}\n` +
    `State: ${pkt.state}\n` +
    `Counts: total_comments=${pkt.n_comments}, inline_comments=${pkt.n_inline_comments}\n\n` +
    `Top-level review body:\n` +
    (pkt.top_level_body || "(no top-level review body)") +
    "\n\nInline comments (path + excerpt, up to 10):\n" +
    inline
  );
}

function mapToRow(
  review: ReviewRow,
  pr: PrMetaRow,
  input_hash: string,
  out: ReviewOutput,
): ReviewLlmFeatureRow {
  const responseTime = hoursBetween(pr.created_at, review.submitted_at);
  return {
    review_id:          review.id,
    pr_id:              review.pr_id,
    reviewer_login:     review.reviewer_login,
    model_name:         MODEL_NAME,
    prompt_version:     PROMPT_VERSION,
    input_hash,
    raw_response:       out,
    depth_score:        out.depth_score,
    actionability_score: out.actionability_score,
    correctness_focus:  out.correctness_focus,
    architecture_focus: out.architecture_focus,
    tone_score:         out.tone_score,
    gemini_rationale:   out.rationale || null,
    response_time_hours: responseTime,
    enriched_at:        new Date().toISOString(),
  };
}

function makeFallbackRow(
  review: ReviewRow,
  pr: PrMetaRow,
  input_hash: string,
): ReviewLlmFeatureRow {
  const responseTime = hoursBetween(pr.created_at, review.submitted_at);
  return {
    review_id:          review.id,
    pr_id:              review.pr_id,
    reviewer_login:     review.reviewer_login,
    model_name:         MODEL_NAME,
    prompt_version:     PROMPT_VERSION,
    input_hash,
    raw_response:       null,
    depth_score:        50,
    actionability_score: 50,
    correctness_focus:  50,
    architecture_focus: 50,
    tone_score:         70,
    gemini_rationale:   null,
    response_time_hours: responseTime,
    enriched_at:        new Date().toISOString(),
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const supabase = createSupabaseServer();

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
  const windowISO = windowStart.toISOString();

  console.log(
    `enrich-review: window >= ${windowISO.slice(0, 10)}  ` +
    `model=${MODEL_NAME}  prompt_version=${PROMPT_VERSION}  concurrency=${MAX_CONCURRENT}`,
  );

  let totalEnriched = 0;
  let totalSkipped  = 0;
  let totalFallback = 0;
  let offset = 0;

  while (true) {
    // 1. Page through recent reviews in the window
    const { data: reviewsRaw, error: revErr } = await supabase
      .from("pr_reviews")
      .select("id, pr_id, reviewer_login, state, submitted_at, body, n_comments, n_inline_comments, comments_json")
      .gte("submitted_at", windowISO)
      .order("id", { ascending: true })
      .range(offset, offset + READ_BATCH - 1);

    if (revErr) throw new Error(`pr_reviews fetch: ${revErr.message}`);
    if (!reviewsRaw || reviewsRaw.length === 0) break;

    const reviews = reviewsRaw as unknown as ReviewRow[];
    const reviewIds = reviews.map((r) => r.id);
    const prIds = Array.from(new Set(reviews.map((r) => r.pr_id)));

    // 2. Fetch PR metadata and any existing LLM rows in parallel
    const [prsRes, existRes] = await Promise.all([
      supabase
        .from("prs")
        .select("id, number, author_login, title, created_at")
        .in("id", prIds),
      supabase
        .from("review_llm_features")
        .select("review_id, input_hash, prompt_version")
        .in("review_id", reviewIds),
    ]);

    if (prsRes.error)   throw new Error(`prs fetch: ${prsRes.error.message}`);
    if (existRes.error) throw new Error(`review_llm_features fetch: ${existRes.error.message}`);

    const prById = new Map<number, PrMetaRow>();
    for (const row of (prsRes.data ?? []) as unknown as PrMetaRow[]) {
      prById.set(row.id, row);
    }

    const existByReview = new Map<number, { input_hash: string; prompt_version: string }>();
    for (const row of (existRes.data ?? []) as {
      review_id: number; input_hash: string; prompt_version: string;
    }[]) {
      existByReview.set(row.review_id, row);
    }

    type WorkItem = {
      review: ReviewRow;
      pr: PrMetaRow;
      pkt: InputPacket;
      input_hash: string;
    };

    const todo: WorkItem[] = [];

    for (const review of reviews) {
      const pr = prById.get(review.pr_id);
      if (!pr) continue;

      const pkt       = buildInputPacket(review, pr);
      const inputHash = hashInputPacket(pkt);
      const existing  = existByReview.get(review.id);

      if (
        existing &&
        existing.prompt_version === PROMPT_VERSION &&
        existing.input_hash     === inputHash
      ) {
        totalSkipped++;
        continue;
      }

      todo.push({ review, pr, pkt, input_hash: inputHash });
    }

    if (todo.length === 0) {
      offset += reviews.length;
      if (reviews.length < READ_BATCH) break;
      continue;
    }

    // 3. Call Gemini concurrently for todo items
    const rows: ReviewLlmFeatureRow[] = [];

    await runConcurrent(todo, MAX_CONCURRENT, async ({ review, pr, pkt, input_hash }) => {
      const userTurn = buildUserTurn(pkt);
      const out = await callGemini(userTurn);

      const row =
        out !== null
          ? mapToRow(review, pr, input_hash, out)
          : makeFallbackRow(review, pr, input_hash);

      if (out === null) totalFallback++;
      rows.push(row);
    });

    // 4. Upsert review_llm_features
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const chunk = rows.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from("review_llm_features")
        .upsert(chunk, { onConflict: "review_id" });
      if (error) throw new Error(`review_llm_features upsert: ${error.message}`);
    }

    // 5. Stamp pr_reviews.enriched_at
    const enrichedIds = rows.map((r) => r.review_id);
    if (enrichedIds.length > 0) {
      const { error: stampErr } = await supabase
        .from("pr_reviews")
        .update({ enriched_at: new Date().toISOString() })
        .in("id", enrichedIds);
      if (stampErr) throw new Error(`pr_reviews enriched_at stamp: ${stampErr.message}`);
    }

    totalEnriched += rows.length;
    console.log(
      `  … enriched=${rows.length} (fallback=${totalFallback}) ` +
      `| running total: enriched=${totalEnriched} skipped=${totalSkipped}`,
    );

    offset += reviews.length;
    if (reviews.length < READ_BATCH) break;
  }

  console.log(
    `enrich-review: done — enriched=${totalEnriched}  skipped=${totalSkipped}  fallback=${totalFallback}`,
  );
}

main().catch((err: unknown) => {
  console.error("[enrich-review] fatal:", err);
  process.exit(1);
});
