// GET /api/prs/[login]
// Paginated PR list for an engineer with per-PR score breakdown.
// See docs/plan.md §3.3 for full response contract.
import { createSupabaseServer } from "@/lib/supabase-server";
import { NextRequest } from "next/server";

const VALID_SORTS = ["score", "merged_at", "complexity"] as const;
type Sort = (typeof VALID_SORTS)[number];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ login: string }> },
) {
  const { login: rawLogin } = await params;
  const login = rawLogin.toLowerCase();
  const { searchParams } = req.nextUrl;
  const days   = Math.min(parseInt(searchParams.get("days")   ?? "90"),  120);
  const limit  = Math.min(parseInt(searchParams.get("limit")  ?? "20"),   50);
  const offset =           parseInt(searchParams.get("offset") ?? "0");
  const sortRaw = searchParams.get("sort") ?? "score";
  const sort: Sort = (VALID_SORTS as readonly string[]).includes(sortRaw)
    ? (sortRaw as Sort)
    : "score";

  if (days < 1) {
    return Response.json({ error: "days must be between 1 and 120" }, { status: 400 });
  }

  const supabase = createSupabaseServer();
  void supabase; void login; void limit; void offset; void sort; // TODO: implement

  return Response.json({ error: "not implemented" }, { status: 501 });
}
