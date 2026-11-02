"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiGet } from "@/lib/api";
import { clockTime, dayLabel, dayShort, downloadCsv, hmFromHours, hmFromMinutes } from "./format";
import { PRESETS, rangeFor, type Preset } from "./ranges";
import { downloadAttendanceXlsx, type Cell } from "./xlsx";

// Attendance report: one row per person per day for a date range.
// Data: GET /team-attendance/attendance. Finished days use the same attendance engine as salary and Reports, so the
// figures agree with those screens. Today is shown honestly: people still working are Present, and people who have
// not clocked in yet are "Not clocked in yet", not absent (a later clock-in would make them present).

type Row = {
  userId: string; name: string; employeeCode: string | null; teamName: string | null; date: string;
  shiftName: string | null; shiftStart: string | null; shiftEnd: string | null;
  loginAt: string | null; logoutAt: string | null; workedHours: number | null; productiveHours: number | null; breakHours: number | null; washroomHours?: number | null; breakBudgetSeconds: number;
  stillWorking: boolean; autoClosed: boolean; note: string | null;
  status: string; statusLabel: string; leaveType: string | null; holidayName: string | null;
  lateMinutes: number | null; earlyDepartureMinutes: number | null; tasksCompleted: number;
  tasksPlanned: number | null; tasksApproved: number | null; // null = no tasks that day (exported blank)
};
type Report = {
  generatedAt: string; timezone: string; today: string; from: string; to: string;
  options: { people: { id: string; name: string; code: string | null }[]; teams: { id: string; name: string }[]; shifts: string[] };
  kpis: { employees: number; present: number; halfDay: number; absent: number; notYet: number; workingDays: number; attendancePct: number | null; totalWorkedHours: number; avgWorkedHours: number | null };
  rows: Row[];
};
type Filters = { userId: string; teamId: string; shift: string; status: string };
const NO_FILTERS: Filters = { userId: "", teamId: "", shift: "", status: "" };

const STATUSES: [string, string][] = [["PRESENT", "Present"], ["HALF_DAY", "Half day"], ["ABSENT", "Absent"], ["NOT_CLOCKED_IN", "Not clocked in yet"], ["LEAVE", "Leave"], ["HOLIDAY", "Holiday"], ["WEEK_OFF", "Week-off"], ["NOT_TRACKED", "Not tracked"]];
const STATUS_STYLE: Record<string, string> = {
  PRESENT: "bg-emerald-50 text-emerald-700", HALF_DAY: "bg-amber-50 text-amber-700", ABSENT: "bg-rose-50 text-rose-600",
  NOT_CLOCKED_IN: "bg-amber-50 text-amber-700", LEAVE: "bg-sky-50 text-sky-700", HOLIDAY: "bg-violet-50 text-violet-700",
  WEEK_OFF: "bg-slate-100 text-slate-600", NOT_TRACKED: "bg-slate-100 text-slate-500",
};

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const select = "w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-700";
const th = "px-4 py-3 text-left text-xs font-medium text-slate-500 whitespace-nowrap";

// One line of plain words for the Remarks column, built only from what was actually recorded.
function remarks(r: Row): string {
  const out: string[] = [];
  if (r.stillWorking) out.push("Still working");
  if (r.autoClosed) out.push("Auto clocked out");
  if (r.status === "LEAVE") out.push(r.leaveType ? `${r.leaveType.toLowerCase()} leave` : "On leave");
  if (r.status === "HOLIDAY" && r.holidayName) out.push(r.holidayName);
  if (r.note && !r.stillWorking && r.status !== "LEAVE" && r.status !== "HOLIDAY") out.push(r.note);
  if (r.lateMinutes && r.lateMinutes > 0) out.push(`Late ${hmFromMinutes(r.lateMinutes)}`);
  if (r.earlyDepartureMinutes && r.earlyDepartureMinutes > 0) out.push(`Left ${hmFromMinutes(r.earlyDepartureMinutes)} early`);
  if (r.tasksCompleted > 0) out.push(`${r.tasksCompleted} task${r.tasksCompleted === 1 ? "" : "s"} done`);
  return out.join(" · ");
}

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

function Kpi({ tone, icon, label, value, sub }: { tone: "blue" | "green" | "red" | "purple"; icon: ReactNode; label: string; value: string; sub: string }) {
  const t = {
    blue: "border-indigo-100 bg-indigo-50/70 text-indigo-600", green: "border-emerald-100 bg-emerald-50/70 text-emerald-600",
    red: "border-rose-100 bg-rose-50/70 text-rose-500", purple: "border-violet-100 bg-violet-50/70 text-violet-600",
  }[tone];
  return (
    <div className={`rounded-xl border p-4 ${t.split(" ").slice(0, 2).join(" ")}`}>
      <div className="flex items-center gap-2 text-sm text-slate-600">
        <span className={`flex h-8 w-8 items-center justify-center rounded-full bg-white/80 ${t.split(" ")[2]}`}>{icon}</span>
        {label}
      </div>
      <p className="mt-3 text-3xl font-semibold tabular-nums text-slate-900">{value}</p>
      <p className="mt-1 text-sm text-slate-500">{sub}</p>
    </div>
  );
}

