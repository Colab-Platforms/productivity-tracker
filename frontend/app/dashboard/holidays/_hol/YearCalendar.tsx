"use client";

import { useMemo } from "react";
import { MONTHS, KIND_LABEL, type Entry } from "./model";

// Twelve small month grids. Fixed holidays are solid green, optional ones amber, drafts have a dashed outline. A day with two entries shows
// both in its tooltip. Pure display: the server decides what is a holiday.
const DOW = ["M", "T", "W", "T", "F", "S", "S"];

export default function YearCalendar({ year, entries, today, onPick }: { year: number; entries: Entry[]; today: string; onPick?: (e: Entry) => void }) {
  const byDay = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return m;
  }, [entries]);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="year-calendar">
      {MONTHS.map((name, mi) => {
        const first = new Date(Date.UTC(year, mi, 1));
        const lead = (first.getUTCDay() + 6) % 7; // Monday first
        const days = new Date(Date.UTC(year, mi + 1, 0)).getUTCDate();
        const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
        return (
          <section key={name} aria-label={`${name} ${year}`} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
            <h3 className="mb-2 text-sm font-semibold text-slate-900">{name}</h3>
            <div className="grid grid-cols-7 gap-1 text-center text-[11px]">
              {DOW.map((d, i) => <span key={i} className="pb-1 font-medium text-slate-400">{d}</span>)}
              {cells.map((d, i) => {
                if (d === null) return <span key={`b${i}`} />;
                const iso = `${year}-${String(mi + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                const list = byDay.get(iso);
                const e = list?.[0];
                const cls = e
                  ? e.status === "DRAFT"
                    ? "border border-dashed border-indigo-400 bg-indigo-50 text-indigo-700"
                    : e.kind === "FIXED"
                      ? "bg-indigo-600 text-white"
                      : "bg-amber-100 text-amber-800"
                  : iso === today
                    ? "ring-1 ring-indigo-400 text-slate-900"
                    : "text-slate-600";
                const title = list ? list.map((x) => `${x.name} · ${KIND_LABEL[x.kind]}${x.status === "DRAFT" ? " (draft)" : ""}`).join("\n") : undefined;
                return e ? (
                  <button key={iso} type="button" title={title} aria-label={`${iso}: ${title}`} onClick={() => onPick?.(e)} className={`h-7 rounded-md text-[12px] font-medium ${cls}`}>
                    {d}
                  </button>
                ) : (
                  <span key={iso} className={`flex h-7 items-center justify-center rounded-md text-[12px] ${cls}`}>{d}</span>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600" aria-label="Legend">
      <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-indigo-600" /> Fixed holiday</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-amber-200" /> Optional holiday</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded border border-dashed border-indigo-400 bg-indigo-50" /> Draft (not published)</span>
    </div>
  );
}
