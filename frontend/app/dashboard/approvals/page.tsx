"use client";

// ===========================================================================
// TASKS & PERFORMANCE: monitoring, analytics and reporting on employee-submitted tasks.
//
// This page only LOOKS. It has no approve, send back, rate, delete or assign buttons: all of those live in Daily Tasks (the "Employee submitted tasks"
// and "Assigned by me" tabs), so the two pages no longer repeat each other.
//
// The numbers come from the SAME call and the SAME rows as that queue (GET /tasks/review/queue, same permissions, same filters), counted by the rules in
// analytics.ts. Approving, assigning, editing or deleting a task in Daily Tasks therefore shows up here on the next reload (and live, through the task signal).
// ===========================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { getPlatformTimezone, todayIso } from "@/lib/time";
import { useTaskRealtime } from "@/lib/realtime";
import { plural } from "@/lib/plural";
import { useMe } from "../layout";
import FilterBar from "../_filters/FilterBar";
import { filterQuery, useFilterOptions, useHrFilters } from "../_filters/useHrFilters";
import { PRESETS, addDays, rangeFor, type Preset } from "../reports/_team/ranges";
import { describeFilters } from "../reports/_team/exportMeta";
import { downloadReportXlsx, type Col, type Value } from "../reports/_team/reportXlsx";
import { PROGRESS_CHIP_CLASS, PROGRESS_LABEL } from "../_progress/progress";
import RepetitionSummary from "../tasks/_repetition/RepetitionSummary";
import RepetitionAlerts from "../tasks/_repetition/RepetitionAlerts";
import { HistoryChart, StatusChart, WorkloadChart } from "./AnalyticsCharts";
import { DEFAULT_OVERDUE_DAYS, NO_PROJECT, OVERDUE_CHOICES, byDay, byEmployee, byProject, countRows, narrow, overdueList, progressOf, type Counts, type Row as BaseRow } from "./analytics";

type Row = BaseRow & { title: string };
type Queue = { date: string; scope?: { orgTotal: number; filteredTotal: number }; members: { id: string; name: string; employeeCode: string | null }[]; all: Row[] };
type Assigned = { counts: { total: number; todo: number; inProgress: number; awaiting: number; confirmed: number; overdue: number } };

const APPROVAL_CHIP: Record<string, string> = { APPROVED: "bg-emerald-50 text-emerald-700", PENDING: "bg-amber-50 text-amber-700", REJECTED: "bg-rose-50 text-rose-700" };
const APPROVAL_LABEL: Record<string, string> = { APPROVED: "Approved", PENDING: "Waiting for approval", REJECTED: "Rejected" };
const dayShort = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayFull = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const rating = (c: Counts) => (c.avgRating === null ? "Not rated" : `${c.avgRating.toFixed(1)} (${c.rated})`);

