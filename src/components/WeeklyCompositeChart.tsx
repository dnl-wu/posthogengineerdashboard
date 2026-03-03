"use client";
import {
  AreaChart,
  Area,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { EngineerWeeklyWithBand } from "@/lib/types";

interface Props {
  weekly: EngineerWeeklyWithBand[];
  login: string;
}

function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as EngineerWeeklyWithBand;
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg p-3 text-xs min-w-[160px]">
      <p className="font-bold text-slate-600 mb-2">{fmt(d.week_start)}</p>
      <div className="flex flex-col gap-1">
        <div className="flex justify-between gap-4">
          <span className="text-slate-400">Product Impact Units</span>
          <span className="font-bold text-[#EC6341]">{d.raw_composite?.toFixed(1)}</span>
        </div>
        {d.team_p50 != null && (
          <div className="flex justify-between gap-4">
            <span className="text-slate-400">Team Median</span>
            <span className="font-semibold text-slate-600">{d.team_p50?.toFixed(1)}</span>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <span className="text-slate-400">PRs merged</span>
          <span className="font-semibold text-slate-700">{d.n_prs_merged}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-slate-400">Reviews</span>
          <span className="font-semibold text-slate-700">{d.n_reviews}</span>
        </div>
      </div>
    </div>
  );
};

export function WeeklyCompositeChart({ weekly, login }: Props) {
  if (!weekly.length) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-slate-400">
        No weekly data available for this window.
      </div>
    );
  }

  const chartData = weekly.map((w) => ({
    ...w,
    band: [w.team_p25 ?? 0, w.team_p75 ?? 0] as [number, number],
  }));

  const allVals = [
    ...weekly.map((w) => w.raw_composite),
    ...weekly.map((w) => w.team_p75 ?? 0),
  ];
  const yMax = Math.max(...allVals) * 1.15;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-slate-800">Weekly Product Impact Units vs Team</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {login}'s weekly score relative to team P25–P75 band
          </p>
        </div>
        <div className="flex items-center gap-4 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 rounded bg-[#EC6341]" />
            {login}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-slate-100 border border-slate-200" />
            Team P25–P75
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
          <XAxis
            dataKey="week_start"
            tickFormatter={fmt}
            tick={{ fontSize: 10, fill: "#94A3B8" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={[0, yMax]}
            tick={{ fontSize: 10, fill: "#94A3B8" }}
            axisLine={false}
            tickLine={false}
            width={32}
          />
          <Tooltip content={<CustomTooltip />} />

          {/* P25–P75 shaded band via two areas */}
          <Area
            dataKey="team_p75"
            stroke="none"
            fill="#F1F5F9"
            fillOpacity={1}
            isAnimationActive={false}
          />
          <Area
            dataKey="team_p25"
            stroke="none"
            fill="#F7F8FA"
            fillOpacity={1}
            isAnimationActive={false}
          />

          {/* Team median dashed line */}
          <Line
            type="monotone"
            dataKey="team_p50"
            stroke="#CBD5E1"
            strokeWidth={1.5}
            strokeDasharray="5 3"
            dot={false}
            isAnimationActive={false}
          />

          {/* Engineer composite line */}
          <Line
            type="monotone"
            dataKey="raw_composite"
            stroke="#EC6341"
            strokeWidth={2.5}
            dot={{ fill: "#EC6341", r: 3, strokeWidth: 0 }}
            activeDot={{ r: 5, fill: "#EC6341", stroke: "white", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
