"use client";
import type { EngineerSummary } from "@/lib/types";

interface Props {
  summary: EngineerSummary; // Ensure TeamLeaderboard is refactored!
}

const SCORE_MAX = 100;

function MiniBar({ value, color, max = SCORE_MAX }: { value: number; color: string; max: number }) {
  const percentage = Math.min((value / max) * 100, 100);

  return (
    <div className="flex-1 h-1.5 bg-slate-100 rounded-[100px] overflow-hidden">
      <div
        className="h-full rounded-[100px] transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ width: `${percentage}%`, backgroundColor: color }}
      />
    </div>
  );
}

export function ScoreBreakdownBar({ summary }: Props) {
  const total = summary.avg_pr_score + summary.avg_review_score;
  const prPct = total > 0 ? (summary.avg_pr_score / total) * 100 : 50;
  const revPct = 100 - prPct;

  const teamPr = summary.team_avg_pr_score ?? null;
  const teamRev = summary.team_avg_review_score ?? null;
  const prDelta = teamPr != null ? summary.avg_pr_score - teamPr : null;
  const revDelta = teamRev != null ? summary.avg_review_score - teamRev : null;

  const formatDelta = (delta: number | null) =>
    delta == null
      ? "vs team avg —"
      : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} vs avg`;

  return (
    <div className="flex flex-col gap-4">
      {/* Stacked composite bar */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-800 tracking-tight">
            Score Breakdown
          </span>
          <span className="text-[11px] font-medium text-slate-400">
            avg across window
          </span>
        </div>
        
        {/* Main Stacked Bar */}
        <div className="flex w-full h-2.5 rounded-full overflow-hidden bg-slate-100 shadow-inner">
          <div
            className="h-full transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{ width: `${prPct}%`, backgroundColor: "#FF9500" }}
            title={`PR Impact (Avg.): ${summary.avg_pr_score.toFixed(1)}`}
          />
          <div
            className="h-full transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)]"
            style={{ width: `${revPct}%`, backgroundColor: "#AF52DE" }}
            title={`Review Influence (Avg.): ${summary.avg_review_score.toFixed(1)}`}
          />
        </div>
        
        {/* Legend */}
        <div className="flex items-center justify-between mt-0.5 text-[10px] font-medium text-slate-600">
          <div className="flex flex-col gap-0.5">
            <span className="uppercase tracking-wider text-[10px] text-slate-400">
              Avg. Shipping Velocity Influence
            </span>
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1">
                <span className="text-slate-500">PRs</span>
                <span className="text-slate-800 font-semibold tabular-nums">
                  {summary.avg_pr_score.toFixed(1)}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <span className="text-slate-500">Reviews</span>
                <span className="text-slate-800 font-semibold tabular-nums">
                  {summary.avg_review_score.toFixed(1)}
                </span>
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <div className="w-2.5 h-2.5 rounded-[3px] bg-[#FF9500] shadow-sm" />
              <span>PR Impact</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-2.5 h-2.5 rounded-[3px] bg-[#AF52DE] shadow-sm" />
              <span>Review Influence</span>
            </div>
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {[
          {
            label: "PR Impact",
            value: summary.avg_pr_score.toFixed(1),
            sub: formatDelta(prDelta),
            color: "#FF9500", // System Orange
            max: 100
          },
          {
            label: "Review Influence",
            value: summary.avg_review_score.toFixed(1),
            sub: formatDelta(revDelta),
            color: "#AF52DE", // System Purple
            max: 100
          },
          {
            label: "Percentile",
            value: `P${Math.round(summary.avg_percentile ?? 0)}`,
            sub: "composite rank",
            color: "#007AFF", // System Blue
            max: 100
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-slate-50/80 rounded-[16px] p-3 ring-1 ring-slate-900/5 flex flex-col gap-1.5"
          >
            <span
              className="text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: stat.color }}
            >
              {stat.label}
            </span>
            <span className="text-xl font-semibold text-slate-900 leading-none tabular-nums tracking-tight">
              {stat.value}
            </span>
            <div className="flex items-center gap-2 mt-0.5">
              <MiniBar value={parseFloat(stat.value) || 0} color={stat.color} max={stat.max} />
              <span className="text-[10px] font-medium text-slate-500 shrink-0 tabular-nums">
                {stat.sub}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}