export default function AttendanceReport() {
  const [preset, setPreset] = useState<Preset>("today");
  const [single, setSingle] = useState("");
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [draft, setDraft] = useState<Filters>(NO_FILTERS); // what the dropdowns show
  const [applied, setApplied] = useState<Filters>(NO_FILTERS); // what the report is using (changes on "Apply Filters")
  const [menu, setMenu] = useState(false);

  const [today, setToday] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // The company's "today" comes from the first answer; until then ask for the server default (today).
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
    if (applied.userId) qs.set("userId", applied.userId);
    if (applied.teamId) qs.set("teamId", applied.teamId);
    if (applied.shift) qs.set("shift", applied.shift);
    if (applied.status) qs.set("status", applied.status);
    try {
      const data = await apiGet<Report>(`/team-attendance/attendance?${qs.toString()}`);
      setReport(data);
      setToday(data.today);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range, applied]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // A day that includes today has people still working: keep it fresh while the page stays open.
  const includesToday = !!report && report.to >= report.today;
  useEffect(() => {
    if (!includesToday) return;
    const poll = setInterval(() => void load(), 60000);
    return () => clearInterval(poll);
  }, [includesToday, load]);

  const rows = report?.rows ?? [];
  const k = report?.kpis;
  const tz = report?.timezone ?? "Asia/Kolkata";
  const singleDay = !!report && report.from === report.to;
  const unit = singleDay ? "employees" : "days";
  const hasShifts = rows.some((r) => r.shiftName);
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);

  function pick(p: Preset) {
    setLoading(true);
    setPreset(p);
  }
  function reset() {
    setLoading(true);
    setPreset("today");
    setSingle("");
    setCustom({ from: "", to: "" });
    setDraft(NO_FILTERS);
    setApplied(NO_FILTERS);
  }

  // One table for both downloads, so the CSV and the Excel file always agree. The task columns run Planned,
  // Approved, Pending, then "Tasks completed", then Remarks; Pending Tasks = planned - completed (a live formula in the Excel file).
  const EXPORT_HEADER = ["Employee ID", "Employee", "Team", "Date", "Shift", "Check-in", "Check-out", "Working", "Productive", "Break", "Washroom", "Break over allowance", "Status", "Late arrival", "Early departure", "Total Tasks Planned Today", "Tasks Approved Today", "Pending Tasks", "Tasks completed", "Remarks"];
  function exportRows(): Cell[][] {
    return rows.map((r) => [
      r.employeeCode, r.name, r.teamName, r.date, r.shiftName ? `${r.shiftName}${r.shiftStart && r.shiftEnd ? ` (${r.shiftStart}-${r.shiftEnd})` : ""}` : "Not assigned",
      clockTime(r.loginAt, tz), r.stillWorking ? "Working" : clockTime(r.logoutAt, tz), hmFromHours(r.workedHours), hmFromHours(r.productiveHours), hmFromHours(r.breakHours), hmFromHours(r.washroomHours ?? null),
      r.breakHours !== null && r.breakHours * 3600 > r.breakBudgetSeconds ? hmFromHours(r.breakHours - r.breakBudgetSeconds / 3600) : "",
      r.statusLabel, hmFromMinutes(r.lateMinutes), hmFromMinutes(r.earlyDepartureMinutes),
      r.tasksPlanned, r.tasksApproved, r.tasksPlanned === null ? null : r.tasksPlanned - r.tasksCompleted, r.tasksCompleted, remarks(r),
    ]);
  }
  function exportCsv() {
    setMenu(false);
    if (!report) return;
    downloadCsv(`attendance-${report.from}_to_${report.to}.csv`, EXPORT_HEADER, exportRows());
  }
  function exportXlsx() {
    setMenu(false);
    if (!report) return;
    void downloadAttendanceXlsx(`attendance-${report.from}_to_${report.to}.xlsx`, "Attendance", EXPORT_HEADER, exportRows());
  }

  return (
    <section className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
      <header className="border-b border-indigo-50 px-6 py-4">
        <h2 className="text-base font-semibold text-slate-900">Attendance Report</h2>
        <p className="mt-0.5 text-sm text-slate-500">Present and absent days from real clock-ins. Present = clocked in and working that day; absent = no clock-in on a working day.</p>
      </header>

      <div className="space-y-5 px-6 py-5">
        {/* date presets */}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Date range">
          {PRESETS.map(([v, l]) => (
            <button
              key={v}
              onClick={() => pick(v)}
              aria-pressed={preset === v}
              className={`rounded-full border px-3.5 py-1.5 text-sm transition ${preset === v ? "border-indigo-600 bg-indigo-600 text-white" : "border-indigo-100 bg-white text-slate-700 hover:bg-slate-50"}`}
            >
              {titleCase(l)}
            </button>
          ))}
        </div>

        {preset === "single" && (
          <input type="date" value={single} max={today || undefined} onChange={(e) => { setLoading(true); setSingle(e.target.value); }} className="rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-700" aria-label="Date" />
        )}
        {preset === "custom" && (
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={custom.from} max={today || undefined} onChange={(e) => { setLoading(true); setCustom((c) => ({ ...c, from: e.target.value })); }} className="rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-700" aria-label="From" />
            <span className="text-sm text-slate-400">to</span>
            <input type="date" value={custom.to} max={today || undefined} onChange={(e) => { setLoading(true); setCustom((c) => ({ ...c, to: e.target.value })); }} className="rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-700" aria-label="To" />
          </div>
        )}

        {/* filters */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="block w-52 text-xs text-slate-500">
            Employee
            <select value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: e.target.value })} className={`${select} mt-1`}>
              <option value="">All Employees</option>
              {report?.options.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.code ? ` (${p.code})` : ""}</option>)}
            </select>
          </label>
          <label className="block w-44 text-xs text-slate-500">
            Team
            <select value={draft.teamId} onChange={(e) => setDraft({ ...draft, teamId: e.target.value })} className={`${select} mt-1`}>
              <option value="">All Teams</option>
              {report?.options.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          {report && report.options.shifts.length > 0 && (
            <label className="block w-44 text-xs text-slate-500">
              Shift
              <select value={draft.shift} onChange={(e) => setDraft({ ...draft, shift: e.target.value })} className={`${select} mt-1`}>
                <option value="">All Shifts</option>
                {report.options.shifts.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          )}
          <label className="block w-48 text-xs text-slate-500">
            Status
            <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} className={`${select} mt-1`}>
              <option value="">All</option>
              {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <button
            onClick={() => { setLoading(true); setApplied(draft); }}
            disabled={!dirty}
            className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Apply Filters
          </button>
          <button onClick={reset} className="rounded-xl border border-indigo-100 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Reset</button>

          <div className="relative ml-auto">
            <button
              onClick={() => setMenu((o) => !o)}
              onBlur={() => setTimeout(() => setMenu(false), 150)}
              disabled={!report || rows.length === 0}
              aria-haspopup="menu"
              aria-expanded={menu}
              className="flex items-center gap-2 rounded-xl border border-indigo-100 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Icon><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></Icon>
              Export
              <Icon><path d="M6 9l6 6 6-6" /></Icon>
            </button>
            {menu && (
              <div role="menu" className="absolute right-0 z-10 mt-1 w-56 rounded-xl border border-indigo-100 bg-white p-1 shadow-lg">
                <button role="menuitem" onMouseDown={exportXlsx} className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
                  Download Excel (.xlsx) <span className="block text-xs text-slate-400">formatted, with the Pending Tasks formula</span>
                </button>
                <button role="menuitem" onMouseDown={exportCsv} className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
                  Download CSV <span className="block text-xs text-slate-400">opens in Excel</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="flex items-center justify-between rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>Couldn&apos;t load the attendance report: {error}</span>
            <button onClick={() => void load()} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium hover:bg-red-100">Retry</button>
          </div>
        )}

        {/* KPI cards */}
        <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 ${loading ? "opacity-60" : ""}`}>
          <Kpi tone="blue" label="Employees" value={k ? String(k.employees) : "—"} sub={report ? (singleDay ? report.from : `${dayLabel(report.from)} – ${dayLabel(report.to)}`) : " "}
            icon={<Icon><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a3 3 0 100-6M21 20c0-2.5-1.5-4.6-3.7-5.5" /></Icon>} />
          <Kpi tone="green" label="Present" value={k ? String(k.present) : "—"} sub={unit}
            icon={<Icon><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6M16 17l2 2 4-4" /></Icon>} />
          <Kpi tone="red" label="Absent" value={k ? String(k.absent) : "—"} sub={unit}
            icon={<Icon><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6M16 14l5 5M21 14l-5 5" /></Icon>} />
          <Kpi tone="purple" label="Attendance %" value={k?.attendancePct == null ? "—" : `${k.attendancePct}%`}
            sub={k ? (k.workingDays > 0 ? `${k.present + k.halfDay} of ${k.workingDays} working ${unit}` : "no working days counted yet") : " "}
            icon={<Icon><path d="M19 5L5 19" /><circle cx="7" cy="7" r="2" /><circle cx="17" cy="17" r="2" /></Icon>} />
        </div>

        {k && (
          <p className="text-sm text-slate-600">
            <b className="font-semibold text-slate-900">{k.halfDay}</b> half day · <b className="font-semibold text-slate-900">{k.notYet}</b> not clocked in yet · total{" "}
            <b className="font-semibold text-slate-900">{hmFromHours(k.totalWorkedHours)}</b> worked · average{" "}
            <b className="font-semibold text-slate-900">{hmFromHours(k.avgWorkedHours)}</b> per day worked
          </p>
        )}

        <p className="text-xs leading-relaxed text-slate-500">
          For finished days: present = a full day worked, half day = under the full-day hours, absent = no clock-in (or too few hours) on a working day; leave, holidays and week-offs are not counted. Today shows people still working as
          Present, and anyone who has not clocked in yet as &ldquo;Not clocked in yet&rdquo; rather than absent, because a later clock-in makes them present. Days before a person joined or before attendance tracking began are left out.
        </p>

        {/* table */}
        <div className="overflow-hidden rounded-xl border border-indigo-100">
          <div className="overflow-x-auto">
            {loading && !report ? (
              <div className="space-y-2 p-6" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-10" />)}</div>
            ) : report && rows.length === 0 ? (
              <p className="px-6 py-12 text-center text-sm text-slate-500">No attendance rows match these filters.</p>
            ) : report ? (
              <table className={`w-full min-w-[980px] text-sm ${loading ? "opacity-60" : ""}`}>
                <thead className="bg-slate-50">
                  <tr>
                    <th className={th}>Employee ID</th>
                    <th className={th}>Employee</th>
                    <th className={th}>Date</th>
                    {hasShifts && <th className={th}>Shift</th>}
                    <th className={th}>Check-In</th>
                    <th className={th}>Check-Out</th>
                    <th className={`${th} text-right`}>Working</th>
                    <th className={`${th} text-right`}>Productive</th>
                    <th className={`${th} text-right`}>Break</th>
                    <th className={`${th} text-right`} title="Washroom time is tracked on its own. It is not break time and does not use the break allowance.">Washroom</th>
                    <th className={th}>Status</th>
                    <th className={th}>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const over = r.breakHours !== null && r.breakHours * 3600 > r.breakBudgetSeconds + 30;
                    const remark = remarks(r);
                    return (
                      <tr key={`${r.userId}|${r.date}`} className="border-t border-indigo-50">
                        <td className="px-4 py-3 text-slate-600">{r.employeeCode ?? "—"}</td>
                        <td className="px-4 py-3 font-medium text-slate-900">{r.name}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-slate-700">{dayShort(r.date)}</td>
                        {hasShifts && <td className="px-4 py-3 whitespace-nowrap text-slate-600">{r.shiftName ? `${r.shiftName}${r.shiftStart && r.shiftEnd ? ` (${r.shiftStart}–${r.shiftEnd})` : ""}` : "Not assigned"}</td>}
                        <td className="px-4 py-3 tabular-nums text-slate-900">{clockTime(r.loginAt, tz)}</td>
                        <td className="px-4 py-3 tabular-nums text-slate-900">{r.stillWorking ? <span className="text-emerald-600">Working</span> : clockTime(r.logoutAt, tz)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-900">{hmFromHours(r.workedHours)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-900">{hmFromHours(r.productiveHours)}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {over ? (
                            <span className="font-medium text-red-600">{hmFromHours(r.breakHours)}<span className="block text-[11px]">over by {hmFromHours((r.breakHours ?? 0) - r.breakBudgetSeconds / 3600)}</span></span>
                          ) : (
                            <span className="text-slate-600">{hmFromHours(r.breakHours)}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{r.washroomHours ? hmFromHours(r.washroomHours) : <span className="text-slate-300">—</span>}</td>
                        <td className="px-4 py-3">
                          <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status] ?? "bg-slate-100 text-slate-600"}`}>{r.statusLabel}</span>
                        </td>
                        <td className="px-4 py-3 text-slate-500">{remark || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : null}
          </div>
        </div>
        <p className="text-xs text-slate-400">
          {report ? `${rows.length} row${rows.length === 1 ? "" : "s"} · times in ${tz}${includesToday ? " · refreshes every minute" : ""}. ` : ""}A dash means nothing was recorded, not zero.
        </p>
      </div>
    </section>
  );
}
