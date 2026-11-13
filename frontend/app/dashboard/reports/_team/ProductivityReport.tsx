"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { filterQuery, type Filters as HrFilterState } from "../../_filters/useHrFilters";
import { apiGet } from "@/lib/api";
import { dayLabel, downloadCsv } from "./format";
import { dayOf, downloadReportXlsx, secondsOfDay, type Col } from "./reportXlsx";
import { describeFilters, titleCase } from "./exportMeta";
import ExportButtons from "./ExportButtons";
import { useMe } from "../../layout";
import { PRESETS, rangeFor, type Preset } from "./ranges";
import TargetsPanel from "./TargetsPanel";

// Task productivity: tasks completed ÷ the daily target set by HR/Admin.
// Data: GET /team-attendance/productivity and /productivity/hourly. A task counts once, in the day and hour it was
// actually completed. A missing target is shown as "Target not configured"; missing task data as "No task data
// available" — neither is ever shown as 0%.

type Day = { date: string; completed: number | null; percent: number | null; state: "DATA" | "NO_TASK_DATA" };
type Person = {
  userId: string; name: string; employeeCode: string | null; teamName: string | null;
  projects?: string[]; reportingManager?: string | null; // added for the Excel export
  targetPerDay: number | null; targetSource: "PERSON" | "TEAM" | "COMPANY" | null;
  daysWithData: number; completedTotal: number | null; targetTotal: number | null; overallPercent: number | null; days: Day[];
};
type Productivity = { generatedAt: string; timezone: string; today: string; from: string; to: string; targetsReady: boolean; scope?: { orgTotal: number; filteredTotal: number }; people: Person[] };
// The tasks behind the report (GET /team-attendance/productivity/tasks), fetched when Excel is exported.
type TaskRow = {
  id: string; userId: string; employee: string; employeeCode: string | null; project: string | null; reportingManager: string | null; taggedManager: string | null;
  title: string; description: string | null; date: string; priority: string; hoursSpent: number | null; progress: string; approvalStatus: string; completedAt: string | null; counted: boolean;
};
type Hourly = { date: string; people: { userId: string; name: string; employeeCode: string | null; teamName: string | null; hours: number[]; total: number }[] };

const SOURCE: Record<string, string> = { PERSON: "personal", TEAM: "team", COMPANY: "company" };
const select = "rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-700";
const th = "px-3 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 whitespace-nowrap";
const slot = (h: number) => `${String(h).padStart(2, "0")}:00`;

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

const pctClass = (p: number | null) => (p === null ? "text-slate-400" : p >= 100 ? "text-emerald-600" : p >= 70 ? "text-amber-600" : "text-red-600");

