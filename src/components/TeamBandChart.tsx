"use client";
import type { LeaderboardEngineer } from "@/lib/types";

interface Props {
  engineers: LeaderboardEngineer[];
}

// Analytical Monochromatic Scale (Blue 600 -> Blue 200)
const ANALYTIC_COLORS =[
  "#2563EB", 
  "#3B82F6", 
  "#60A5FA", 
  "#93C5FD", 
  "#BFDBFE", 
];

export function TeamBandChart({ engineers }: Props) {
  if (!engineers.length) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 shrink-0 flex items-center justify-center min-h-[160px] text-sm text-slate-400">
        No 90-day velocity data available.
      </div>
    );
  }

  // Sort top 5 engineers and calculate team average
  const sorted = [...engineers].sort((a, b) => b.raw_composite - a.raw_composite);
  const top5 = sorted.slice(0, 5);

  const teamAvg =
    engineers.length > 0
      ? engineers.reduce((sum, e) => sum + (Number(e.raw_composite) || 0), 0) / engineers.length
      : 0;

  const bars = top5.map((e, idx) => ({
    label: e.author_login,
    value: Number(e.raw_composite) || 0,
    color: ANALYTIC_COLORS[idx] ?? "#2563EB",
    isAvg: false,
  }));

  const allBars =[
    ...bars,
    // Subdued analytic gray for the average bar
    { label: "Team Avg", value: teamAvg, color: "#E2E8F0", isAvg: true }, 
  ];

  const maxVal = Math.max(...allBars.map((b) => b.value), 1);

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 shrink-0 font-sans">
      
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-slate-900">
          Team Velocity
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Last 90 days composite — top 5 vs. team average
        </p>
      </div>

      {/* Chart Area */}
      <div className="mt-4">
        {/* Bars */}
        <div className="flex items-end justify-between h-28 px-2 gap-4 sm:gap-8 border-b border-slate-200">
          {allBars.map((b) => {
            const heightPercent = (b.value / maxVal) * 100 || 0;
            
            return (
              <div
                key={b.label}
                className="group flex-1 flex flex-col items-center justify-end h-full relative"
              >
                {/* Bar Fill */}
                <div className="w-full max-w-[32px] h-full flex items-end justify-center">
                  <div
                    className={`w-full min-h-[2px] rounded-t-sm transition-all duration-700 ease-in-out ${
                      !b.isAvg && "hover:opacity-85 cursor-default"
                    }`}
                    style={{
                      height: `${heightPercent}%`,
                      backgroundColor: b.color,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* X-Axis Labels */}
        <div className="flex justify-between px-2 gap-4 sm:gap-8 pt-2">
          {allBars.map((b) => (
            <div key={`${b.label}-axis`} className="flex-1 flex flex-col items-center">
              <span
                className={`text-[11px] truncate w-full text-center ${
                  b.isAvg ? "font-medium text-slate-400 italic" : "font-medium text-slate-600"
                }`}
                title={b.label}
              >
                {b.label}
              </span>
              <span className={`text-[11px] tabular-nums mt-0.5 ${b.isAvg ? "text-slate-400" : "text-slate-500"}`}>
                {b.value ? b.value.toFixed(1) : "0.0"}
              </span>
            </div>
          ))}
        </div>
      </div>
      
    </div>
  );
}