function Tile({ label, value, tone = "text-slate-900", hint, testId }: { label: string; value: string | number; tone?: string; hint?: string; testId?: string }) {
  return (
    <div className="rounded-2xl bg-white p-3.5 shadow-[var(--shadow-card)]" data-testid={testId}>
      <p className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

function Panel({ title, sub, children, testId }: { title: string; sub?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]" data-testid={testId}>
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function TasksPerformancePage() {
  const me = useMe();
  const staff = me?.role === "HR" || me?.role === "ADMIN";
  const allowed = ["MANAGER", "HR", "ADMIN"].includes(me?.role ?? "");
  const { filters, update, clear, ready } = useHrFilters();
  const { options: filterOptions } = useFilterOptions(filters, update, ready && staff);

  // Opens on Today like every report screen; nothing is remembered between visits.
  const [preset, setPreset] = useState<Preset>("today");
  const [single, setSingle] = useState("");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [person, setPerson] = useState(""); // an employee id, "" = everyone
  const [project, setProject] = useState(""); // a project name, "" = every project
  const [overdueDays, setOverdueDays] = useState<number>(() => {
    try {
      const v = Number(typeof window === "undefined" ? "" : window.localStorage.getItem("hrms-overdue-days"));
      return (OVERDUE_CHOICES as readonly number[]).includes(v) ? v : DEFAULT_OVERDUE_DAYS;
    } catch {
      return DEFAULT_OVERDUE_DAYS;
    }
  });
  const [queue, setQueue] = useState<Queue | null>(null);
  const [assigned, setAssigned] = useState<Assigned | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [today, setToday] = useState(() => todayIso());
  const [busy, setBusy] = useState(false);

  const { connected } = useTaskRealtime(() => setReload((n) => n + 1));
  const connectedRef = useRef(connected);
  useEffect(() => {
    connectedRef.current = connected;
  });

  const range = useMemo(() => {
    if (preset === "single") return single ? { from: single, to: single } : null;
    if (preset === "custom") return customFrom && customTo && customFrom <= customTo ? { from: customFrom, to: customTo } : null;
    return rangeFor(preset, today);
  }, [preset, single, customFrom, customTo, today]);
  const tooLong = !!range && range.from < addDays(range.to, -92);
  const fq = staff ? filterQuery(filters) : "";
  const path = range && !tooLong ? `/tasks/review/queue?from=${range.from}&to=${range.to}${fq ? `&${fq}` : ""}` : null;

  useEffect(() => {
    if (!path || !ready || !allowed) return;
    let cancelled = false;
    let last = Date.now();
    const go = async () => {
      try {
        const q = await apiGet<Queue>(path);
        if (cancelled) return;
        last = Date.now();
        setQueue(q);
        setToday(q.date);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the task figures");
      }
    };
    void go();
    const poll = setInterval(() => { if (!connectedRef.current || Date.now() - last > 5 * 60_000) void go(); }, 30000);
    return () => { cancelled = true; clearInterval(poll); };
  }, [path, ready, allowed, reload]);

  // Tasks a manager assigned are counted on their own (they are not part of the employee-submitted figures above).
  useEffect(() => {
    if (me?.role !== "MANAGER") return;
    apiGet<Assigned>("/tasks/assigned/by-me").then(setAssigned).catch(() => setAssigned(null));
  }, [me?.role, reload]);

  function chooseOverdue(n: number) {
    setOverdueDays(n);
    try { window.localStorage.setItem("hrms-overdue-days", String(n)); } catch { /* the choice just is not remembered */ }
  }

  const all = useMemo(() => queue?.all ?? [], [queue]);
  const projects = useMemo(() => [...new Set(all.map((r) => r.project || NO_PROJECT))].sort(), [all]);
  const rows = useMemo(() => narrow(all, person, project), [all, person, project]);
  const totals = useMemo(() => countRows(rows, today, overdueDays), [rows, today, overdueDays]);
  const employees = useMemo(() => byEmployee(narrow(all, "", project), today, overdueDays), [all, project, today, overdueDays]);
  const shownEmployees = useMemo(() => (person ? employees.filter((g) => g.key === person) : employees), [employees, person]);
  const projectRows = useMemo(() => byProject(narrow(all, person, ""), today, overdueDays), [all, person, today, overdueDays]);
  const history = useMemo(() => byDay(rows).map((d) => ({ label: dayShort(d.day), submitted: d.submitted, completed: d.completed })), [rows]);
  const old = useMemo(() => overdueList(rows, today, overdueDays), [rows, today, overdueDays]);
  const personRow = person ? employees.find((g) => g.key === person) : null;

  async function download() {
    if (!range || busy) return;
    setBusy(true);
    try {
      const counts = (c: Counts): Value[] => [c.submitted, c.approved, c.pending, c.rejected, c.todo, c.inProgress, c.completed, c.blocked, c.open, c.overdue, c.rated, c.avgRating];
      const countCols: Col[] = [
        { header: "Submitted", kind: "int", width: 11 }, { header: "Approved", kind: "int", width: 10 }, { header: "Waiting for approval", kind: "int", width: 12 }, { header: "Rejected", kind: "int", width: 10 },
        { header: "To Do", kind: "int", width: 8 }, { header: "In Progress", kind: "int", width: 11 }, { header: "Completed", kind: "int", width: 11 }, { header: "Blocked", kind: "int", width: 9 },
        { header: "Open", kind: "int", width: 8 }, { header: `Overdue (open, older than ${overdueDays} days)`, kind: "int", width: 16 }, { header: "Tasks rated", kind: "int", width: 11 },
        { header: "Average rating (rated tasks only)", kind: "decimal", width: 16 },
      ];
      const byEmp = employees.filter((g) => !person || g.key === person);
      const taskCols: Col[] = [
        { header: "Employee ID", width: 14 }, { header: "Employee", width: 24 }, { header: "Project", width: 22 }, { header: "Task day", kind: "date", width: 13 }, { header: "Task", width: 44, wrap: true },
        { header: "Approval", width: 18 }, { header: "Progress", width: 13 }, { header: "Rating", kind: "int", width: 9 }, { header: `Overdue (open, older than ${overdueDays} days)`, width: 16 },
      ];
      const taskRows: Value[][] = [...rows].sort((a, b) => a.who.localeCompare(b.who) || a.date.localeCompare(b.date)).map((r): Value[] => [
        r.employeeCode, r.who, r.project || NO_PROJECT, r.date, r.title ?? "", APPROVAL_LABEL[String(r.approvalStatus)] ?? String(r.approvalStatus),
        String(r.status) === "CANCELLED" ? "Withdrawn" : PROGRESS_LABEL[progressOf(r)] ?? progressOf(r), r.rating ?? null,
        overdueList([r], today, overdueDays).length > 0 ? "Yes" : "No",
      ]);
      const tz = getPlatformTimezone();
      await downloadReportXlsx(`tasks-and-performance-${range.from}_to_${range.to}.xlsx`, [
        { name: "By employee", cols: [{ header: "Employee ID", width: 14 }, { header: "Employee", width: 26 }, ...countCols], rows: byEmp.map((g) => [g.code, g.label, ...counts(g.counts)]) },
        { name: "By project", cols: [{ header: "Project", width: 28 }, ...countCols], rows: projectRows.map((g) => [g.label, ...counts(g.counts)]) },
        { name: "Tasks", cols: taskCols, rows: taskRows },
      ], {
        report: "Tasks & Performance (employee-submitted tasks)",
        period: range.from === range.to ? dayFull(range.from) : `${dayFull(range.from)} to ${dayFull(range.to)}`,
        filters: [...(staff ? await describeFilters(filters) : []), ["Employee", personRow ? `${personRow.label}${personRow.code ? ` (${personRow.code})` : ""}` : "Everyone"], ["Project", project || "All projects"], ["Overdue means", `open and older than ${overdueDays} days`]],
        exportedAt: new Date(), exportedBy: me ? `${me.firstName} ${me.lastName}`.trim() : null, timezone: tz,
        totals: [["Submitted", totals.submitted], ["Approved", totals.approved], ["Waiting for approval", totals.pending], ["Rejected", totals.rejected], ["To Do", totals.todo], ["In Progress", totals.inProgress], ["Completed", totals.completed], ["Blocked", totals.blocked], ["Tasks rated", totals.rated], ["Average rating (rated tasks only)", totals.avgRating === null ? "Not rated" : totals.avgRating]],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the Excel file");
    } finally {
      setBusy(false);
    }
  }

  if (me && !allowed) {
    return <div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-600 shadow-[var(--shadow-card)]">Tasks &amp; Performance is for managers, HR and Admin. Your own tasks are in Daily Tasks and My History.</div>;
  }
  if (!me) return <div aria-busy="true"><div className="skeleton h-10" /></div>;

  const input = "h-9 rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-800 outline-none focus:border-indigo-400";
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Tasks &amp; Performance</h1>
          <p className="mt-1 text-sm text-slate-500">Monitoring and analytics for employee-submitted tasks. To approve, send back, rate or assign work, use <Link href="/dashboard/tasks?tab=submitted" className="font-medium text-indigo-700 hover:underline">Daily Tasks</Link>.</p>
        </div>
        <button type="button" onClick={() => void download()} disabled={busy || !range || !queue} className="h-10 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Download Excel</button>
      </header>

      <div className="space-y-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-500">Period
            <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} aria-label="Period" className={`${input} mt-1 block`}>
              {PRESETS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          {preset === "single" && <label className="text-xs text-slate-500">Date<input type="date" value={single} max={today} onChange={(e) => setSingle(e.target.value)} aria-label="Single date" className={`${input} mt-1 block`} /></label>}
          {preset === "custom" && (
            <>
              <label className="text-xs text-slate-500">From<input type="date" value={customFrom} max={customTo || today} onChange={(e) => setCustomFrom(e.target.value)} aria-label="From date" className={`${input} mt-1 block`} /></label>
              <label className="text-xs text-slate-500">To<input type="date" value={customTo} min={customFrom} max={today} onChange={(e) => setCustomTo(e.target.value)} aria-label="To date" className={`${input} mt-1 block`} /></label>
            </>
          )}
          <label className="text-xs text-slate-500">Employee
            <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Employee" className={`${input} mt-1 block max-w-[16rem]`}>
              <option value="">Everyone</option>
              {employees.map((g) => <option key={g.key} value={g.key}>{g.label}{g.code ? ` (${g.code})` : ""}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500">Project
            <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className={`${input} mt-1 block max-w-[14rem]`}>
              <option value="">All projects</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500">Overdue after
            <select value={overdueDays} onChange={(e) => chooseOverdue(Number(e.target.value))} aria-label="Days before an unfinished task counts as overdue" className={`${input} mt-1 block`}>
              {OVERDUE_CHOICES.map((n) => <option key={n} value={n}>{n} days</option>)}
            </select>
          </label>
        </div>
        {tooLong && <p role="alert" className="text-sm text-rose-700">Pick a range of at most 93 days.</p>}
        {preset === "custom" && !range && !tooLong && <p className="text-sm text-slate-500">Choose both dates.</p>}
        {staff && <FilterBar filters={filters} update={update} clear={clear} options={filterOptions} show={{ company: true, project: true, manager: true }} counts={queue?.scope ? { filtered: queue.scope.filteredTotal, total: queue.scope.orgTotal } : null} />}
      </div>

      {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
      {!queue && !error && path && <div className="skeleton h-40" aria-busy="true" />}

      {queue && (
        <>
          <section aria-label="Task counts" className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile testId="kpi-submitted" label="Submitted" value={totals.submitted} hint="withdrawn tasks left out" />
              <Tile testId="kpi-approved" label="Approved" value={totals.approved} tone="text-emerald-700" />
              <Tile testId="kpi-pending" label="Waiting for approval" value={totals.pending} tone="text-amber-700" hint="shown to the manager who decides" />
              <Tile testId="kpi-rejected" label="Rejected" value={totals.rejected} tone="text-rose-700" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile testId="kpi-todo" label="To Do" value={totals.todo} />
              <Tile testId="kpi-inprogress" label="In Progress" value={totals.inProgress} tone="text-sky-700" />
              <Tile testId="kpi-completed" label="Completed" value={totals.completed} tone="text-emerald-700" />
              <Tile testId="kpi-blocked" label="Blocked" value={totals.blocked} tone="text-violet-700" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile testId="kpi-rated" label="Rated tasks" value={totals.rated} hint="of the tasks in view" />
              <Tile testId="kpi-avg" label="Average rating" value={totals.avgRating === null ? "Not rated" : totals.avgRating.toFixed(1)} hint="rated tasks only; unrated are never counted as 0" />
              <Tile testId="kpi-open" label="Open tasks" value={totals.open} tone="text-amber-700" hint="not completed, not rejected" />
              <Tile testId="kpi-overdue" label="Overdue" value={totals.overdue} tone="text-rose-700" hint={`open and older than ${overdueDays} days`} />
            </div>
            {assigned && (
              <div data-testid="assigned-counts" className="rounded-2xl bg-white p-3.5 shadow-[var(--shadow-card)]">
                <p className="text-[11px] font-medium text-[var(--text-secondary)]">Assigned by you (counted separately, never part of the figures above)</p>
                <p className="mt-1 text-sm text-slate-700">{assigned.counts.total} assigned · {assigned.counts.todo} to do · {assigned.counts.inProgress} in progress · {assigned.counts.awaiting} waiting for your confirmation · {assigned.counts.confirmed} confirmed · {assigned.counts.overdue} past their due date. <Link href="/dashboard/tasks?tab=assigned" className="font-medium text-indigo-700 hover:underline">Manage in Daily Tasks</Link></p>
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Approval and progress" sub={`${plural(totals.submitted, "task")} submitted in the period`}><StatusChart c={totals} /></Panel>
            <Panel title="Completion history" sub="By task day: tasks submitted and how many are completed">{history.length ? <HistoryChart rows={history} /> : <p className="text-sm text-slate-500">No tasks in this period.</p>}</Panel>
          </div>

          <Panel title="Workload across employees" sub="Open tasks next to completed ones, most open first">
            {employees.length ? <WorkloadChart rows={[...employees].filter((g) => !person || g.key === person).sort((a, b) => b.counts.open - a.counts.open).map((g) => ({ name: g.label, open: g.counts.open, completed: g.counts.completed }))} /> : <p className="text-sm text-slate-500">No tasks in this period.</p>}
          </Panel>

          <Panel testId="employee-table" title="Employee-wise task performance" sub="Click a name to see that person's task history below">
            {shownEmployees.length === 0 ? <p className="text-sm text-slate-500">No tasks in this period.</p> : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-xs text-slate-500"><tr>
                    <th className="px-2 py-2">Employee</th><th className="px-2 py-2 text-right">Submitted</th><th className="px-2 py-2 text-right">Approved</th><th className="px-2 py-2 text-right">Waiting</th><th className="px-2 py-2 text-right">Rejected</th>
                    <th className="px-2 py-2 text-right">To Do</th><th className="px-2 py-2 text-right">In Progress</th><th className="px-2 py-2 text-right">Completed</th><th className="px-2 py-2 text-right">Blocked</th><th className="px-2 py-2 text-right">Overdue</th><th className="px-2 py-2 text-right">Avg rating (rated)</th>
                  </tr></thead>
                  <tbody className="divide-y divide-indigo-50">
                    {shownEmployees.map((g) => (
                      <tr key={g.key} className={person === g.key ? "bg-indigo-50/60" : ""}>
                        <td className="px-2 py-2"><button type="button" onClick={() => setPerson(person === g.key ? "" : g.key)} className="text-left font-medium text-indigo-700 hover:underline">{g.label}</button>{g.code && <span className="text-xs text-slate-500"> · {g.code}</span>}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{g.counts.submitted}</td><td className="px-2 py-2 text-right tabular-nums">{g.counts.approved}</td><td className="px-2 py-2 text-right tabular-nums">{g.counts.pending}</td><td className="px-2 py-2 text-right tabular-nums">{g.counts.rejected}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{g.counts.todo}</td><td className="px-2 py-2 text-right tabular-nums">{g.counts.inProgress}</td><td className="px-2 py-2 text-right tabular-nums">{g.counts.completed}</td><td className="px-2 py-2 text-right tabular-nums">{g.counts.blocked}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{g.counts.overdue}</td><td className="px-2 py-2 text-right tabular-nums">{rating(g.counts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          {personRow && (
            <Panel testId="employee-detail" title={`${personRow.label}${personRow.code ? ` (${personRow.code})` : ""}: task history`} sub="Read only. Open Daily Tasks to act on any of these.">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div>{history.length ? <HistoryChart rows={history} /> : <p className="text-sm text-slate-500">No tasks in this period.</p>}</div>
                <ul className="max-h-72 divide-y divide-indigo-50 overflow-y-auto text-sm">
                  {[...rows].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                      <span className="min-w-0"><span className="block break-words text-slate-900 [overflow-wrap:anywhere]">{r.title}</span><span className="block text-xs text-slate-500">{dayFull(r.date)}{r.project ? ` · ${r.project}` : ""}</span></span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${APPROVAL_CHIP[String(r.approvalStatus)] ?? ""}`}>{APPROVAL_LABEL[String(r.approvalStatus)] ?? r.approvalStatus}</span>
                        {String(r.approvalStatus) !== "REJECTED" && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PROGRESS_CHIP_CLASS[progressOf(r)] ?? ""}`}>{PROGRESS_LABEL[progressOf(r)]}</span>}
                        <span className="text-xs text-slate-600">{r.rating != null ? `★ ${r.rating}` : "Not rated"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </Panel>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel testId="project-table" title="Project-wise summary">
              {projectRows.length === 0 ? <p className="text-sm text-slate-500">No tasks in this period.</p> : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="text-left text-xs text-slate-500"><tr><th className="px-2 py-2">Project</th><th className="px-2 py-2 text-right">Submitted</th><th className="px-2 py-2 text-right">Approved</th><th className="px-2 py-2 text-right">Completed</th><th className="px-2 py-2 text-right">Blocked</th><th className="px-2 py-2 text-right">Avg rating</th></tr></thead>
                    <tbody className="divide-y divide-indigo-50">{projectRows.map((g) => (
                      <tr key={g.key}><td className="px-2 py-2 text-slate-900">{g.label}</td><td className="px-2 py-2 text-right tabular-nums">{g.counts.submitted}</td><td className="px-2 py-2 text-right tabular-nums">{g.counts.approved}</td><td className="px-2 py-2 text-right tabular-nums">{g.counts.completed}</td><td className="px-2 py-2 text-right tabular-nums">{g.counts.blocked}</td><td className="px-2 py-2 text-right tabular-nums">{rating(g.counts)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </Panel>
            <Panel testId="overdue-panel" title="Overdue tasks" sub={`Open tasks whose task day is more than ${overdueDays} days ago. Submitted tasks have no due date, so this is the age of unfinished work.`}>
              {old.length === 0 ? <p className="text-sm text-slate-500">Nothing is overdue.</p> : (
                <ul className="max-h-64 divide-y divide-indigo-50 overflow-y-auto text-sm">
                  {old.slice(0, 20).map((r) => (
                    <li key={r.id} className="flex items-start justify-between gap-2 py-2"><span className="min-w-0"><span className="block break-words text-slate-900 [overflow-wrap:anywhere]">{r.title}</span><span className="block text-xs text-slate-500">{r.who}{r.employeeCode ? ` · ${r.employeeCode}` : ""} · {dayFull(r.date)}</span></span><span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">{r.age} days</span></li>
                  ))}
                </ul>
              )}
              {old.length > 20 && <p className="mt-2 text-xs text-slate-500">Showing the oldest 20 of {old.length}.</p>}
            </Panel>
          </div>

          <RepetitionAlerts />
          <RepetitionSummary />
        </>
      )}
    </div>
  );
}
