// ===========================================================================
// REPORTS
//
// One date range, five ways to slice it. Everything on screen comes from a
// single GET /api/reports call — no per-row fetching, so switching "Group by"
// is one request, not one request per person.
//
// Attainment is productive hours over EXPECTED hours. Days expected sits next
// to it on purpose: a percentage without its denominator is the kind of
// number people argue with.
//
// CSV is built in the browser from the rows already on screen. No server
// endpoint, no temp file, no cleanup job.
// ===========================================================================

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { useMe } from "../layout";
import AttendanceReport from "./_team/AttendanceReport";
import ShiftBreakdownCard from "./_team/ShiftBreakdownCard";
import ProductivityReport from "./_team/ProductivityReport";
import FilterBar from "../_filters/FilterBar";
import { useFilterOptions, useHrFilters } from "../_filters/useHrFilters";

type Tab = "summary" | "attendance" | "shift" | "productivity";
import { addDaysIso, firstOfMonthIso as firstOfMonth, formatTime, todayIso } from "@/lib/time";

type GroupBy = "person" | "day" | "week" | "month" | "year";

type PersonRow = {
  userId: string;
  name: string;
  email: string;
  employeeCode: string | null;
  role: string;
  designation: string | null;
  daysExpected: number;
  daysPresent: number;
  daysOnLeave: number;
  daysAbsent: number;
  daysNotTracked: number;
  teamName: string | null;
  huddleSeconds: number;
  lateDays: number;
  lateMinutes: number;
  autoClosedDays: number;
  productiveSeconds: number;
  breakSeconds: number;
  washroomSeconds: number;
  meetingSeconds: number;
  targetSeconds: number;
  attainment: number;
  taskScore: number;
  tasksTotal: number;
  tasksDone: number;
  tasksCompleted: number;
  tasksPending: number;
  taskCompletion: number;
  ratedCount: number;
  avgRating: number | null;
  alertCount: number;
};

type BucketRow = {
  key: string;
  headcount: number;
  daysExpected: number;
  daysPresent: number;
  daysOnLeave: number;
  lateDays: number;
  productiveSeconds: number;
  breakSeconds: number;
  washroomSeconds: number;
  meetingSeconds: number;
  huddleSeconds: number;
  targetSeconds: number;
  attainment: number;
  tasksCompleted: number;
  tasksPending: number;
  taskCompletion: number;
  ratedCount: number;
  avgRating: number | null;
  alertCount: number;
};

type Report = {
  range: { from: string; to: string };
  groupBy: GroupBy;
  platform: string | null;
  scope: "self" | "team" | "platform";
  target: { productiveHours: number; breakBudgetMinutes: number };
  holidaysConfigured: boolean;
  totals: {
    headcount: number;
    daysExpected: number;
    daysPresent: number;
    daysOnLeave: number;
    daysAbsent: number;
    daysNotTracked: number;
    huddleSeconds: number;
    managersExcluded: number;
    lateDays: number;
    productiveSeconds: number;
    breakSeconds: number;
    washroomSeconds: number;
    meetingSeconds: number;
    targetSeconds: number;
    attainment: number;
    taskScore: number;
    tasksCompleted: number;
    tasksPending: number;
    taskCompletion: number;
    ratedCount: number;
    avgRating: number | null;
    alertCount: number;
  };
  people: PersonRow[];
  buckets: BucketRow[];
  alertBreakdown: { alertType: string; count: number }[];
  hasOpenSessions: boolean;
};

