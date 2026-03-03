"use client";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { EngineerHeader } from "@/components/EngineerHeader";
import { ScoreBreakdownBar } from "@/components/ScoreBreakdownBar";
import { WeeklyCompositeChart } from "@/components/WeeklyCompositeChart";
import { PRTable } from "@/components/PRTable";
import Link from "next/link";
import type { EngineerSummary, EngineerWeeklyWithBand, Evidence, Area } from "@/lib/types";
import { formatProductSlug } from "@/lib/types";

interface EngineerData {
  engineer: { login: string };
  summary: EngineerSummary;
  weekly: EngineerWeeklyWithBand[];
  evidence: Evidence[];
  areas: Area[];
}

type SortKey = "score" | "merged_at";

function sortEvidence(ev: Evidence[], key: SortKey) {
  return [...ev].sort((a, b) =>
    key === "score"
      ? b.raw_pr_score - a.raw_pr_score
      : new Date(b.merged_at ?? 0).getTime() - new Date(a.merged_at ?? 0).getTime()
  );
}

const AREA_COLORS = ["#EC6341", "#8B5CF6", "#10B981", "#3B82F6", "#F59E0B", "#14B8A6"];

export function EngineerPanel({ engineers }: { engineers: { author_login: string }[] }) {
  const searchParams = useSearchParams();
  const focus = searchParams.get("focus");
  const days = searchParams.get("days") ?? "90";

  const [data, setData] = useState<EngineerData | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<SortKey>("score");

  useEffect(() => {
    if (!focus) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setData(null);
    fetch(`/api/engineer/${focus}?days=${days}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: EngineerData) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [focus, days]);

  // ── Empty state ──────────────────────────────────────────────────────────
  if (!focus) {
    return (
      <section className="col-span-8 bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex flex-col items-center justify-center gap-4 text-center p-8">
        <div className="w-12 h-12 rounded-2xl bg-orange-50 flex items-center justify-center">
          <svg className="w-6 h-6 text-[#EC6341]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-700">Select an engineer to drill down</p>
          <p className="text-xs text-slate-400 mt-1">
            Click a row in the leaderboard to view their full impact breakdown
          </p>
        </div>
        <div className="flex flex-wrap gap-2 justify-center">
          {engineers.map((e) => (
            <a
              key={e.author_login}
              href={`?focus=${e.author_login}&days=${days}`}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-100 hover:border-[#EC6341] hover:bg-orange-50 transition-colors text-sm font-semibold text-slate-700 hover:text-[#EC6341]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://github.com/${e.author_login}.png?size=24`}
                alt={e.author_login}
                className="w-5 h-5 rounded-full"
              />
              {e.author_login}
            </a>
          ))}
        </div>
      </section>
    );
  }

  // ── Loading state ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <section className="col-span-8 bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-7 h-7 rounded-full border-2 border-[#EC6341] border-t-transparent animate-spin" />
          <p className="text-xs text-slate-400 font-medium">Loading {focus}…</p>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="col-span-8 bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex items-center justify-center">
        <p className="text-sm text-slate-400">No data found for {focus}.</p>
      </section>
    );
  }

  // ── Engineer detail ──────────────────────────────────────────────────────
  const { summary, weekly, areas } = data;
  const sortedEvidence = sortEvidence(data.evidence, sort);
  const totalAreaPRs = areas.reduce((s, a) => s + a.n_prs, 0) || 1;

  return (
    <section className="col-span-8 bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">

        {/* Header row */}
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <EngineerHeader login={focus} summary={summary} />
          </div>
          <Link
            href={`/engineer/${focus}?days=${days}`}
            className="shrink-0 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-[#EC6341] transition-colors mt-1"
          >
            Full page
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </Link>
        </div>

        {/* Score breakdown + areas */}
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-8">
            <ScoreBreakdownBar summary={summary} />
          </div>

          <div className="col-span-4 flex flex-col gap-3">
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Areas Moved Forward
            </h3>
            {areas.length > 0 ? (
              <>
                <div className="flex w-full h-2 rounded-full overflow-hidden bg-slate-100">
                  {areas.slice(0, 6).map((a, i) => (
                    <div
                      key={a.area}
                      className="h-full"
                      style={{
                        width: `${(a.n_prs / totalAreaPRs) * 100}%`,
                        backgroundColor: AREA_COLORS[i],
                      }}
                    />
                  ))}
                </div>
                <div className="flex flex-col gap-1.5">
                  {areas.slice(0, 5).map((a, i) => (
                    <div key={a.area} className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: AREA_COLORS[i] }} />
                        <span className="text-xs font-semibold text-slate-700 truncate">{formatProductSlug(a.area)}</span>
                      </div>
                      <span className="text-xs font-bold text-slate-400 tabular-nums shrink-0">{a.n_prs} PRs</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs text-slate-400">No area data.</p>
            )}
          </div>
        </div>

        {/* PR evidence table */}
        <PRTable evidence={sortedEvidence} sort={sort} onSortChange={setSort} />
      </div>
    </section>
  );
}
