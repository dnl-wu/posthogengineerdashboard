"use client";
import type { EngineerSummary } from "@/lib/types";

interface Props {
  login: string;
  summary: EngineerSummary;
}

export function EngineerHeader({ login, summary }: Props) {
  return (
    <div className="flex items-start gap-5">
      <img
        src={`https://github.com/${login}.png?size=80`}
        alt={login}
        width={56}
        height={56}
        className="w-14 h-14 rounded-2xl bg-slate-100 shadow-sm shrink-0"
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 leading-none">
            {login}
          </h1>
          <span className="px-2.5 py-1 rounded-lg bg-orange-50 text-[#EC6341] text-xs font-bold border border-orange-100 leading-none">
            #{summary.rank}
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-slate-100 text-slate-600 text-xs font-bold leading-none">
            P{Math.round(summary.avg_percentile ?? 0)}
          </span>
        </div>

        <p className="text-sm text-slate-500 mt-2 leading-none">
          <strong className="text-slate-700 font-semibold">{summary.n_prs}</strong> PRs ·{" "}
          <strong className="text-slate-700 font-semibold">{summary.n_reviews}</strong> reviews
        </p>
        <div className="mt-3 inline-flex px-3 py-1 rounded-full bg-slate-50 border border-slate-200">
          <span className="text-[11px] text-slate-600">
            This engineer led{" "}
            <span className="font-semibold text-slate-800">
              {summary.composite_score.toFixed(1)}
            </span>{" "}
            impactful changes in the last 90 days.
          </span>
        </div>
      </div>

      {/* Composite badge removed per request */}
    </div>
  );
}