const GROUPS: { value: GroupBy; label: string }[] = [
  { value: "person", label: "Person" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

const ALERT_LABELS: Record<string, string> = {
  LATE_LOGIN: "late login",
  BREAK_OVERAGE: "break overage",
  OVERTIME: "overtime",
  LOW_PRODUCTIVITY: "low productivity",
  NO_LOGIN: "no login",
  MEETING_PENDING_APPROVAL: "meeting awaiting approval",
  BIOMETRIC_MISMATCH: "biometric mismatch",
};

// --- formatting -------------------------------------------------------------

function hm(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function days(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// Attainment colour band. Green at or above target, amber from 80%, red below.
function bandClass(value: number): string {
  if (value >= 1) return "text-emerald-700 bg-emerald-50 ring-emerald-200";
  if (value >= 0.8) return "text-slate-700 bg-[#F3F7F6] ring-slate-200";
  if (value >= 0.6) return "text-amber-700 bg-amber-50 ring-amber-200";
  return "text-rose-700 bg-rose-50 ring-rose-200";
}

// ===========================================================================

// Managers, HR and Admin get the team reports (history). An employee only ever sees their own figures.
export default function ReportsPage() {
  const me = useMe();
  const [tab, setTab] = useState<Exclude<Tab, "summary">>(() => {
    if (typeof window === "undefined") return "attendance";
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "productivity" || t === "shift" ? t : "attendance";
  });
  const canSeeTeam = !!me && ["MANAGER", "HR", "ADMIN"].includes(me.role);
  // Company, project, reporting manager and name/ID search narrow all three reports to the SAME people (the server builds the tables, KPIs and charts from
  // that one list, so the exports match). HR and Admin: every company they act on; a manager: their own people.
  const { filters, update, clear, ready } = useHrFilters();
  const { options } = useFilterOptions(filters, update, ready && canSeeTeam);
  const [scope, setScope] = useState<{ orgTotal: number; filteredTotal: number } | null>(null);
  const tabs: [Exclude<Tab, "summary">, string][] = [
    ["attendance", "Attendance report"],
    ["shift", "Shift breakdown"],
    ["productivity", "Task productivity"],
  ];

  if (!me) return <div className="p-8" aria-busy="true"><div className="skeleton h-10" /></div>;
  if (!canSeeTeam) return <SummaryReport />;

  return (
    <div className="mx-auto page-7xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Reports &amp; Analytics</h1>
        <p className="mt-1 text-sm text-slate-500">History and trends for your people: HR and Admin see every company they act on, a manager sees their own team. For who is working right now, open Attendance.</p>
      </div>
      <div role="tablist" className="inline-flex flex-wrap rounded-xl bg-white p-1 shadow-[var(--shadow-card)]">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={"rounded-lg px-4 py-2 text-sm font-medium " + (tab === key ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50")}
          >
            {label}
          </button>
        ))}
      </div>
      <FilterBar
        filters={filters}
        update={update}
        clear={clear}
        options={options}
        show={{ search: true, company: me?.role !== "MANAGER" || (options?.companies.length ?? 0) > 1, project: true, manager: me?.role !== "MANAGER" }}
        counts={scope ? { filtered: scope.filteredTotal, total: scope.orgTotal } : null}
      />
      {tab === "attendance" ? (
        <AttendanceReport filters={filters} ready={ready} onScope={setScope} />
      ) : tab === "shift" ? (
        <ShiftBreakdownCard filters={filters} ready={ready} onScope={setScope} />
      ) : (
        <ProductivityReport canSetTargets={!!me && ["HR", "ADMIN"].includes(me.role)} filters={filters} ready={ready} onScope={setScope} />
      )}
    </div>
  );
}

function SummaryReport() {
  // Opens on Today in the HRMS timezone (nothing is restored from a previous visit); the buttons below switch the range.
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [groupBy, setGroupBy] = useState<GroupBy>("person");

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = `?from=${from}&to=${to}&groupBy=${groupBy}`;
      const data = await apiGet<Report>(`/reports${query}`);
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the report.");
    } finally {
      setLoading(false);
    }
  }, [from, to, groupBy]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyPreset(preset: "today" | "yesterday" | "week" | "month" | "quarter" | "year") {
    let end = todayIso();
    const [yr, mo] = end.split("-").map(Number);
    let start = end;

    if (preset === "today") {
      start = end;
    } else if (preset === "yesterday") {
      end = addDaysIso(end, -1);
      start = end;
    } else if (preset === "week") {
      start = addDaysIso(end, -6);
    } else if (preset === "month") {
      start = firstOfMonth();
    } else if (preset === "quarter") {
      const q = Math.floor((mo - 1) / 3) * 3;
      start = `${yr}-${String(q + 1).padStart(2, "0")}-01`;
    } else {
      start = `${yr}-01-01`;
    }

    setFrom(start);
    setTo(end);
  }

  // --- CSV ------------------------------------------------------------------
  // Built from the rows already rendered, so what downloads is exactly what
  // is on screen. Values are quoted and internal quotes doubled, which is the
  // only escaping CSV actually has.
  const exportCsv = useMemo(() => {
    return () => {
      if (!report) return;

      const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      let header: string[];
      let rows: unknown[][];

      if (groupBy === "person") {
        header = [
          "Name", "Employee code", "Role", "Days expected", "Days present",
          "Days on leave", "Days absent", "Days not tracked", "Late days", "Late minutes",
          "Productive", "Of which Team Huddle", "Break", "Washroom", "Target", "Productivity %",
          "Tasks completed", "Tasks pending", "Task completion %",
          "Task score %", "Average rating (out of 5)", "Tasks rated", "Alerts", "Auto-closed days",
        ];
        rows = report.people.map((p) => [
          p.name, p.employeeCode, p.role, p.daysExpected, p.daysPresent,
          p.daysOnLeave, p.daysAbsent, p.daysNotTracked, p.lateDays, p.lateMinutes,
          hm(p.productiveSeconds), hm(p.huddleSeconds), hm(p.breakSeconds), hm(p.washroomSeconds),
          hm(p.targetSeconds), Math.round(p.attainment * 100),
          p.tasksCompleted, p.tasksPending, Math.round(p.taskCompletion * 100),
          Math.round(p.taskScore * 100), p.avgRating ?? "", p.ratedCount, p.alertCount, p.autoClosedDays,
        ]);
      } else {
        header = [
          "Period", "People", "Days expected", "Days present", "Days on leave",
          "Late days", "Productive", "Team Huddle", "Break", "Washroom", "Target",
          "Productivity %", "Tasks completed", "Tasks pending", "Task completion %", "Average rating (out of 5)", "Alerts",
        ];
        rows = report.buckets.map((b) => [
          b.key, b.headcount, b.daysExpected, b.daysPresent, b.daysOnLeave,
          b.lateDays, hm(b.productiveSeconds), hm(b.huddleSeconds), hm(b.breakSeconds), hm(b.washroomSeconds),
          hm(b.targetSeconds),
          Math.round(b.attainment * 100), b.tasksCompleted, b.tasksPending, Math.round(b.taskCompletion * 100), b.avgRating ?? "", b.alertCount,
        ]);
      }

      const csv = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");

      // The BOM makes Excel read it as UTF-8 instead of mangling the hour strings.
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `report-${groupBy}-${from}-to-${to}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    };
  }, [report, groupBy, from, to]);

  const t = report?.totals;

  return (
    <div className="p-8 space-y-6">
      {/* --- header ------------------------------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Reports
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {report ? (
              <>
                {report.scope === "self"
                  ? "Your own figures"
                  : report.scope === "team"
                    ? "Your teams"
                    : `All of ${report.platform ?? "the platform"}`}
                {" · target "}
                {report.target.productiveHours}h productive per scheduled day
              </>
            ) : (
              "Loading scope…"
            )}
          </p>
        </div>

        <button
          onClick={exportCsv}
          disabled={!report || loading}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Export CSV
        </button>
      </div>

      {/* --- controls ----------------------------------------------------- */}
      <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            />
          </label>

          <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
            To
            <input
              type="date"
              value={to}
              min={from}
              max={todayIso()}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            />
          </label>

          <div className="flex gap-1">
            {(["today", "yesterday", "week", "month", "quarter", "year"] as const).map((p) => (
              <button
                key={p}
                onClick={() => applyPreset(p)}
                className="rounded-xl border border-indigo-100 px-3 py-2 text-xs font-medium capitalize text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
              >
                {p === "today" ? "Today" : p === "yesterday" ? "Yesterday" : p === "week" ? "Last 7 days" : `This ${p}`}
              </button>
            ))}
          </div>

          <div className="ml-auto">
            <span className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Group by
            </span>
            <div className="mt-1 inline-flex rounded-xl border border-indigo-100 bg-[#F3F7F6] p-0.5">
              {GROUPS.map((g) => (
                <button
                  key={g.value}
                  onClick={() => setGroupBy(g.value)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    groupBy === g.value
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {error}
        </div>
      )}

      {report?.hasOpenSessions && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
          </span>
          Some sessions in this range are still running. Their figures finalise on clock-out.
        </div>
      )}

      {report && !report.holidaysConfigured && (
        <div className="rounded-xl border border-indigo-100 bg-[#F3F7F6] px-4 py-3 text-sm text-slate-600">
          No holidays are set up for this period, so public holidays are being counted
          as expected working days. Add them before treating attainment as final.
        </div>
      )}

      {/* --- summary tiles ------------------------------------------------ */}
      {t && report && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Tile label="People" value={String(t.headcount)} sub="in this report" />
          <Tile
            label="Days expected"
            value={days(t.daysExpected)}
            sub={`${days(t.daysOnLeave)} on leave, not counted`}
          />
          <Tile
            label="Days present"
            value={days(t.daysPresent)}
            sub={`${days(t.daysAbsent)} absent${t.daysNotTracked > 0 ? ` · ${days(t.daysNotTracked)} not tracked` : ""}`}
          />
          <Tile
            label="Productivity %"
            value={pct(t.attainment)}
            sub="productive hours ÷ expected"
            accent={bandClass(t.attainment)}
          />
          <Tile
            label="Productive"
            value={hm(t.productiveSeconds)}
            sub={`of ${hm(t.targetSeconds)} expected${t.huddleSeconds > 0 ? ` · incl. ${hm(t.huddleSeconds)} in Team Huddles` : ""}${t.managersExcluded > 0 ? ` · ${t.managersExcluded} manager${t.managersExcluded === 1 ? "" : "s"} not counted` : ""}`}
          />
          <Tile
            label="Tasks completed"
            value={String(t.tasksCompleted)}
            sub={`${t.tasksPending} pending · ${t.tasksCompleted + t.tasksPending > 0 ? pct(t.taskCompletion) : "no tasks"} complete · ${t.avgRating != null ? `avg rating ${t.avgRating}/5 (${t.ratedCount} rated)` : "no ratings yet"}`}
          />
          <Tile
            label="Break"
            value={hm(t.breakSeconds)}
            sub={`tea, lunch, personal · budget ${report.target.breakBudgetMinutes}m/day`}
          />
          <Tile
            label="Washroom"
            value={hm(t.washroomSeconds)}
            sub="not break, not productive"
          />
          <Tile
            label="Late days"
            value={String(t.lateDays)}
            sub={`of ${days(t.daysPresent)} days present`}
          />
          <Tile
            label="Alerts"
            value={String(t.alertCount)}
            sub="see breakdown below"
          />
        </div>
      )}

      {/* --- alert breakdown --------------------------------------------- */}
      {report && report.alertBreakdown.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Alerts raised
          </span>
          {report.alertBreakdown.map((a) => (
            <span
              key={a.alertType}
              className="rounded-full bg-[#E7F6F1] px-3 py-1 text-xs font-medium text-slate-700"
            >
              {ALERT_LABELS[a.alertType] ?? a.alertType.toLowerCase().replace(/_/g, " ")}
              <span className="ml-1.5 text-slate-500">{a.count}</span>
            </span>
          ))}
        </div>
      )}

      {/* --- table -------------------------------------------------------- */}
      <div className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <div className="overflow-x-auto">
          {groupBy === "person" ? (
            <table className="min-w-full text-sm">
              <thead className="bg-[#F3F7F6] text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Person</th>
                  <th className="px-4 py-3 text-right">Expected</th>
                  <th className="px-4 py-3 text-right">Present</th>
                  <th className="px-4 py-3 text-right">Leave</th>
                  <th className="px-4 py-3 text-right" title="Days the company was using the tracker and this person did not clock in">Absent</th>
                  <th className="px-4 py-3 text-right" title="Days nobody in the company clocked in: paid, not counted as absent">Not tracked</th>
                  <th className="px-4 py-3 text-right">Late</th>
                  <th className="px-4 py-3 text-right">Productive</th>
                  <th className="px-4 py-3 text-right" title="Part of the productive time that was spent in a Team Huddle. Already inside Productive, not extra.">Team Huddle</th>
                  <th className="px-4 py-3 text-right">Break</th>
                  <th className="px-4 py-3 text-right" title="Washroom time is tracked on its own. It is not break time and does not use the break allowance.">Washroom</th>
                  <th className="px-4 py-3 text-right" title="Productive hours divided by expected hours">Productivity %</th>
                  <th className="px-4 py-3 text-right" title="Approved tasks finished and accepted in full">Tasks done</th>
                  <th className="px-4 py-3 text-right" title="Approved tasks not fully done yet (open, partly done or sent back)">Tasks pending</th>
                  <th className="px-4 py-3 text-right" title="Done ÷ (done + pending)">Completion</th>
                  <th className="px-4 py-3 text-right" title="Weighted score of the day's tasks">Task score</th>
                  <th className="px-4 py-3 text-right" title="Average of the manager's 1 to 5 star ratings on finished tasks">Avg rating</th>
                  <th className="px-4 py-3 text-right">Alerts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-indigo-50">
                {report?.people.map((p) => (
                  <tr key={p.userId} className="transition hover:bg-indigo-50/60/70">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{p.name}</div>
                      <div className="text-xs text-slate-500">
                        {p.employeeCode ?? p.email}
                        {p.designation ? ` · ${p.designation}` : ""}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {days(p.daysExpected)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {p.daysPresent}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                      {days(p.daysOnLeave)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {p.daysAbsent > 0 ? (
                        <span className="text-rose-700">{p.daysAbsent}</span>
                      ) : (
                        <span className="text-slate-400">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-500">{p.daysNotTracked}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {p.lateDays > 0 ? (
                        <span className="text-amber-700">{p.lateDays}</span>
                      ) : (
                        <span className="text-slate-400">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-slate-900">
                      {hm(p.productiveSeconds)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {p.huddleSeconds > 0 ? hm(p.huddleSeconds) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {hm(p.breakSeconds)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {hm(p.washroomSeconds)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ${bandClass(p.attainment)}`}
                      >
                        {pct(p.attainment)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-emerald-700">{p.tasksCompleted}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-amber-700">{p.tasksPending}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {p.tasksCompleted + p.tasksPending > 0 ? pct(p.taskCompletion) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {p.tasksTotal > 0 ? pct(p.taskScore) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700" title={p.ratedCount > 0 ? `${p.ratedCount} rated task${p.ratedCount === 1 ? "" : "s"}` : "No rated tasks"}>
                      {p.avgRating != null ? `${p.avgRating}/5` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                      {p.alertCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="bg-[#F3F7F6] text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3 text-right">People</th>
                  <th className="px-4 py-3 text-right">Expected</th>
                  <th className="px-4 py-3 text-right">Present</th>
                  <th className="px-4 py-3 text-right">Leave</th>
                  <th className="px-4 py-3 text-right">Late</th>
                  <th className="px-4 py-3 text-right">Productive</th>
                  <th className="px-4 py-3 text-right" title="Part of the productive time that was spent in a Team Huddle. Already inside Productive, not extra.">Team Huddle</th>
                  <th className="px-4 py-3 text-right">Break</th>
                  <th className="px-4 py-3 text-right" title="Washroom time is tracked on its own. It is not break time and does not use the break allowance.">Washroom</th>
                  <th className="px-4 py-3 text-right" title="Productive hours divided by expected hours">Productivity %</th>
                  <th className="px-4 py-3 text-right">Tasks done</th>
                  <th className="px-4 py-3 text-right">Tasks pending</th>
                  <th className="px-4 py-3 text-right">Completion</th>
                  <th className="px-4 py-3 text-right">Alerts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-indigo-50">
                {report?.buckets.map((b) => (
                  <tr key={b.key} className="transition hover:bg-indigo-50/60/70">
                    <td className="px-4 py-3 font-medium text-slate-900">{b.key}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {b.headcount}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {days(b.daysExpected)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {b.daysPresent}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                      {days(b.daysOnLeave)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {b.lateDays}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-slate-900">
                      {hm(b.productiveSeconds)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {b.huddleSeconds > 0 ? hm(b.huddleSeconds) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {hm(b.breakSeconds)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-600">
                      {hm(b.washroomSeconds)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ${bandClass(b.attainment)}`}
                      >
                        {pct(b.attainment)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-emerald-700">{b.tasksCompleted}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-amber-700">{b.tasksPending}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-700">
                      {b.tasksCompleted + b.tasksPending > 0 ? pct(b.taskCompletion) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-500">
                      {b.alertCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {loading && (
          <div className="px-4 py-10 text-center text-sm text-slate-500">
            Building the report…
          </div>
        )}

        {!loading &&
          report &&
          (groupBy === "person" ? report.people.length === 0 : report.buckets.length === 0) && (
            <div className="px-4 py-10 text-center text-sm text-slate-500">
              Nothing recorded in this range.
            </div>
          )}
      </div>
    </div>
  );
}

// --- tile -------------------------------------------------------------------

function Tile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={`mt-2 inline-block text-2xl font-semibold tabular-nums tracking-tight ${
          accent ? `rounded-md px-2 ring-1 ${accent}` : "text-slate-900"
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}