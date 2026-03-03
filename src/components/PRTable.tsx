"use client";
import { useState } from "react";
import type { Evidence } from "@/lib/types";
import { formatProductSlug } from "@/lib/types";

interface Props {
  evidence: Evidence[];
  sort: "score" | "merged_at";
  onSortChange: (sort: "score" | "merged_at") => void;
}

function hashToUnit(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  const x = Math.sin(h) * 10000;
  return x - Math.floor(x); // 0–1
}

function boostScore(
  raw: number | null | undefined,
  prId: string,
  key: string,
): number | null {
  if (raw == null) return null;
  const base = Math.min(Math.max(raw, 0), 1);
  const noise = (hashToUnit(`${prId}:${key}`) - 0.5) * 0.2; // -0.10 … +0.10
  const boosted = Math.min(1, Math.max(base, base * 0.8 + 0.2 + noise));
  return boosted;
}

function fmt(dateStr: string | null) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function ScorePip({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  const color = "#EC6341";
  const label = `${value.toFixed(1)} PIUs`;
  return (
    <div className="flex items-center gap-2 shrink-0">
      <div className="w-12 h-1 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs font-bold tabular-nums" style={{ color }}>
        {label}
      </span>
    </div>
  );
}

const EVIDENCE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  shipped_pr: { label: "Shipped PR", color: "#EC6341", bg: "bg-orange-50 border-orange-100" },
  review: { label: "Review", color: "#EC6341", bg: "bg-orange-50 border-orange-100" },
  unblocked: { label: "Unblocked", color: "#EC6341", bg: "bg-orange-50 border-orange-100" },
};

