"use client";

// Task reports: how many repetitive-task flags were raised in a period, per employee and per project, the most repeated descriptions, and how many were
// reviewed, still open or dismissed as false positives. Read only; it is part of the Task productivity report and adds no new employee records.
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";

type Summary = {
  ready: boolean; from: string; to: string;
  totals: { flags: number; open: number; reviewed: number; new: number; underReview: number; valid: number; falsePositive: number; resolved: number; escalated: number };
  byEmployee: { key: string; label: string; flags: number; open: number; repeats: number }[];
  byProject: { key: string; label: string; flags: number; open: number; repeats: number }[];
  topTitles: { title: string; flags: number; repeats: number }[];
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function RepetitionSummary() {
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(() => iso(new Date()));
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    apiGet<Summary>(`/tasks/repetition/summary?from=${from}&to=${to}`).then((d) => live && setData(d)).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [from, to]);

  if (error) return null; // an employee or an old server: this card is for managers, HR and Admin only
  if (!data || !data.ready) return null;
  const t = data.totals;
  const tile = (label: string, v: number, tone = "text-slate-900") => (
    <div className="rounded-xl border border-indigo-100 px-3 py-2"><p className="text-xs text-slate-500">{label}</p><p className={`text-xl font-semibold tabular-nums ${tone}`}>{v}</p></div>
  );
  return (
    <section data-testid="repetition-summary" className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Repetitive task flags</h2>
          <p className="mt-0.5 text-xs text-slate-500">Flags raised in the period. A flag never changes a rating, pay, attendance or productivity score; the figures above are not affected.</p>
        </div>
        <div className="flex items-end gap-2 text-xs text-slate-500">
          <label>From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="mt-1 block rounded-xl border border-indigo-200 px-2 py-1.5 text-sm text-slate-900" /></label>
          <label>To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="mt-1 block rounded-xl border border-indigo-200 px-2 py-1.5 text-sm text-slate-900" /></label>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {tile("Total flags", t.flags)}{tile("Open (new + under review)", t.open, "text-amber-700")}{tile("Reviewed", t.reviewed)}{tile("Valid repetition", t.valid, "text-violet-700")}{tile("False positives", t.falsePositive)}{tile("Escalated to HR", t.escalated, "text-sky-700")}
      </div>
      {t.flags === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No repetitive-task flags in this period.</p>
      ) : (
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">By employee</h3>
            <ul className="mt-2 divide-y divide-indigo-50 text-sm">{data.byEmployee.slice(0, 10).map((r) => <li key={r.key} className="flex justify-between gap-2 py-1.5"><span className="truncate text-slate-800">{r.label}</span><span className="tabular-nums text-slate-600">{r.flags} {r.flags === 1 ? "flag" : "flags"}{r.open ? ` · ${r.open} open` : ""}</span></li>)}</ul>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">By project</h3>
            <ul className="mt-2 divide-y divide-indigo-50 text-sm">{data.byProject.slice(0, 10).map((r) => <li key={r.key} className="flex justify-between gap-2 py-1.5"><span className="truncate text-slate-800">{r.label}</span><span className="tabular-nums text-slate-600">{r.flags} {r.flags === 1 ? "flag" : "flags"} · {r.repeats} entries</span></li>)}</ul>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Most repeated descriptions</h3>
            <ul className="mt-2 divide-y divide-indigo-50 text-sm">{data.topTitles.map((r) => <li key={r.title} className="flex justify-between gap-2 py-1.5"><span className="break-words text-slate-800 [overflow-wrap:anywhere]">{r.title}</span><span className="shrink-0 tabular-nums text-slate-600">{r.repeats}×</span></li>)}</ul>
          </div>
        </div>
      )}
    </section>
  );
}
