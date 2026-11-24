"use client";

import { pctText, sampleText, scoreText, STATUS_CHIP, STATUS_LABEL, type Weighted } from "../../_weighted/Weighted";
import ScoreBreakdown from "./ScoreBreakdown";
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
import PersonTasks, { REASON_TEXT, type Reason, type TaskSummary } from "./ProductivityPersonTasks";
import { PROGRESS_LABEL } from "../../_progress/progress";

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
  weighted?: Weighted; // the Overall Performance Score (60% completion + 40% manager rating) from the server
  // why a figure is missing and the task counts behind the row (added 2026-11-22; older answers do not have them)
  tasks?: TaskSummary; reason?: Reason; targetState?: "CONFIGURED" | "NOT_CONFIGURED" | "ZERO"; mappedToTeam?: boolean;
};
type Productivity = { generatedAt: string; timezone: string; today: string; from: string; to: string; targetsReady: boolean; scope?: { orgTotal: number; filteredTotal: number }; weightedTotal?: Weighted; people: Person[] };
// The tasks behind the report (GET /team-attendance/productivity/tasks), fetched when Excel is exported.
type TaskRow = {
  id: string; userId: string; employee: string; employeeCode: string | null; project: string | null; reportingManager: string | null; taggedManager: string | null;
  title: string; description: string | null; date: string; priority: string; hoursSpent: number | null; progress: string; blockedReason?: string | null; approvalStatus: string; completedAt: string | null; counted: boolean; rating?: number | null; inScore?: boolean; scoreCompleted?: boolean; ratingStatus?: string; partial?: boolean;
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
  const [breakdown, setBreakdown] = useState<string | null>(null); // the person whose score breakdown is open
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
      ["Employee", "Employee ID", "Team", "Total eligible tasks", "Completed tasks", "Pending / incomplete tasks", "Completion %", "Average manager rating (of 5)", "Rated tasks", "Pending evaluation", "Overall Performance Score %", "Evaluation status", "Daily target", "Target level", "Days with data", "Tasks finished in period", "Productivity %"],
      data.people.map((p) => { const w = p.weighted; return [p.name, p.employeeCode, p.teamName, w?.tasks ?? "", w?.completed ?? "", w?.notCompleted ?? "", w?.completionPercent ?? "N/A", w?.averageRating ?? "Awaiting evaluation", w?.ratedTasks ?? "", w?.awaitingRating ?? "", w ? (w.percent ?? (w.status === "AWAITING_EVALUATION" ? "Awaiting evaluation" : "N/A")) : "N/A", w ? STATUS_LABEL[w.status] : "", p.targetPerDay ?? "Target not configured", p.targetSource ? SOURCE[p.targetSource] : "", p.daysWithData, p.completedTotal ?? (p.reason ? REASON_TEXT[p.reason] : "No task data available"), p.overallPercent ?? (p.targetPerDay === null ? "Target not configured" : p.targetPerDay === 0 ? "Target is 0" : p.reason ? REASON_TEXT[p.reason] || "" : "No task data available")]; })
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
      { header: "Total eligible tasks", kind: "int", width: 14, note: "Approved, not cancelled, dated inside the period. Waiting-for-approval and rejected tasks are not eligible and are never counted as completed." },
      { header: "Completed tasks", kind: "int", width: 13, note: "Eligible tasks that reached the completed state by the end of the period (not graded failed, not a manager-marked partial)." },
      { header: "Pending / incomplete tasks", kind: "int", width: 15 },
      { header: "Completion %", kind: "percent", width: 13, note: "Completed tasks / eligible tasks." },
      { header: "Average manager rating (of 5)", kind: "decimal", width: 16, note: "Average of the manager's stars over the completed tasks that have been rated. Blank = no completed task has been rated yet." },
      { header: "Rated tasks", kind: "int", width: 11 }, { header: "Pending evaluation", kind: "int", width: 12, note: "Completed tasks with no manager rating yet. They are never counted as 5 stars." },
      { header: "Overall Performance Score %", kind: "percent", width: 16, note: "Completion % x 0.60 + manager rating % x 0.40. Task priority is not used. Blank = N/A or awaiting evaluation (see Evaluation status). Provisional = some ratings are still outstanding." },
      { header: "Evaluation status", width: 18 }, { header: "Eligible tasks (sample size)", kind: "int", width: 14 },
      { header: "Daily target", kind: "int", width: 12 }, { header: "Target level", width: 13 }, { header: "Days with data", kind: "int", width: 13 },
      { header: "Tasks finished in period", kind: "int", width: 14, note: "Counted in the day each task was finished (used only for the daily-target productivity below)." }, { header: "Productivity %", kind: "percent", width: 14, note: "Tasks finished divided by the daily target on the days with task data. Text means there is nothing to calculate (target not set, or no task data); it is never shown as 0%." },
    ];
    const peopleRows = data.people.map((p) => { const w = p.weighted; return [
      p.employeeCode, p.name, p.teamName, (p.projects ?? []).join(", ") || null, p.reportingManager ?? null,
      w?.tasks ?? null, w?.completed ?? null, w?.notCompleted ?? null, w?.completionPercent ?? "N/A", w?.averageRating ?? null, w?.ratedTasks ?? null, w?.awaitingRating ?? null,
      w ? (w.percent ?? (w.status === "AWAITING_EVALUATION" ? "Awaiting evaluation" : "N/A")) : "N/A", w ? STATUS_LABEL[w.status] : null, w?.tasks ?? null,
      p.targetPerDay ?? "Target not configured", p.targetSource ? SOURCE[p.targetSource] : null, p.daysWithData,
      p.completedTotal ?? (p.reason ? REASON_TEXT[p.reason] : "No task data available"), p.overallPercent ?? (p.targetPerDay === null ? "Target not configured" : p.targetPerDay === 0 ? "Target is 0" : p.reason ? REASON_TEXT[p.reason] || "" : "No task data available"),
    ]; });

    const daily: Col[] = [
      { header: "Employee ID", width: 14 }, { header: "Employee", width: 24 }, { header: "Date", kind: "date", width: 13 },
      { header: "Tasks completed", kind: "int", width: 14 }, { header: "Productivity %", kind: "percent", width: 14 }, { header: "Data", width: 18 },
    ];
    const dailyRows = data.people.flatMap((p) => p.days.map((d) => [p.employeeCode, p.name, d.date, d.completed, d.percent, d.state === "DATA" ? "Task data" : "No task data available"]));

    const taskCols: Col[] = [
      { header: "Employee ID", width: 14 }, { header: "Employee", width: 24 }, { header: "Project", width: 24 }, { header: "Reporting manager", width: 22 },
      { header: "Tagged manager (approver)", width: 24, note: "The manager this task was sent to for approval." },
      { header: "Task", width: 40, wrap: true }, { header: "Details", width: 40, wrap: true }, { header: "Task date", kind: "date", width: 13 },
      { header: "Priority", width: 11 }, { header: "Hours spent", kind: "decimal", width: 12 }, { header: "Progress", width: 13 }, { header: "Blocked reason", width: 34, wrap: true }, { header: "Approval status", width: 14 },
      { header: "Completed on", kind: "date", width: 13 }, { header: "Completed at", kind: "time", width: 12 },
      { header: "In performance score", width: 13, note: "Yes = eligible: approved, not cancelled, dated inside the period. Priority is not part of the score." }, { header: "Completed for the score", width: 14, note: "Yes = completed by the end of the period (a task finished later is unfinished in this report)." },
      { header: "Manager rating (stars)", kind: "int", width: 13 }, { header: "Rating status", width: 18, note: "Rated, Pending evaluation (completed but not rated yet), or Not applicable (not completed)." }, { header: "Partially completed", width: 12 },
      { header: "Counted in productivity", width: 14, note: "Yes = the report counts it: completed, approved, finished inside these dates and not rated below the completed threshold." },
    ];
    const taskRows = tasks.tasks.map((t) => [
      t.employeeCode, t.employee, t.project, t.reportingManager, t.taggedManager, t.title, t.description, t.date,
      titleCase(t.priority), t.hoursSpent, PROGRESS_LABEL[t.progress] ?? titleCase(t.progress), t.progress === "BLOCKED" ? t.blockedReason ?? null : null, titleCase(t.approvalStatus), dayOf(t.completedAt, tz), secondsOfDay(t.completedAt, tz), t.inScore ? "Yes" : "No", t.scoreCompleted ? "Yes" : "No", t.rating ?? null, t.ratingStatus === "RATED" ? "Rated" : t.ratingStatus === "PENDING_EVALUATION" ? "Pending evaluation" : "Not applicable", t.partial ? "Yes" : null, t.counted ? "Yes" : "No",
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
      totals: [["People", k.people], ["Tasks completed (report total)", k.completed], ["Overall productivity %", k.percent === null ? "n/a" : k.percent], ["Overall Performance Score % (all people in this report)", data.weightedTotal ? (data.weightedTotal.percent ?? (data.weightedTotal.status === "AWAITING_EVALUATION" ? "Awaiting evaluation" : "N/A")) : "N/A"], ["Eligible tasks (all people in this report)", data.weightedTotal?.tasks ?? 0], ["Task rows exported", taskRows.length], ["Task rows counted in productivity", tasks.tasks.filter((t) => t.counted).length]],
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
        <Kpi label="No target set" value={data ? String(k.noTarget) : "—"} sub={k.noTarget > 0 ? (canSetTargets && !self ? "people. Set targets below (nothing is assigned automatically)" : "people. HR or Admin sets targets") : "people"} />
      </div>

      <section className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <div className="overflow-x-auto">
          {loading && !data ? (
            <div className="space-y-2 p-6" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10" />)}</div>
          ) : data && data.people.length === 0 ? (
            <p className="px-6 py-12 text-center text-sm text-slate-500">No one reports to you yet.</p>
          ) : data ? (
            <table className={`w-full min-w-[1100px] text-sm ${loading ? "opacity-60" : ""}`}>
              <thead className="bg-slate-50">
                <tr>
                  <th className={th}>Employee</th>
                  <th className={th}>Team / Project</th>
                  <th className={`${th} text-right`} title="Approved tasks dated inside the period (waiting-for-approval and rejected tasks are not eligible)">Total eligible</th>
                  <th className={`${th} text-right`} title="Eligible tasks that were completed by the end of the period">Completed</th>
                  <th className={`${th} text-right`}>Pending / incomplete</th>
                  <th className={`${th} text-right`}>Completion %</th>
                  <th className={`${th} text-right`} title="Average of the manager's stars over the completed tasks that have been rated">Avg rating</th>
                  <th className={`${th} text-right`} title="Completion % x 60% + manager rating % x 40%. Task priority is not used. Click a score for the breakdown.">Overall Performance Score</th>
                  <th className={th}>Evaluation status</th>
                  <th className={`${th} text-right`}>Daily target</th>
                  <th className={`${th} text-right`} title="Tasks finished in the period divided by the daily target (needs a target)">Productivity</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <Fragment key={p.userId}>
                    <tr className="cursor-pointer border-t border-indigo-50 hover:bg-slate-50" onClick={() => setOpen(open === p.userId ? null : p.userId)}>
                      <td className="px-3 py-2.5">
                        <button type="button" aria-expanded={open === p.userId} onClick={(e) => { e.stopPropagation(); setOpen(open === p.userId ? null : p.userId); }} className="text-left font-medium text-slate-900 hover:text-indigo-700 hover:underline">{p.name}</button>
                        <p className="text-xs text-slate-400">{p.employeeCode ?? "—"}</p>
                      </td>
                      <td className="px-3 py-2.5 text-slate-600">{p.teamName ?? (p.mappedToTeam === false ? <span className="text-xs text-amber-700" title="This person is not on any team, so only a personal or company-wide daily target can apply to them">No team</span> : "—")}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-900">
                        {p.targetPerDay !== null ? (p.targetPerDay === 0 ? <span className="text-xs text-amber-700" title="A target of 0 is set, so no percentage can be calculated">0 (no percentage)</span> : p.targetPerDay) : (
                          <span className="text-xs text-slate-400">Target not configured{canSetTargets && !self ? <button type="button" onClick={(e) => { e.stopPropagation(); document.getElementById("task-targets")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} className="ml-1 font-medium text-indigo-700 hover:underline">Set</button> : null}</span>
                        )}
                        {p.targetSource && <span className="ml-1 text-xs text-slate-400">({SOURCE[p.targetSource]})</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-900">{p.weighted ? p.weighted.tasks : "—"}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-900">{p.weighted ? p.weighted.completed : "—"}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">{p.weighted ? p.weighted.notCompleted : "—"}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-900">{p.weighted?.completionPercent != null ? `${p.weighted.completionPercent}%` : <span className="text-slate-400">N/A</span>}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-900">{p.weighted?.averageRating != null ? `${p.weighted.averageRating} / 5` : <span className="text-xs text-slate-400">{p.weighted && p.weighted.completed > 0 ? "Awaiting evaluation" : "—"}</span>}{p.weighted && p.weighted.awaitingRating > 0 && p.weighted.ratedTasks > 0 ? <span className="ml-1 text-xs text-violet-700" title="Completed tasks still waiting for a manager rating">+{p.weighted.awaitingRating} pending</span> : null}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {p.weighted && p.weighted.status !== "NO_TASKS" ? (
                          <button type="button" data-testid="score-open" onClick={(e) => { e.stopPropagation(); setBreakdown(p.userId); }} title="Open the score breakdown" className="text-right font-semibold text-slate-900 hover:text-indigo-700 hover:underline">
                            {pctText(p.weighted)} <span className="text-xs font-normal text-slate-500">{sampleText(p.weighted)}</span>
                          </button>
                        ) : <span className="text-xs text-slate-400">N/A</span>}
                      </td>
                      <td className="px-3 py-2.5">{p.weighted ? <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[p.weighted.status]}`} title={p.weighted.provisional ? `${p.weighted.awaitingRating} completed ${p.weighted.awaitingRating === 1 ? "task is" : "tasks are"} waiting for a rating` : undefined}>{STATUS_LABEL[p.weighted.status]}{p.weighted.provisional ? ` (${p.weighted.awaitingRating} pending)` : ""}</span> : null}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-slate-900">
                        {p.targetPerDay !== null ? (p.targetPerDay === 0 ? <span className="text-xs text-amber-700" title="A target of 0 is set, so no percentage can be calculated">0</span> : p.targetPerDay) : (
                          <span className="text-xs text-slate-400">Not set{canSetTargets && !self ? <button type="button" onClick={(e) => { e.stopPropagation(); document.getElementById("task-targets")?.scrollIntoView({ behavior: "smooth", block: "start" }); }} className="ml-1 font-medium text-indigo-700 hover:underline">Set</button> : null}</span>
                        )}
                      </td>
                      <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${pctClass(p.overallPercent)}`}>
                        {p.overallPercent !== null ? `${p.overallPercent}%` : <span className="text-xs font-normal text-slate-400">{p.targetPerDay === null ? "Target not configured" : p.targetPerDay === 0 ? "Target is 0" : p.reason ? REASON_TEXT[p.reason] || "—" : "No task data available"}</span>}
                      </td>
                    </tr>
                    {open === p.userId && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={11} className="space-y-4 px-6 py-4">
                          {p.tasks && data && <PersonTasks userId={p.userId} from={data.from} to={data.to} hrQuery={hrQuery} summary={p.tasks} />}
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
          Overall Performance Score = completion % × 60% + manager rating % × 40%. Eligible tasks are approved tasks dated inside the period (waiting-for-approval and rejected tasks are not counted as completed); completed means finished by the end of the period. Task priority is not used. A completed task nobody has rated yet is pending evaluation, never counted as 5 stars: with some ratings outstanding the score is Provisional, with none it is Awaiting evaluation. Click a score for the breakdown. Daily target and Productivity (finished tasks ÷ target, counted in the day each task was finished) are kept as before.
        </p>
      </section>

      {breakdown && data && (() => {
        const person = data.people.find((x) => x.userId === breakdown);
        return person?.weighted ? <ScoreBreakdown userId={person.userId} name={person.name} from={data.from} to={data.to} w={person.weighted} base={base} hrQuery={hrQuery} timezone={data.timezone} onClose={() => setBreakdown(null)} /> : null;
      })()}

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

      {canSetTargets && !self && <div id="task-targets"><TargetsPanel onChanged={() => setReloadTargets((n) => n + 1)} /></div>}
    </div>
  );
}