// `self` = an employee's own report: the same table and downloads, read from /my-reports (locked to the signed-in person), opening on This month, with no team-only parts (hourly grid, targets).
export default function ProductivityReport({ canSetTargets, filters, ready = true, onScope, self = false }: { canSetTargets: boolean; filters?: HrFilterState; ready?: boolean; onScope?: (s: { orgTotal: number; filteredTotal: number } | null) => void; self?: boolean }) {
  const base = self ? "/my-reports" : "/team-attendance";
  // company, project, reporting manager and name/ID search come from the shared bar on the Reports page (the table, the KPIs and the CSV all use that list)
  const hrQuery = filters ? filterQuery(filters) : "";
  // Always opens on Today (nothing is restored from a previous visit). With no dates the server answers for today in the company timezone.
  const me = useMe();
  const [preset, setPreset] = useState<Preset>(self ? "thismonth" : "today");
  const [single, setSingle] = useState("");
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [today, setToday] = useState("");
  const [data, setData] = useState<Productivity | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [reloadTargets, setReloadTargets] = useState(0);

  const [hourDate, setHourDate] = useState("");
  const [hourly, setHourly] = useState<Hourly | null>(null);
  const [hourError, setHourError] = useState("");

  const range = useMemo(() => {
    if (preset === "single") return single ? { from: single, to: single } : null;
    if (preset === "custom") return custom.from && custom.to ? custom : null;
    return today ? rangeFor(preset, today) : { from: "", to: "" };
  }, [preset, single, custom, today]);

  const load = useCallback(async () => {
    if (!range) return;
    const qs = new URLSearchParams();
    if (range.from) qs.set("from", range.from);
    if (range.to) qs.set("to", range.to);
    try {
      const d = await apiGet<Productivity>(`${base}/productivity?${qs.toString()}${hrQuery ? `&${hrQuery}` : ""}`);
      setData(d);
      onScope?.(d.scope ?? null);
      setToday(d.today);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range, hrQuery, onScope, base]);

  useEffect(() => { if (!ready) return; const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load, reloadTargets, ready]);

  const loadHourly = useCallback(async (d: string) => {
    try {
      const parts = [d ? `date=${d}` : "", hrQuery].filter(Boolean).join("&");
      const h = await apiGet<Hourly>(`/team-attendance/productivity/hourly${parts ? `?${parts}` : ""}`);
      setHourly(h);
      setHourError("");
      if (!d) setHourDate(h.date);
    } catch (e) {
      setHourError((e as Error).message);
    }
  }, [hrQuery]);
  useEffect(() => { if (!ready || self) return; const t = setTimeout(() => void loadHourly(hourDate), 0); return () => clearTimeout(t); }, [hourDate, loadHourly, ready, self]);

  const k = useMemo(() => {
    const people = data?.people ?? [];
    const withTarget = people.filter((p) => p.targetTotal !== null && p.completedTotal !== null);
    const done = withTarget.reduce((s, p) => s + (p.completedTotal ?? 0), 0);
    const tgt = withTarget.reduce((s, p) => s + (p.targetTotal ?? 0), 0);
    return {
      people: people.length,
      completed: people.reduce((s, p) => s + (p.completedTotal ?? 0), 0),
      percent: tgt > 0 ? Math.round((done / tgt) * 1000) / 10 : null,
      noTarget: people.filter((p) => p.targetPerDay === null).length,
    };
  }, [data]);

  const hourWindow = useMemo(() => {
    const rows = hourly?.people ?? [];
    let lo = 24;
    let hi = -1;
    for (const r of rows) r.hours.forEach((c, h) => { if (c > 0) { lo = Math.min(lo, h); hi = Math.max(hi, h); } });
    return hi < 0 ? [] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }, [hourly]);

  function exportCsv() {
    if (!data) return;
    downloadCsv(
      `task-productivity-${data.from}_to_${data.to}.csv`,
      ["Employee", "Employee ID", "Team", "Daily target", "Target level", "Days with data", "Tasks completed", "Productivity %"],
      data.people.map((p) => [p.name, p.employeeCode, p.teamName, p.targetPerDay ?? "Target not configured", p.targetSource ? SOURCE[p.targetSource] : "", p.daysWithData, p.completedTotal ?? "No task data available", p.overallPercent ?? (p.targetPerDay === null ? "Target not configured" : "No task data available")])
    );
  }

  // Excel: three sheets. "Productivity" = the report (one row per person, the same figures as the CSV and the screen). "Daily" = each person's
  // day by day figures. "Tasks" = every task behind the report for the same people, dates and filters (fetched now, so the complete filtered
  // data is exported, not what is on screen). "Counted in productivity" uses the report's own rule, so the number of Yes rows equals the
  // "Tasks completed" total.
  async function exportXlsx() {
    if (!data) return;
    const tz = data.timezone;
    const qs = new URLSearchParams({ from: data.from, to: data.to });
    const tasks = await apiGet<{ tasks: TaskRow[] }>(`${base}/productivity/tasks?${qs.toString()}${hrQuery ? `&${hrQuery}` : ""}`);

    const people: Col[] = [
      { header: "Employee ID", width: 14 }, { header: "Employee", width: 24 }, { header: "Team", width: 20 }, { header: "Project(s)", width: 28 }, { header: "Reporting manager", width: 22 },
      { header: "Daily target", kind: "int", width: 12 }, { header: "Target level", width: 13 }, { header: "Days with data", kind: "int", width: 13 },
      { header: "Tasks completed", kind: "int", width: 14 }, { header: "Productivity %", kind: "percent", width: 14, note: "Tasks completed divided by the daily target on the days with task data. Text means there is nothing to calculate (target not set, or no task data); it is never shown as 0%." },
    ];
    const peopleRows = data.people.map((p) => [
      p.employeeCode, p.name, p.teamName, (p.projects ?? []).join(", ") || null, p.reportingManager ?? null,
      p.targetPerDay ?? "Target not configured", p.targetSource ? SOURCE[p.targetSource] : null, p.daysWithData,
      p.completedTotal ?? "No task data available", p.overallPercent ?? (p.targetPerDay === null ? "Target not configured" : "No task data available"),
    ]);

    const daily: Col[] = [
      { header: "Employee ID", width: 14 }, { header: "Employee", width: 24 }, { header: "Date", kind: "date", width: 13 },
      { header: "Tasks completed", kind: "int", width: 14 }, { header: "Productivity %", kind: "percent", width: 14 }, { header: "Data", width: 18 },
    ];
    const dailyRows = data.people.flatMap((p) => p.days.map((d) => [p.employeeCode, p.name, d.date, d.completed, d.percent, d.state === "DATA" ? "Task data" : "No task data available"]));

    const taskCols: Col[] = [
      { header: "Employee ID", width: 14 }, { header: "Employee", width: 24 }, { header: "Project", width: 24 }, { header: "Reporting manager", width: 22 },
      { header: "Tagged manager (approver)", width: 24, note: "The manager this task was sent to for approval." },
      { header: "Task", width: 40, wrap: true }, { header: "Details", width: 40, wrap: true }, { header: "Task date", kind: "date", width: 13 },
      { header: "Priority", width: 11 }, { header: "Hours spent", kind: "decimal", width: 12 }, { header: "Progress", width: 13 }, { header: "Approval status", width: 14 },
      { header: "Completed on", kind: "date", width: 13 }, { header: "Completed at", kind: "time", width: 12 },
      { header: "Counted in productivity", width: 14, note: "Yes = the report counts it: completed, approved, finished inside these dates and not rated below the completed threshold." },
    ];
    const taskRows = tasks.tasks.map((t) => [
      t.employeeCode, t.employee, t.project, t.reportingManager, t.taggedManager, t.title, t.description, t.date,
      titleCase(t.priority), t.hoursSpent, titleCase(t.progress), titleCase(t.approvalStatus), dayOf(t.completedAt, tz), secondsOfDay(t.completedAt, tz), t.counted ? "Yes" : "No",
    ]);

    await downloadReportXlsx(`task-productivity-${data.from}_to_${data.to}.xlsx`, [
      { name: "Productivity", cols: people, rows: peopleRows },
      { name: "Daily", cols: daily, rows: dailyRows },
      { name: "Tasks", cols: taskCols, rows: taskRows },
    ], {
      report: "Task Productivity",
      period: data.from === data.to ? dayLabel(data.from) : `${dayLabel(data.from)} to ${dayLabel(data.to)}`,
      filters: await describeFilters(filters),
      exportedAt: new Date(), exportedBy: me ? `${me.firstName} ${me.lastName}`.trim() : null, timezone: tz,
      totals: [["People", k.people], ["Tasks completed (report total)", k.completed], ["Overall productivity %", k.percent === null ? "n/a" : k.percent], ["Task rows exported", taskRows.length], ["Task rows counted in productivity", tasks.tasks.filter((t) => t.counted).length]],
    });
  }

  return (
    <div className="space-y-5">
      {data && !data.targetsReady && (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Daily targets are not set up on this server yet, so percentages show as unavailable. Task counts are still shown.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
        <select value={preset} onChange={(e) => { setLoading(true); setPreset(e.target.value as Preset); }} className={select} aria-label="Date range">
          {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {preset === "single" && <input type="date" value={single} max={today || undefined} onChange={(e) => { setLoading(true); setSingle(e.target.value); }} className={select} aria-label="Date" />}
        {preset === "custom" && (
          <>
            <input type="date" value={custom.from} max={today || undefined} onChange={(e) => { setLoading(true); setCustom((c) => ({ ...c, from: e.target.value })); }} className={select} aria-label="From" />
            <span className="text-sm text-slate-400">to</span>
            <input type="date" value={custom.to} max={today || undefined} onChange={(e) => { setLoading(true); setCustom((c) => ({ ...c, to: e.target.value })); }} className={select} aria-label="To" />
          </>
        )}
        <div className="ml-auto">
          <ExportButtons onCsv={exportCsv} onExcel={exportXlsx} disabled={!data || data.people.length === 0} />
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>Couldn&apos;t load productivity: {error}</span>
          <button onClick={() => void load()} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium hover:bg-red-100">Retry</button>
        </div>
      )}

      <div className={`grid grid-cols-2 gap-3 sm:grid-cols-4 ${loading ? "opacity-60" : ""}`}>
        <Kpi label="People" value={data ? String(k.people) : "—"} />
        <Kpi label="Tasks completed" value={data ? String(k.completed) : "—"} sub="counted in the hour they were finished" />
        <Kpi label="Team productivity" value={k.percent === null ? "—" : `${k.percent}%`} sub={k.percent === null ? "needs a target and task data" : "completed ÷ daily targets"} />
        <Kpi label="No target set" value={data ? String(k.noTarget) : "—"} sub="people" />
      </div>

      <section className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <div className="overflow-x-auto">
          {loading && !data ? (
            <div className="space-y-2 p-6" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10" />)}</div>
          ) : data && data.people.length === 0 ? (
            <p className="px-6 py-12 text-center text-sm text-slate-500">No one reports to you yet.</p>
          ) : data ? (
            <table className={`w-full min-w-[820px] text-sm ${loading ? "opacity-60" : ""}`}>
              <thead className="bg-slate-50">
                <tr>
                  <th className={th}>Employee</th>
                  <th className={th}>Team</th>
                  <th className={`${th} text-right`}>Daily target</th>
                  <th className={`${th} text-right`}>Days with data</th>
                  <th className={`${th} text-right`}>Completed</th>
                  <th className={`${th} text-right`}>Productivity</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <Fragment key={p.userId}>
                    <tr className="cursor-pointer border-t border-indigo-50 hover:bg-slate-50" onClick={() => setOpen(open === p.userId ? null : p.userId)}>
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-slate-900">{p.name}</p>
                        <p className="text-xs text-slate-400">{p.employeeCode ?? "—"}</p>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{p.teamName ?? "—"}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-900">
                        {p.targetPerDay ?? <span className="text-xs text-slate-400">Target not configured</span>}
                        {p.targetSource && <span className="ml-1 text-xs text-slate-400">({SOURCE[p.targetSource]})</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{p.daysWithData}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-900">{p.completedTotal ?? <span className="text-xs text-slate-400">No task data available</span>}</td>
                      <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${pctClass(p.overallPercent)}`}>
                        {p.overallPercent !== null ? `${p.overallPercent}%` : <span className="text-xs font-normal text-slate-400">{p.targetPerDay === null ? "Target not configured" : "No task data available"}</span>}
                      </td>
                    </tr>
                    {open === p.userId && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={6} className="px-6 py-3">
                          <table className="w-full max-w-xl text-xs">
                            <thead><tr className="text-slate-400"><th className="py-1 text-left font-medium">Day</th><th className="py-1 text-right font-medium">Completed</th><th className="py-1 text-right font-medium">Target</th><th className="py-1 text-right font-medium">Productivity</th></tr></thead>
                            <tbody>
                              {[...p.days].reverse().map((d) => (
                                <tr key={d.date} className="border-t border-indigo-50">
                                  <td className="py-1 text-slate-700">{dayLabel(d.date)}</td>
                                  <td className="py-1 text-right tabular-nums">{d.completed ?? <span className="text-slate-400">No task data available</span>}</td>
                                  <td className="py-1 text-right tabular-nums text-slate-500">{p.targetPerDay ?? "—"}</td>
                                  <td className={`py-1 text-right tabular-nums font-medium ${pctClass(d.percent)}`}>{d.percent !== null ? `${d.percent}%` : "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
        <p className="px-6 pb-5 pt-3 text-xs text-slate-400">
          Counted: tasks that are completed and approved, with a completion time, not graded partial or failed — each once, in the day it was finished, for the person it was created for. Click a person for the daily trend. A dash or a message means nothing was recorded, never zero.
        </p>
      </section>

      {/* hourly */}
      {!self && <section className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Tasks completed by hour</h2>
            <p className="mt-0.5 text-sm text-slate-500">How many tasks each person finished in each clock hour (counts only, no hourly target).</p>
          </div>
          <input type="date" value={hourDate} max={today || undefined} onChange={(e) => e.target.value && setHourDate(e.target.value)} className={select} aria-label="Day" />
        </div>
        {hourError && <p className="mx-6 mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Couldn&apos;t load the hourly view: {hourError}</p>}
        <div className="mt-4 overflow-x-auto">
          {hourly && hourWindow.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-slate-500">No tasks with a completion time on this day.</p>
          ) : hourly ? (
            <table className="w-full text-sm" style={{ minWidth: 320 + hourWindow.length * 64 }}>
              <thead className="bg-slate-50">
                <tr>
                  <th className={th}>Employee</th>
                  {hourWindow.map((h) => <th key={h} className={`${th} text-center`}>{slot(h)}–{slot(h + 1)}</th>)}
                  <th className={`${th} text-right`}>Total</th>
                </tr>
              </thead>
              <tbody>
                {hourly.people.map((r) => (
                  <tr key={r.userId} className="border-t border-indigo-50">
                    <td className="px-3 py-2.5"><p className="font-medium text-slate-900">{r.name}</p><p className="text-xs text-slate-400">{r.employeeCode ?? "—"}</p></td>
                    {hourWindow.map((h) => <td key={h} className={`px-3 py-2.5 text-center tabular-nums ${r.hours[h] ? "font-semibold text-slate-900" : "text-slate-300"}`}>{r.hours[h] || "·"}</td>)}
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">{r.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="space-y-2 p-6" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-10" />)}</div>
          )}
        </div>
        <div className="h-4" />
      </section>}

      {canSetTargets && !self && <TargetsPanel onChanged={() => setReloadTargets((n) => n + 1)} />}
    </div>
  );
}
