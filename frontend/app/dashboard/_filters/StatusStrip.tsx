"use client";

// Clickable status counts for a people list (User Management). Every number is counted by the SERVER for the same people the list shows, with the same
// filters except the status itself (GET /admin/users/status-counts), so a count and the list behind it can never differ. Clicking one sets the shared
// "Employment status" filter (which lives in the address, so Back works); the list below reloads for exactly that status. Groups are several statuses
// joined by commas ("SUSPENDED,EXITED"); single statuses split them, so Suspended and Exited (and Invited and Candidates) are never merged.
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

type Counts = { total: number; byStatus: Record<string, number> };

const CHIPS: { value: string; label: string; parts: string[]; sub?: boolean }[] = [
  { value: "", label: "All", parts: [] },
  { value: "ACTIVE", label: "Active", parts: ["ACTIVE"] },
  { value: "SUSPENDED,EXITED", label: "Inactive", parts: ["SUSPENDED", "EXITED"] },
  { value: "SUSPENDED", label: "Suspended", parts: ["SUSPENDED"], sub: true },
  { value: "EXITED", label: "Exited", parts: ["EXITED"], sub: true },
  { value: "INVITED,CANDIDATE", label: "Not started yet", parts: ["INVITED", "CANDIDATE"] },
  { value: "INVITED", label: "Invited", parts: ["INVITED"], sub: true },
  { value: "CANDIDATE", label: "Candidates", parts: ["CANDIDATE"], sub: true },
];

/** `query` = the list's own query string WITHOUT the status; `refresh` changes whenever the list reloads, so the counts follow adds and edits. */
export default function StatusStrip({ query, status, onPick, refresh }: { query: string; status: string; onPick: (status: string) => void; refresh?: unknown }) {
  const [counts, setCounts] = useState<Counts | null>(null);
  useEffect(() => {
    let live = true;
    apiGet<Counts>(`/admin/users/status-counts${query ? `?${query}` : ""}`)
      .then((c) => live && setCounts(c))
      .catch(() => live && setCounts(null));
    return () => { live = false; };
  }, [query, refresh]);
  const of = (parts: string[]) => (counts ? (parts.length === 0 ? counts.total : parts.reduce((n, s) => n + (counts.byStatus[s] ?? 0), 0)) : null);
  return (
    <div role="group" aria-label="Show employees by status" data-testid="status-strip" className="flex flex-wrap items-center gap-1.5">
      {CHIPS.map((c) => {
        const on = status === c.value;
        const n = of(c.parts);
        return (
          <button
            key={c.value || "all"}
            type="button"
            aria-pressed={on}
            data-testid={`status-${(c.value || "all").toLowerCase().replace(",", "-")}`}
            onClick={() => onPick(c.value)}
            title={on ? "Showing this status. Click All to clear." : `Show ${c.label.toLowerCase()} employees`}
            className={`h-8 rounded-full border px-3 text-xs font-medium ${c.sub ? "ml-0.5" : ""} ${on ? "border-indigo-600 bg-indigo-600 text-white" : "border-indigo-100 bg-white text-slate-600 hover:bg-[var(--brand-50)]"}`}
          >
            {c.label}
            <span className={`ml-1.5 tabular-nums ${on ? "text-white/80" : "text-slate-400"}`}>{n === null ? "…" : n}</span>
          </button>
        );
      })}
    </div>
  );
}
