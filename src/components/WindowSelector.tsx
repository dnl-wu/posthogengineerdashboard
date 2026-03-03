"use client";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

const OPTIONS = [
  { label: "30d", value: 30 },
  { label: "60d", value: 60 },
  { label: "90d", value: 90 },
] as const;

export function WindowSelector() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = parseInt(searchParams.get("days") ?? "90");

  function select(days: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("days", String(days));
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-1 bg-white rounded-lg p-1 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-slate-100">
      {OPTIONS.map(({ label, value }) => {
        const active = current === value;
        return (
          <button
            key={value}
            onClick={() => select(value)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
              active
                ? "bg-[#EC6341] text-white shadow-sm"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
