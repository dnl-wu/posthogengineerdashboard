"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LeaderboardEngineer } from "@/lib/types";

interface Props {
  engineers: LeaderboardEngineer[];
  focusLogin: string | null;
}

// Apple HIG Colors
const HIG_ORANGE = "#FF9500";
const HIG_PURPLE = "#AF52DE";
const HIG_GRAY_4 = "#D1D1D6";
const HIG_GRAY_5 = "#E5E5EA";

export function LeaderboardTable({ engineers, focusLogin }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const days = searchParams.get("days") ?? "90";
  const maxScore = Math.max(engineers[0]?.raw_composite ?? 1, 1);

  const [activeLogin, setActiveLogin] = useState<string | null>(
    focusLogin ?? engineers[0]?.author_login ?? null,
  );

  useEffect(() => {
    setActiveLogin(focusLogin ?? engineers[0]?.author_login ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLogin, engineers[0]?.author_login]);

  function navigate(login: string) {
    setActiveLogin(login);
    const params = new URLSearchParams(searchParams.toString());
    params.set("focus", login);
    router.push(`?${params.toString()}`);
  }

  return (
    <section className="col-span-4 bg-white rounded-[24px] ring-1 ring-slate-900/5 shadow-sm flex flex-col min-h-0 overflow-hidden">
      
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-900/5 shrink-0 flex justify-between items-baseline bg-slate-50/50">
        <h3 className="text-base font-semibold tracking-tight text-slate-900">
          Top Engineers
        </h3>
        <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">
          Ranked by PIU score (90d)
        </span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {engineers.map((eng) => {
          const isActive = eng.author_login === activeLogin;
          
          // Vibrant HIG colors for active, subdued System Grays for inactive
          const prColor = isActive ? HIG_ORANGE : HIG_GRAY_4;
          const revColor = isActive ? HIG_PURPLE : HIG_GRAY_5;
          
          const prContrib  = 0.70 * eng.avg_pr_score * eng.n_prs_merged;
          const revContrib = 0.30 * eng.avg_review_score * eng.n_reviews_given;
          
          return (
            <div
              key={eng.author_login}
              onClick={() => navigate(eng.author_login)}
              className={`relative p-3 rounded-[16px] cursor-pointer transition-all duration-300 ease-out flex flex-col gap-3 group ${
                isActive 
                  ? "bg-slate-50/80 shadow-sm ring-1 ring-slate-900/5" 
                  : "hover:bg-slate-50/50 transparent"
              }`}
            >
              {/* macOS Sidebar Style Active Pill */}
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-[#FF9500] rounded-r-full shadow-sm" />
              )}

              {/* Engineer Info Row */}
              <div className="flex items-center justify-between pl-3 pr-1">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[13px] font-semibold tabular-nums transition-colors ${
                      isActive
                        ? "bg-[#FF9500] text-white"
                        : "bg-slate-100 text-slate-400 group-hover:text-slate-500"
                    }`}
                  >
                    {eng.rank}
                  </div>
                  
                  {/* GitHub avatar with Retina sizing & HIG inner ring */}
                  <img
                    src={`https://github.com/${eng.author_login}.png?size=64`}
                    alt={eng.author_login}
                    width={28}
                    height={28}
                    className="w-7 h-7 rounded-full bg-slate-100 shrink-0 ring-1 ring-black/5 shadow-sm"
                  />
                  
                  <span
                    className={`text-sm font-medium tracking-tight truncate max-w-[120px] transition-colors ${
                      isActive ? "text-slate-900" : "text-slate-600"
                    }`}
                  >
                    {eng.author_login}
                  </span>
                </div>
                
                <span className="flex items-baseline gap-1 shrink-0">
                  <span className={`text-sm font-semibold tabular-nums transition-colors ${isActive ? "text-slate-900" : "text-slate-600"}`}>
                    {eng.raw_composite.toFixed(1)}
                  </span>
                  <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
                    PIU
                  </span>
                </span>
              </div>

              {/* Stacked score bar */}
              <div className="pl-10 pr-1 flex flex-col gap-2">
                <div className="flex w-full h-1.5 rounded-full overflow-hidden bg-slate-100 shadow-inner">
                  <div
                    className="h-full transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={{
                      width: `${(prContrib / maxScore) * 100}%`,
                      backgroundColor: prColor,
                    }}
                  />
                  <div
                    className="h-full transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)]"
                    style={{
                      width: `${(revContrib / maxScore) * 100}%`,
                      backgroundColor: revColor,
                    }}
                  />
                </div>
                
                {/* Micro-stats */}
                <div className={`flex gap-3 text-[10px] font-medium tracking-wide transition-colors ${isActive ? "text-slate-500" : "text-slate-400"}`}>
                  <span className="flex items-center gap-1">
                    <span className="font-semibold text-slate-700">{eng.n_prs_merged}</span> PRs
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="font-semibold text-slate-700">{eng.n_reviews_given}</span> Reviews
                  </span>
                  {eng.avg_percentile != null && (
                    <span className="flex items-center gap-1 ml-auto">
                      P<span className="font-semibold text-slate-700">{Math.round(eng.avg_percentile)}</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="px-5 py-4 border-t border-slate-900/5 bg-slate-50/50 shrink-0 flex gap-5 text-[11px] font-medium text-slate-500">
        <span className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-[3px] bg-[#FF9500] shadow-sm" /> 
          PR Score
        </span>
        <span className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-[3px] bg-[#AF52DE] shadow-sm" /> 
          Review Score
        </span>
      </div>
      
    </section>
  );
}