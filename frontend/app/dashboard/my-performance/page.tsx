"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { addDaysIso, firstOfMonthIso, isoDaysAgo, todayIso } from "@/lib/time";
import { useMe } from "../layout";
import PerformanceView, { type History, type Person, type SelfTasks, type Standups } from "./_View";

// ---------------------------------------------------------------------------
// MY PERFORMANCE (managers only): your OWN productivity, attendance, tasks, lateness, breaks and in-person meetings
// for a chosen period. It reads data that already exists and that you could already see in pieces:
//   GET /reports?userId=<you>          your row (same engine as Reports, so the numbers agree)
//   GET /tracker/history               your day-by-day record
//   GET /meetings/participation/history  your stand-up record (hidden if that feature is not available)
// Read-only. Your figures are shown here even though managers are left out of the TEAM productivity totals.
// ---------------------------------------------------------------------------

type Preset = "MONTH" | "LAST_MONTH" | "LAST_7" | "LAST_30" | "CUSTOM";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "MONTH", label: "This month" },
  { key: "LAST_MONTH", label: "Last month" },
  { key: "LAST_7", label: "Last 7 days" },
  { key: "LAST_30", label: "Last 30 days" },
  { key: "CUSTOM", label: "Custom range" },
];
const MAX_DAYS = 93;
const spanDays = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;

function rangeFor(preset: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const today = todayIso();
  if (preset === "LAST_7") return { from: isoDaysAgo(6), to: today };
  if (preset === "LAST_30") return { from: isoDaysAgo(29), to: today };
  if (preset === "LAST_MONTH") {
    const end = addDaysIso(firstOfMonthIso(), -1);
    return { from: `${end.slice(0, 8)}01`, to: end };
  }
  if (preset === "CUSTOM") return custom;
  return { from: firstOfMonthIso(), to: today };
}

export default function MyPerformancePage() {
  const me = useMe();
  const [preset, setPreset] = useState<Preset>("MONTH");
  const [custom, setCustom] = useState({ from: firstOfMonthIso(), to: todayIso() });
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const rangeError = !/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)
    ? "Pick both dates."
    : range.to < range.from ? "The end date can't be before the start date."
    : spanDays(range.from, range.to) > MAX_DAYS ? `Pick a range of ${MAX_DAYS} days or fewer.` : "";

  const [data, setData] = useState<{ key: string; person: Person | null; history: History | null; standups: Standups | null; selfTasks: SelfTasks | null; error?: string } | null>(null);
  const key = `${range.from}|${range.to}`;

  const load = useCallback(async () => {
    if (!me || rangeError) return;
    try {
      const [report, history, standups, selfTasks] = await Promise.all([
        apiGet<{ people: (Person & { userId: string })[] }>(`/reports?from=${range.from}&to=${range.to}&groupBy=person&userId=${me.id}`),
        apiGet<History>(`/tracker/history?from=${range.from}&to=${range.to}`),
        apiGet<Standups>("/meetings/participation/history").catch(() => null), // not available yet: the section simply does not show
        apiGet<SelfTasks>(`/tasks/self/summary?from=${range.from}&to=${range.to}`).catch(() => null), // not available yet: the section does not show
      ]);
      const person = report.people.find((p) => p.userId === me.id) ?? null;
      setData({ key, person, history, standups, selfTasks });
    } catch (e) {
      setData({ key, person: null, history: null, standups: null, selfTasks: null, error: (e as Error).message });
    }
  }, [me, range.from, range.to, rangeError, key]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  if (!me) return null;
  if (me.role !== "MANAGER") {
    return (
      <div>
        <p className="rounded-2xl bg-white p-6 text-sm text-slate-600 shadow-[var(--shadow-card)]">This page is for managers. Your own history is under <b>My History</b>.</p>
      </div>
    );
  }

  const current = data && data.key === key ? data : null;
  const rangeLabel = range.from === range.to ? range.from : `${range.from} to ${range.to}`;
  const tz = me.platform.timezone ?? "Asia/Kolkata";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-slate-400">Just you, as a manager</p>
          <h1 className="mt-0.5 text-2xl font-semibold tracking-tight text-slate-900">My performance</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="mp-preset">Period</label>
          <select id="mp-preset" value={preset} onChange={(e) => { const p = e.target.value as Preset; setPreset(p); if (p === "CUSTOM") setCustom(rangeFor(preset, custom)); }} className="rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-700">
            {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          {preset === "CUSTOM" && (
            <>
              <input type="date" aria-label="From" value={custom.from} max={todayIso()} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900" />
              <span className="text-sm text-slate-400">to</span>
              <input type="date" aria-label="To" value={custom.to} max={todayIso()} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900" />
            </>
          )}
        </div>
      </header>

      {rangeError && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">{rangeError}</p>}
      {current?.error && (
        <p className="flex items-center justify-between rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          Couldn&apos;t load your performance: {current.error}
          <button onClick={() => void load()} className="ml-3 rounded-lg bg-white px-3 py-1 text-xs font-medium ring-1 ring-red-200">Retry</button>
        </p>
      )}

      {!rangeError && !current && <div className="space-y-3" aria-busy="true"><div className="skeleton h-28" /><div className="skeleton h-64" /></div>}
      {!rangeError && current && !current.error && !current.person && (
        <p className="rounded-2xl bg-white p-6 text-sm text-slate-600 shadow-[var(--shadow-card)]">Nothing to show for {rangeLabel}: no working days or records.</p>
      )}
      {!rangeError && current?.person && (
        <PerformanceView person={current.person} history={current.history} standups={current.standups} selfTasks={current.selfTasks} tz={tz} rangeLabel={rangeLabel} />
      )}
    </div>
  );
}
