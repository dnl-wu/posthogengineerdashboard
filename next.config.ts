import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent service-role key from accidentally leaking into client bundles.
  // Any import of lib/supabase-server.ts in a Client Component will throw at
  // build time because SUPABASE_SERVICE_ROLE_KEY has no NEXT_PUBLIC_ prefix
  // and therefore resolves to undefined in the browser bundle.
};

export default nextConfig;
