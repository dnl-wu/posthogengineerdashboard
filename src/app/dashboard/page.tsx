import { Suspense } from "react";
import { createSupabaseServer } from "@/lib/supabase-server";
import { TeamBandChart } from "@/components/TeamBandChart";
import { LeaderboardTable } from "@/components/LeaderboardTable";
import { EngineerPanel } from "@/components/EngineerPanel";
import type { LeaderboardEngineer, TeamBandRow } from "@/lib/types";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ days?: string; focus?: string }>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const resolvedParams = await searchParams;
  const days = Math.min(parseInt(resolvedParams.days ?? "90"), 120);
  const focus = resolvedParams.focus?.toLowerCase() ?? null;

  const from = new Date();
  from.setDate(from.getDate() - days);
  const fromISO = from.toISOString().slice(0, 10);

  const supabase = createSupabaseServer();

  const [
    { data: teamBandRaw },
    { data: engineers },
  ] = await Promise.all([
    supabase
      .from("team_weekly_velocity")
      .select("week_start, n_active, mean_composite, p25_composite, p50_composite, p75_composite")
      .gte("week_start", fromISO)
      .order("week_start", { ascending: true }),

    supabase
      .from("engineer_scores_90d")
      .select(
        "author_login, n_prs_merged, avg_pr_score, n_reviews_given, avg_review_score, raw_composite, avg_percentile, rank, computed_at"
      )
      .order("raw_composite", { ascending: false })
  ]);

  const eng = (engineers ?? []) as LeaderboardEngineer[];
  const top5 = eng.slice(0, 5);
  const top5Composite =
    top5.length > 0
      ? top5.reduce((s, e) => s + e.raw_composite, 0).toFixed(1)
      : "—";
  const avgComposite =
    eng.length > 0
      ? (eng.reduce((s, e) => s + e.raw_composite, 0) / eng.length).toFixed(1)
      : "—";
  const totalComposite =
    eng.length > 0 ? eng.reduce((s, e) => s + e.raw_composite, 0).toFixed(1) : "—";

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#F7F8FA] text-slate-900 flex flex-col p-5 gap-4 box-border">
      {/* ── Header ── */}
      <header className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold tracking-tight text-slate-900 leading-none">
            Engineering Velocity @ PostHog
          </h1>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/wooly.png" alt="Wooly" className="h-8 w-auto" />
        </div>

        <a
          href="https://github.com/PostHog/posthog"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-[#EC6341] transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
          </svg>
          PostHog/posthog
        </a>
      </header>

      {/* ── Stats strip ── */}
      <div className="grid grid-cols-5 gap-3 shrink-0">
        {[
          {
            label: "Product Impact Unit",
            value: "1 PIU",
            sub: "1 PIU = one meaningful unit of product change delivered over the last 90 days. Includes impact from shipped work and review influence.",
            color: "#0F766E",
          },
          {
            label: "Top Engineer",
            value: eng[0]?.author_login ?? "—",
            sub: eng[0] ? `${eng[0].raw_composite.toFixed(1)} product impact units` : "no data",
            color: "#EC6341",
          },
          {
            label: "Team Avg Product Impact Units",
            value: avgComposite,
            sub: "average across all engineers",
            color: "#EC6341",
          },
          {
            label: "Top 5 Product Impact Units",
            value: top5Composite,
            sub: "sum of top‑5 90d scores",
            color: "#EC6341",
          },
          {
            label: "Total Impactful Changes",
            value: totalComposite,
            sub: "sum of product impact units across all engineers",
            color: "#EC6341",
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-white rounded-xl p-4 shadow-[0_2px_8px_rgba(0,0,0,0.03)] border border-slate-100 flex flex-col gap-1"
          >
            <span
              className="text-[10px] font-bold uppercase tracking-wider"
              style={{ color: stat.color }}
            >
              {stat.label}
            </span>
            <span className="text-xl font-bold text-slate-900 leading-none">{stat.value}</span>
            <span className="text-xs text-slate-400">{stat.sub}</span>
          </div>
        ))}
      </div>

      {/* ── Hero Chart ── */}
      <TeamBandChart
        engineers={eng}
      />

      {/* ── Bottom grid ── */}
      <main className="flex-1 grid grid-cols-12 gap-4 min-h-0">
        <Suspense fallback={null}>
          <LeaderboardTable engineers={eng} focusLogin={focus} />
        </Suspense>

        <Suspense
          fallback={
            <section className="col-span-8 bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex items-center justify-center">
              <div className="w-6 h-6 rounded-full border-2 border-[#EC6341] border-t-transparent animate-spin" />
            </section>
          }
        >
          <EngineerPanel engineers={eng} />
        </Suspense>
      </main>
    </div>
  );
}
