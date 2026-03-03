"use client";
import { useState, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { EngineerHeader } from "@/components/EngineerHeader";
import { ScoreBreakdownBar } from "@/components/ScoreBreakdownBar";
import { WeeklyCompositeChart } from "@/components/WeeklyCompositeChart";
import { PRTable } from "@/components/PRTable";
import type { EngineerSummary, EngineerWeeklyWithBand, Evidence, Area } from "@/lib/types";
import { formatProductSlug } from "@/lib/types";
import Link from "next/link";

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

export default function EngineerPage() {
  const params = useParams<{ login: string }>();
  const searchParams = useSearchParams();
  const login = params.login;
  const days = searchParams.get("days") ?? "90";

  const [data, setData] = useState<EngineerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("score");

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/engineer/${login}?days=${days}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d: EngineerData) => setData(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [login, days]);

  if (loading) {
    return (
      <div className="h-screen w-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-[#EC6341] border-t-transparent animate-spin" />
          <p className="text-sm text-slate-500 font-medium">Loading {login}'s data…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="h-screen w-screen bg-[#F7F8FA] flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm font-semibold text-slate-700">
            {error === "Not Found" ? "Engineer not found" : "Something went wrong"}
          </p>
          <p className="text-xs text-slate-400 mt-1">{error}</p>
          <Link
            href={`/dashboard?days=${days}`}
            className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#EC6341] hover:underline"
          >
            ← Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const { summary, weekly, areas } = data;
  const sortedEvidence = sortEvidence(data.evidence, sort);

  const areaColors = ["#EC6341", "#8B5CF6", "#10B981", "#3B82F6", "#F59E0B", "#14B8A6"];
  const totalAreaPRs = areas.reduce((s, a) => s + a.n_prs, 0) || 1;

  return (
    <div className="min-h-screen bg-[#F7F8FA] text-slate-900">
      {/* ── Top bar ── */}
      <div className="sticky top-0 z-20 bg-[#F7F8FA]/90 backdrop-blur-sm border-b border-slate-100 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href={`/dashboard?days=${days}`}
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-[#EC6341] transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Dashboard
          </Link>
          <span className="text-slate-200">/</span>
          <span className="text-sm font-semibold text-slate-700">{login}</span>
        </div>

        {/* Day selector inline */}
        <div className="flex items-center gap-1 bg-white rounded-lg p-1 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-slate-100">
          {[30, 60, 90].map((d) => {
            const active = String(d) === days;
            return (
              <Link
                key={d}
                href={`/engineer/${login}?days=${d}`}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                  active
                    ? "bg-[#EC6341] text-white shadow-sm"
                    : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                }`}
              >
                {d}d
              </Link>
            );
          })}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="max-w-5xl mx-auto px-6 py-6 flex flex-col gap-6">

        {/* Engineer header card */}
        <div className="bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] p-6">
          <EngineerHeader login={login} summary={summary} />
        </div>

        {/* Score breakdown + areas */}
        <div className="grid grid-cols-12 gap-4">
          {/* Score breakdown */}
          <div className="col-span-8 bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] p-6">
            <ScoreBreakdownBar summary={summary} />
          </div>

          {/* Areas */}
          <div className="col-span-4 bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] p-5 flex flex-col gap-4">
            <div>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Areas Moved Forward
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">by PR count</p>
            </div>

            {areas.length > 0 ? (
              <>
                <div className="flex w-full h-2.5 rounded-full overflow-hidden bg-slate-100">
                  {areas.slice(0, 6).map((a, i) => (
                    <div
                      key={a.area}
                      className="h-full"
                      style={{
                        width: `${(a.n_prs / totalAreaPRs) * 100}%`,
                        backgroundColor: areaColors[i],
                      }}
                    />
                  ))}
                </div>

                <div className="flex flex-col gap-2">
                  {areas.slice(0, 6).map((a, i) => (
                    <div key={a.area} className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: areaColors[i] }}
                        />
                        <span className="text-xs font-semibold text-slate-700 truncate">
                          {formatProductSlug(a.area)}
                        </span>
                      </div>
                      <span className="text-xs font-bold text-slate-400 tabular-nums shrink-0">
                        {a.n_prs} PRs
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs text-slate-400">No area data available.</p>
            )}
          </div>
        </div>

        {/* PR evidence table */}
        <div className="bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] p-6 pb-8">
          <PRTable evidence={sortedEvidence} sort={sort} onSortChange={setSort} />
        </div>
      </div>
    </div>
  );
}
