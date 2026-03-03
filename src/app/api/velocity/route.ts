// GET /api/velocity
// team_weekly_velocity band (mean + p25/p50/p75) + top-5 engineer weekly series.
// ?focus=<login>  optionally includes a specific engineer's series alongside top-5.
// ?days=<int>     look-back window, default 90, max 120.
import { createSupabaseServer } from '@/lib/supabase-server'
import { NextRequest } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const days = Math.min(parseInt(searchParams.get('days') ?? '90'), 120)
  const focus = searchParams.get('focus')?.toLowerCase() ?? null

  if (days < 1) {
    return Response.json({ error: 'days must be between 1 and 120' }, { status: 400 })
  }

  const from = new Date()
  from.setDate(from.getDate() - days)
  const fromISO = from.toISOString().slice(0, 10)
  const toISO = new Date().toISOString().slice(0, 10)

  const supabase = createSupabaseServer()

  // 1. Team weekly band
  const { data: teamBand, error: teamErr } = await supabase
    .from('team_weekly_velocity')
    .select('week_start, n_active, mean_composite, p25_composite, p50_composite, p75_composite')
    .gte('week_start', fromISO)
    .order('week_start', { ascending: true })

  if (teamErr) {
    console.error('[velocity/team_band]', teamErr)
    return Response.json({ error: 'internal server error' }, { status: 500 })
  }

  // 2. Top-5 engineer logins by 90-day raw_composite
  const { data: top5rows, error: top5Err } = await supabase
    .from('engineer_scores_90d')
    .select('author_login, raw_composite')
    .order('raw_composite', { ascending: false })
    .limit(5)

  if (top5Err) {
    console.error('[velocity/top5]', top5Err)
    return Response.json({ error: 'internal server error' }, { status: 500 })
  }

  const top5Logins = (top5rows ?? []).map(r => r.author_login)
  const seriesLogins =
    focus && !top5Logins.map(l => l.toLowerCase()).includes(focus)
      ? [...top5Logins, focus]
      : top5Logins

  // 3. Weekly series for top-5 (+ focus engineer if provided and not already included)
  const { data: series, error: seriesErr } = await supabase
    .from('engineer_weekly_velocity')
    .select(
      'author_login, week_start, raw_composite, avg_pr_score, avg_review_score, n_prs_merged, n_reviews, team_percentile',
    )
    .in('author_login', seriesLogins)
    .gte('week_start', fromISO)
    .order('week_start', { ascending: true })

  if (seriesErr) {
    console.error('[velocity/series]', seriesErr)
    return Response.json({ error: 'internal server error' }, { status: 500 })
  }

  // Group series rows by engineer login
  const seriesByLogin: Record<string, typeof series> = {}
  for (const row of series ?? []) {
    ;(seriesByLogin[row.author_login] ??= []).push(row)
  }

  return Response.json({
    window: { from: fromISO, to: toISO },
    team_band: teamBand ?? [],
    engineer_series: seriesByLogin,
    top5_logins: top5Logins,
    focus: focus ?? null,
    generated_at: new Date().toISOString(),
  })
}
