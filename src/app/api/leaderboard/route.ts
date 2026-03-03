// GET /api/leaderboard
// Top 5 engineers by raw_composite from engineer_scores_90d.
import { createSupabaseServer } from '@/lib/supabase-server'
import { NextRequest } from 'next/server'

export async function GET(_req: NextRequest) {
  const supabase = createSupabaseServer()

  const { data, error } = await supabase
    .from('engineer_scores_90d')
    .select(
      'author_login, n_prs_merged, avg_pr_score, n_reviews_given, avg_review_score, raw_composite, avg_percentile, rank, computed_at',
    )
    .order('raw_composite', { ascending: false })
    .limit(5)

  if (error) {
    console.error('[leaderboard]', error)
    return Response.json({ error: 'internal server error' }, { status: 500 })
  }

  return Response.json({
    engineers: data ?? [],
    generated_at: new Date().toISOString(),
  })
}