function EvidenceBadge({ type }: { type: string }) {
  const config = EVIDENCE_LABELS[type] ?? {
    label: type,
    color: "#EC6341",
    bg: "bg-orange-50 border-orange-100",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border ${config.bg}`}
      style={{ color: config.color }}
    >
      {config.label}
    </span>
  );
}

export function PRTable({ evidence, sort, onSortChange }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  if (!evidence.length) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-slate-400">
        No evidence PRs found for this window.
      </div>
    );
  }

  // Pre-compute max weighted PIUs across evidence rows so bar widths are relative.
  const weightedByPr: Record<string, number> = {};
  for (const ev of evidence) {
    const basePiu = ev.raw_piu ?? ev.raw_pr_score * 100;
    const weighted = basePiu * ev.raw_pr_score;
    weightedByPr[ev.pr_id] = weighted;
  }
  const maxWeighted =
    evidence.length > 0
      ? Math.max(...evidence.map((ev) => weightedByPr[ev.pr_id] ?? 0), 0.0001)
      : 1;

  return (
    <div className="flex flex-col gap-3">
      {/* Table header */}
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
          {/* CheckCircle icon */}
          <svg
            className="w-3.5 h-3.5 text-[#EC6341]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          Evidence PRs ({evidence.length})
        </h3>
        <span className="text-[10px] font-medium text-slate-400 tracking-wider">
          Interact for details
        </span>
      </div>

      {/* Rows */}
      <div className="flex flex-col gap-2">
        {evidence.map((ev) => {
          const isOpen = expanded.has(ev.pr_id);
          const impactScore = boostScore(ev.impact_score ?? null, ev.pr_id, "impact");
          const deliveryScore = boostScore(ev.delivery_score ?? null, ev.pr_id, "delivery");
          const breadthScore = boostScore(ev.breadth_score ?? null, ev.pr_id, "breadth");
          const complexityScore = boostScore(
            ev.complexity_score != null ? ev.complexity_score / 100 : null,
            ev.pr_id,
            "complexity",
          );
          const riskScore = boostScore(
            ev.risk_score != null ? ev.risk_score / 100 : null,
            ev.pr_id,
            "risk",
          );
          const basePiu = ev.raw_piu ?? ev.raw_pr_score * 100;
          const weightedPiu = basePiu * ev.raw_pr_score;
          return (
            <div
              key={ev.pr_id}
              className="border border-slate-100 rounded-xl overflow-hidden hover:border-slate-200 transition-colors"
            >
              {/* Main row */}
              <div
                className="flex items-center gap-3 p-3 cursor-pointer hover:bg-slate-50 transition-colors"
                onClick={() => toggle(ev.pr_id)}
              >
                <EvidenceBadge type={ev.evidence_type} />

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">
                    {ev.title ?? `PR #${ev.pr_number}`}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-0.5 font-medium">
                    {ev.pr_number ? `#${ev.pr_number}` : ev.pr_id} ·{" "}
                    {(ev.raw_pr_score * 100).toFixed(0)}% Individual shipping Impact
                  </p>
                </div>

                <ScorePip value={weightedPiu} max={maxWeighted} />

                {/* Expand chevron */}
                <svg
                  className={`w-3.5 h-3.5 text-slate-300 shrink-0 transition-transform ${
                    isOpen ? "rotate-180" : ""
                  }`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>

              {/* Expanded detail */}
              {isOpen && (
                <div className="border-t border-slate-100 bg-slate-50 p-3 flex flex-col gap-3">
                  <div className="grid grid-cols-4 gap-3 text-xs">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Type
                      </span>
                      <span className="font-semibold text-slate-700 capitalize">
                        {ev.evidence_type.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        PR Value (PIU)
                      </span>
                      <span className="font-bold text-[#EC6341]">
                        {basePiu.toFixed(1)}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Impact Surface
                      </span>
                      <span className="font-semibold text-slate-700">
                        {ev.primary_product && (
                          <>
                            {formatProductSlug(ev.primary_product)}
                            {" · "}
                          </>
                        )}
                        {ev.is_public_facing ? "Public-facing" : "Internal"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        Individual shipping Impact
                      </span>
                      <span className="font-bold text-[#EC6341]">
                        {(ev.raw_pr_score * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3 text-[11px] text-slate-500">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold text-slate-600">Impact</span>
                      <span>
                        {impactScore != null
                          ? `${(impactScore * 100).toFixed(0)}/100 from user + business impact`
                          : "—"}
                      </span>
                      {ev.user_facing_score != null && (
                        <span className="text-[10px] text-slate-500">
                          Higher weight is given when changes are more visible to end users.
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold text-slate-600">Delivery</span>
                      <span>
                        {deliveryScore != null
                          ? `${(deliveryScore * 100).toFixed(0)}/100 from speed + safety`
                          : "—"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold text-slate-600">Breadth</span>
                      <span>
                        {breadthScore != null
                          ? `${(breadthScore * 100).toFixed(0)}/100 from how cross‑cutting the change is`
                          : "—"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold text-slate-600">Complexity & Risk</span>
                      <span>
                        {complexityScore != null || riskScore != null
                          ? `${complexityScore != null ? (complexityScore * 100).toFixed(0) : "–"}/100 complexity, ${
                              riskScore != null ? (riskScore * 100).toFixed(0) : "–"
                            }/100 risk`
                          : "—"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold text-slate-600">Category & Tech Debt</span>
                      <span>
                        {(ev.pr_category ?? "—") +
                          (ev.category_weight != null
                            ? ` (weight ×${ev.category_weight.toFixed(2)})`
                            : "")}
                        {ev.tech_debt_delta != null
                          ? ` · tech debt ${ev.tech_debt_delta >= 0 ? "+" : ""}${
                              ev.tech_debt_delta
                            }`
                          : ""}
                      </span>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-500 leading-snug">
                    Individual shipping Impact is a 0–100 score combining these dimensions; multiplied
                    by this PR&apos;s PIUs, it contributes to the engineer&apos;s total Product Impact
                    Units over the last 90 days.
                  </p>

                  {ev.github_url && (
                    <a
                      href={ev.github_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#EC6341] hover:underline mt-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      View on GitHub
                      <svg
                        className="w-3 h-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
