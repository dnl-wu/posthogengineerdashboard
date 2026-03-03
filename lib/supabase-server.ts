/**
 * Server-only Supabase client factory.
 *
 * SAFE TO IMPORT IN:  scripts/ workers, src/app/api/ route handlers, Server Components.
 * NEVER IMPORT IN:    Client Components ("use client"), any file shipped to the browser.
 *
 * The service role key bypasses Row Level Security.  It must never appear in
 * the client bundle — keep it server-side only and never prefix with NEXT_PUBLIC_.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

function getEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[supabase-server] Missing required environment variable: ${name}\n` +
        `Make sure it is set in .env.local (for local dev) or in your deployment environment.\n` +
        `  SUPABASE_URL              — your project URL (e.g. https://xxx.supabase.co)\n` +
        `  SUPABASE_SERVICE_ROLE_KEY — service role secret from Project Settings → API`,
    );
  }
  return value;
}

/**
 * Returns a Supabase client authenticated with the service role key.
 * Creates a new client on every call — callers may cache the result themselves
 * if they need to reuse it across multiple operations in the same request/script.
 */
export function createSupabaseServer(): SupabaseClient {
  const url = getEnvOrThrow("SUPABASE_URL");
  const key = getEnvOrThrow("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: {
      // Disable session persistence — scripts and API routes are stateless.
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
