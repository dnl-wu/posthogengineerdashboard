// GET /api/engineer/[login]
// Single-engineer drill-down: 90d scores + weekly series (with team band) + evidence + areas.
import { createSupabaseServer } from '@/lib/supabase-server'
import { NextRequest } from 'next/server'

const GITHUB_REPO = process.env.NEXT_PUBLIC_GITHUB_REPO ?? 'PostHog/posthog'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ login: string }> },
) {
  const { login: rawLogin } = await params
  const login = rawLogin.toLowerCase()
  const { searchParams } = req.nextUrl
  const days = Math.min(parseInt(searchParams.get('days') ?? '90'), 120)

  if (days < 1) {
    return Response.json({ error: 'days must be between 1 and 120' }, { status: 400 })
  }

  const from = new Date()
  from.setDate(from.getDate() - days)
  const fromISO = from.toISOString().slice(0, 10)

  const supabase = createSupabaseServer()

  // 1. 90-day aggregate
  const { data: score90, error: scoreErr } = await supabase
    .from('engineer_scores_90d')
    .select('*')
    .ilike('author_login', login)
    .maybeSingle()

  if (scoreErr) {
    console.error('[engineer/score]', scoreErr)
    return Response.json({ error: 'internal server error' }, { status: 500 })
  }

  if (!score90) {
    return Response.json({ error: 'engineer not found' }, { status: 404 })
  }

  // 2. Team averages for PR / review impact (for deltas vs team)
  let teamAvgPr: number | null = null
  let teamAvgReview: number | null = null

  const { data: teamRows, error: teamErr } = await supabase
    .from('engineer_scores_90d')
    .select('avg_pr_score, avg_review_score')

  if (teamErr) {
    console.error('[engineer/team-averages]', teamErr)
  } else if (teamRows && teamRows.length > 0) {
    const n = teamRows.length
    const sumPr = teamRows.reduce((s, r: any) => s + (Number(r.avg_pr_score) || 0), 0)
    const sumRev = teamRows.reduce((s, r: any) => s + (Number(r.avg_review_score) || 0), 0)
    teamAvgPr = n > 0 ? sumPr / n : null
    teamAvgReview = n > 0 ? sumRev / n : null
  }

  // 3. Weekly series + team band (parallel)
  const [
    { data: weekly, error: weeklyErr },
    { data: teamBand, error: bandErr },
    { data: evidence, error: evidenceErr },
    { data: areas, error: areasErr },
  ] = await Promise.all([
    supabase
      .from('engineer_weekly_velocity')
      .select(
        'week_start, raw_composite, avg_pr_score, avg_review_score, n_prs_merged, n_reviews, team_percentile',
      )
      .ilike('author_login', login)
      .gte('week_start', fromISO)
      .order('week_start', { ascending: true }),

    supabase
      .from('team_weekly_velocity')
      .select('week_start, p25_composite, p50_composite, p75_composite')
      .gte('week_start', fromISO)
      .order('week_start', { ascending: true }),

    // Evidence: top 10 notable PRs
    supabase
      .from('engineer_evidence')
      .select('pr_id, evidence_type, raw_pr_score, week_start, prs(number, title, merged_at, repo)')
      .ilike('author_login', login)
      .order('raw_pr_score', { ascending: false })
      .limit(10),

    // Areas of specialisation
    supabase
      .from('engineer_areas')
      .select('area, n_prs, n_files_touched, last_touched_at')
      .ilike('author_login', login)
      .order('n_prs', { ascending: false }),
  ])

  if (weeklyErr || bandErr || evidenceErr || areasErr) {
    const err = weeklyErr ?? bandErr ?? evidenceErr ?? areasErr
    console.error('[engineer/parallel]', err)
    return Response.json({ error: 'internal server error' }, { status: 500 })
  }

  // Merge team band into weekly rows by week_start
  const bandByWeek = Object.fromEntries(
    (teamBand ?? []).map(r => [r.week_start, r]),
  )
  const weeklySeries = (weekly ?? []).map(w => {
    const band = bandByWeek[w.week_start]
    return {
      ...w,
      raw_composite: w.raw_composite,
      avg_pr_score: w.avg_pr_score * 100,
      avg_review_score: w.avg_review_score * 100,
      team_p25: band?.p25_composite ?? null,
      team_p50: band?.p50_composite ?? null,
      team_p75: band?.p75_composite ?? null,
    }
  })

  // Fetch per-PR metadata used in Product Impact Units for evidence rows
  const evidencePrIds = (evidence ?? []).map(e => e.pr_id)
  let evidenceMetaByPr: Record<string, {
    primary_product: string | null
    user_facing_score: number | null
    complexity_score: number | null
    risk_score: number | null
    cross_cutting_score: number | null
    tech_debt_delta: number | null
    is_breaking_change: boolean | null
    touches_critical_path: boolean | null
    pr_category: string | null
  }> = {}
  let scoreMetaByPr: Record<string, {
    impact_score: number | null
    delivery_score: number | null
    breadth_score: number | null
    category_weight: number | null
  }> = {}

  if (evidencePrIds.length > 0) {
    const [{ data: prMeta, error: prMetaErr }, { data: scoreMeta, error: scoreMetaErr }] =
      await Promise.all([
        supabase
          .from('pr_llm_features')
          .select(
            'pr_id, primary_product, user_facing_score, complexity_score, risk_score, cross_cutting_score, tech_debt_delta, is_breaking_change, touches_critical_path, pr_category',
          )
          .in('pr_id', evidencePrIds),
        supabase
          .from('pr_scores')
          .select('pr_id, impact_score, delivery_score, breadth_score, category_weight')
          .in('pr_id', evidencePrIds),
      ])

    if (prMetaErr) {
      console.error('[engineer/pr_meta]', prMetaErr)
    } else {
      evidenceMetaByPr = Object.fromEntries(
        (prMeta ?? []).map(row => [String(row.pr_id), {
          primary_product: row.primary_product ?? null,
          user_facing_score: row.user_facing_score ?? null,
          complexity_score: row.complexity_score ?? null,
          risk_score: row.risk_score ?? null,
          cross_cutting_score: row.cross_cutting_score ?? null,
          tech_debt_delta: row.tech_debt_delta ?? null,
          is_breaking_change: row.is_breaking_change ?? null,
          touches_critical_path: row.touches_critical_path ?? null,
          pr_category: row.pr_category ?? null,
        }]),
      )
    }

    if (scoreMetaErr) {
      console.error('[engineer/score_meta]', scoreMetaErr)
    } else {
      scoreMetaByPr = Object.fromEntries(
        (scoreMeta ?? []).map(row => [String(row.pr_id), {
          impact_score: row.impact_score ?? null,
          delivery_score: row.delivery_score ?? null,
          breadth_score: row.breadth_score ?? null,
          category_weight: row.category_weight ?? null,
        }]),
      )
    }
  }

  // 4. Allocate per‑PR Product Impact Units (PIUs) across evidence PRs.
  //
  // Let raw_pr_score be the 0–1 "Shipping Impact" score for a PR, and raw_piu be
  // the PIU multiplier attached to that PR. We choose raw_piu so that:
  //
  //    Σ (raw_pr_score_i × raw_piu_i) ≈ engineer_90d_raw_composite
  //
  // and we still bias towards higher‑ranked PRs via a geometric weighting over
  // the distinct evidence PRs.
  const totalComposite = Number(score90.raw_composite) || 0
  const evidenceRows = evidence ?? []

  const piuByPr: Record<string, number> = {}

  if (totalComposite > 0 && evidenceRows.length > 0) {
    // Map each PR id → first seen raw_pr_score (Shipping Impact, 0–1 range).
    const shipByPr: Record<string, number> = {}
    for (const e of evidenceRows) {
      const id = String(e.pr_id)
      if (shipByPr[id] == null) {
        shipByPr[id] = Number(e.raw_pr_score) || 0
      }
    }

    // Deduplicate PRs while preserving the Supabase ORDER BY (highest‑score first).
    const uniquePrs: { pr_id: string; index: number }[] = []
    const seen = new Set<string>()
    evidenceRows.forEach((e, idx) => {
      const id = String(e.pr_id)
      if (!seen.has(id)) {
        seen.add(id)
        uniquePrs.push({ pr_id: id, index: idx })
      }
    })

    // Consider only PRs with positive shipping impact when solving
    // Σ (raw_pr_score_i × raw_piu_i) ≈ totalComposite.
    const positivePrs = uniquePrs.filter(({ pr_id }) => (shipByPr[pr_id] ?? 0) > 0)

    if (positivePrs.length > 0) {
      const n = positivePrs.length

      // Geometric decay by rank over the positive‑impact PRs: w_k = decay^(k-1)
      const decay = 0.75
      const weights: number[] = []
      let weightSum = 0
      for (let i = 0; i < n; i++) {
        const w = Math.pow(decay, i)
        weights.push(w)
        weightSum += w
      }

      // First choose a set of target contributions C_i that sum to totalComposite:
      //   C_i = totalComposite × (w_i / Σ w)
      // then back out raw_piu_i so that raw_pr_score_i × raw_piu_i ≈ C_i.
      for (let i = 0; i < n; i++) {
        const prId = positivePrs[i].pr_id
        const ship = shipByPr[prId] ?? 0
        if (ship <= 0) continue

        const contribution = (totalComposite * weights[i]) / weightSum
        const basePiu = contribution / ship
        piuByPr[prId] = Number(basePiu.toFixed(4))
      }
    } else if (uniquePrs.length > 0) {
      // Fallback: if every evidence PR has zero shipping impact, fall back to a
      // simple equal split so Σ raw_piu_i ≈ totalComposite.
      const equal = totalComposite / uniquePrs.length
      for (const { pr_id } of uniquePrs) {
        piuByPr[pr_id] = Number(equal.toFixed(4))
      }
    }
  }

  // 5. Shape evidence rows
  const formattedEvidence = evidenceRows.map(e => {
    const pr = Array.isArray(e.prs) ? e.prs[0] : e.prs
    const meta = evidenceMetaByPr[String(e.pr_id)] ?? {
      primary_product: null,
      user_facing_score: null,
      complexity_score: null,
      risk_score: null,
      cross_cutting_score: null,
      tech_debt_delta: null,
      is_breaking_change: null,
      touches_critical_path: null,
      pr_category: null,
    }
    const scoreMeta = scoreMetaByPr[String(e.pr_id)] ?? {
      impact_score: null,
      delivery_score: null,
      breadth_score: null,
      category_weight: null,
    }

    let isPublicFacing: boolean | null = null
    if (typeof meta.user_facing_score === 'number') {
      isPublicFacing = meta.user_facing_score >= 50
    }

    return {
      pr_id: e.pr_id,
      pr_number: pr?.number ?? null,
      title: pr?.title ?? null,
      merged_at: pr?.merged_at ?? null,
      evidence_type: e.evidence_type,
      raw_pr_score: e.raw_pr_score,
      week_start: e.week_start,
      github_url: pr
        ? `https://github.com/${pr.repo ?? GITHUB_REPO}/pull/${pr.number}`
        : null,
      // Rank‑biased PIUs; raw_pr_score × raw_piu across PRs approximates the engineer's PIUs.
      raw_piu: piuByPr[String(e.pr_id)] ?? 0,
      primary_product: meta.primary_product,
      is_public_facing: isPublicFacing,
      impact_score: scoreMeta.impact_score,
      delivery_score: scoreMeta.delivery_score,
      breadth_score: scoreMeta.breadth_score,
      category_weight: scoreMeta.category_weight,
      pr_category: meta.pr_category,
      complexity_score: meta.complexity_score,
      risk_score: meta.risk_score,
      cross_cutting_score: meta.cross_cutting_score,
      user_facing_score: meta.user_facing_score,
      tech_debt_delta: meta.tech_debt_delta,
      is_breaking_change: meta.is_breaking_change,
      touches_critical_path: meta.touches_critical_path,
    }
  })

  return Response.json({
    engineer: { login: score90.author_login },
    summary: {
      n_prs: score90.n_prs_merged,
      n_reviews: score90.n_reviews_given,
      avg_pr_score: score90.avg_pr_score * 100,
      avg_review_score: score90.avg_review_score * 100,
      composite_score: score90.raw_composite,
      avg_percentile: score90.avg_percentile,
      rank: score90.rank,
      team_avg_pr_score: teamAvgPr != null ? teamAvgPr * 100 : null,
      team_avg_review_score: teamAvgReview != null ? teamAvgReview * 100 : null,
    },
    weekly: weeklySeries,
    evidence: formattedEvidence,
    areas: areas ?? [],
    generated_at: new Date().toISOString(),
  })
}
