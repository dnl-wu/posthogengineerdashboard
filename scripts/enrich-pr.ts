/**
 * enrich-pr.ts
 * ────────────
 * Reads `prs` WHERE enriched_at IS NULL, computes deterministic structural
 * features, calls Gemini Flash for LLM signals, and writes results to
 * `pr_features` and `pr_llm_features`.  Stamps `prs.enriched_at` on success.
 *
 * Tables read:    prs, pr_changed_files  (schema: docs/schema.md §1–2)
 * Tables written: pr_features, pr_llm_features  (schema: docs/schema.md §4–5)
 * Run via:  npm run build_features   or   npm run llm_enrich
 *
 * Env vars required:
 *   GEMINI_API_KEY
 *   GEMINI_MODEL            default "gemini-2.0-flash"
 *   GEMINI_MAX_CONCURRENT   default 5
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import "dotenv/config";
import { createSupabaseServer } from "../lib/supabase-server";

async function main() {
  const supabase = createSupabaseServer();
  void supabase;
  // TODO: implement PR enrichment — deterministic features + Gemini call
  console.log("enrich-pr: TODO");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
