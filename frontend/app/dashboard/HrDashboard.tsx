// ===========================================================================
// HR DASHBOARD
//
// What it is: one screen that answers "how is the company doing, and what
// needs me today?" for HR and Admin.
//
// Where the numbers come from: only existing endpoints, called in parallel,
// each with its own loading / error / empty state so one slow or failing
// call can never blank the whole page.
//   /reports        attendance, productivity, tasks, per-person table
//   /admin/users    total and active employees, the employee filter
//   /tracker/team   who has clocked in (recent activity)
//   /tracker/alerts today's alerts (recent activity, bell)
//   /holidays       the company's "today", upcoming events, calendar dots
//   /tasks/review/queue, /onboarding/candidates, /tickets   pending approvals
//
// Date rule: the page's range drives the charts, the performance table and
// the Tasks / Productivity tiles. "Present Today" and "Absent Today" are
// today by definition and say so. Attendance has two states only — Present
// and Absent — and the page never shows lateness.
// ===========================================================================

"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import { useMe } from "./layout";
import EmployeeActions from "./_employees/EmployeeActions";
import { AttendanceChart, ProductivityChart, type ChartRow } from "./_hr/Charts";
import {
  ActivityList,
  type ActivityItem,
  ApprovalRow,
  Card,
  EmptyNote,
  ErrorNote,
  EventsList,
  PerformanceTable,
  SectionTitle,
  Skeleton,
  StatTile,
  WeekStrip,
} from "./_hr/Panels";
import {
  addDays,
  bucketLabel,
  daysBetween,
  greeting,
  initials,
  monthStart,
  pct,
  previousMonth,
  rangeLabel,
  ymd,
} from "./_hr/format";
import type {
  AdminUser,
  AlertRow,
  Candidate,
  HolidayResponse,
  LiveRow,
  Queue,
  Report,
  Ticket,
} from "./_hr/types";

// --- one small loader per endpoint -----------------------------------------------
// Keeps the last good data while a new request is in flight, so changing a
// filter dims the numbers instead of flashing the page empty.
function useApi<T>(path: string | null, reload: number) {
  const [res, setRes] = useState<{ path: string; data?: T; error?: string } | null>(null);

  useEffect(() => {
    if (!path) return;
    let live = true;
    apiGet<T>(path)
      .then((data) => live && setRes({ path, data }))
      .catch((e: Error) => live && setRes((prev) => ({ path, data: prev?.data, error: e.message })));
    return () => {
      live = false;
    };
  }, [path, reload]);

  return {
    data: res?.data ?? null,
    error: res && res.path === path ? (res.error ?? "") : "",
    loading: path !== null && res?.path !== path,
  };
}

function useClickAway(ref: React.RefObject<HTMLElement | null>, onAway: () => void) {
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [ref, onAway]);
}

// --- icons (inline, like the rest of the app) ---------------------------------------
const Ico = {
  people: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="7.5" cy="7" r="2.6" />
      <path d="M2.6 16c0-2.6 2.2-4.3 4.9-4.3s4.9 1.7 4.9 4.3" strokeLinecap="round" />
      <path d="M13.4 5.1a2.4 2.4 0 0 1 0 4.4M14.6 11.9c1.6.5 2.8 1.9 2.8 4.1" strokeLinecap="round" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="10" cy="10" r="7.2" />
      <path d="m6.8 10.2 2.2 2.2 4.2-4.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  cross: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="10" cy="10" r="7.2" />
      <path d="m7.6 7.6 4.8 4.8M12.4 7.6l-4.8 4.8" strokeLinecap="round" />
    </svg>
  ),
  bolt: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M11 2.5 4.5 11H9l-1 6.5L15.5 8.5H11z" strokeLinejoin="round" />
    </svg>
  ),
  tasks: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M3 5.5 4.6 7 7.5 4M3 12.5 4.6 14l2.9-3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 5.5H17M10.5 12.5H17" strokeLinecap="round" />
    </svg>
  ),
  trend: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m3 14 4.5-4.5 3 3L17 6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 6H17v4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.2 13.2 3.8 3.8" strokeLinecap="round" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5.2 1.5 5.2h-13S5 12 5 8z" strokeLinejoin="round" />
      <path d="M8.3 16.2a1.8 1.8 0 0 0 3.4 0" strokeLinecap="round" />
    </svg>
  ),
  cog: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="2.4" />
      <path d="M10 2.6v2M10 15.4v2M4.8 4.8l1.4 1.4M13.8 13.8l1.4 1.4M2.6 10h2M15.4 10h2M4.8 15.2l1.4-1.4M13.8 6.2l1.4-1.4" strokeLinecap="round" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m5 8 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
};

const LIVE_TEXT: Record<string, { text: string; tone: ActivityItem["tone"] }> = {
  WORKING: { text: "Clocked in and working", tone: "emerald" },
  ON_BREAK: { text: "Currently on a break", tone: "amber" },
  IN_MEETING: { text: "In a meeting", tone: "indigo" },
  DONE: { text: "Finished the day", tone: "emerald" },
};

const PRESETS = ["Today", "Last 7 days", "This month", "Last month"] as const;

export default function HrDashboard() {
  const me = useMe();
  const [reload, setReload] = useState(0);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [query, setQuery] = useState("");
  const [bellOpen, setBellOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  useClickAway(bellRef, () => setBellOpen(false));
  useClickAway(addRef, () => setAddOpen(false));

  // The company's "today" comes from the server (it knows the company's
  // timezone). Everything else is derived from it. If that call fails the
  // browser's date is used so the page still works.
  const holidaysRes = useApi<HolidayResponse>("/holidays", reload);
  const today = holidaysRes.data?.today ?? (holidaysRes.error ? ymd(new Date()) : null);

  const from = range?.from ?? (today ? monthStart(today) : null);
  const to = range?.to ?? today;
  const span = from && to ? daysBetween(from, to) : 0;
  const rangeError =
    from && to && span < 1
      ? "The end date can't be before the start date."
      : span > 400
        ? "Pick a range of 400 days or fewer."
        : "";

  const groupBy = span > 62 ? "week" : "day";
  const userParam = employeeId ? `&userId=${encodeURIComponent(employeeId)}` : "";
  const rangePath =
    today && from && to && !rangeError
      ? `/reports?from=${from}&to=${to}&groupBy=${groupBy}${userParam}`
      : null;
  const todayPath = today ? `/reports?from=${today}&to=${today}&groupBy=person${userParam}` : null;

  const report = useApi<Report>(rangePath, reload);
  const todayReport = useApi<Report>(todayPath, reload);
  const users = useApi<{ users: AdminUser[] }>("/admin/users", reload);
  const live = useApi<LiveRow[]>("/tracker/team", reload);
  const alerts = useApi<AlertRow[]>("/tracker/alerts", reload);
  const tickets = useApi<{ tickets: Ticket[] }>("/tickets?scope=all", reload);
  const candidates = useApi<{ candidates: Candidate[] }>("/onboarding/candidates", reload);
  const queue = useApi<Queue>("/tasks/review/queue", reload);
  const corrApi = useApi<{ pending: number }>("/attendance-corrections/pending-count", reload);

  // --- derived numbers ----------------------------------------------------------
  // The page describes ONE company: the one you are signed into. An owner's
  // /admin/users, /tracker/team and /onboarding/candidates span every company,
  // while /reports is scoped to this one, so those lists are narrowed to match.
  // Otherwise "Total Employees" could say 62 next to "Present Today: 3 of 6".
  const myCompany = me?.platform.name ?? null;
  const inMyCompany = (company: string | null | undefined) =>
    !myCompany || !company || company === myCompany;

  const companyUsers = useMemo(
    () => (users.data?.users ?? []).filter((u) => inMyCompany(u.company)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [users.data, myCompany]
  );
  const companyUserIds = useMemo(() => new Set(companyUsers.map((u) => u.id)), [companyUsers]);
  const staff = useMemo(
    () => companyUsers.filter((u) => u.status !== "EXITED"),
    [companyUsers]
  );
  const activeCount = staff.filter((u) => u.status === "ACTIVE").length;
  const employeeOptions = useMemo(
    () =>
      staff
        .filter((u) => u.status === "ACTIVE")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [staff]
  );

  const totals = report.data?.totals;
  const todayTotals = todayReport.data?.totals;
  const q = query.trim().toLowerCase();

  const people = useMemo(
    () =>
      (report.data?.people ?? []).filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          (p.employeeCode ?? "").toLowerCase().includes(q) ||
          (p.designation ?? "").toLowerCase().includes(q)
      ),
    [report.data, q]
  );

  // Working days only: a Sunday with nobody expected is not an "absent" day.
  const chartRows: ChartRow[] = useMemo(
    () =>
      (report.data?.buckets ?? [])
        .filter((b) => b.daysExpected > 0)
        .map((b) => ({
          key: b.key,
          label: bucketLabel(b.key),
          present: b.daysPresent,
          absent: Math.max(0, b.daysExpected - b.daysPresent - b.daysOnLeave),
          productivity: Math.round((b.attainment || 0) * 100),
        })),
    [report.data]
  );

  // "Waiting for you" = still open AND the last word is the raiser's (or nobody has answered yet). Once staff have
  // replied, the ticket stays open until it is resolved but is no longer waiting on anyone here.
  const pendingTickets = (tickets.data?.tickets ?? []).filter(
    (t) => (t.status === "OPEN" || t.status === "IN_PROGRESS") && t.awaitingReply !== false
  );
  const overdueTickets = pendingTickets.filter((t) => t.isOverdue).length;
  const docsToReview = (candidates.data?.candidates ?? [])
    .filter((c) => inMyCompany(c.company))
    .reduce((n, c) => n + (Number(c.pendingReview) || 0), 0);
  const proposals = queue.data?.proposals?.length ?? 0;
  const corrections = corrApi.data?.pending ?? 0;
  const pendingTotal = pendingTickets.length + docsToReview + proposals + corrections;

  // Alerts about lateness are left out on purpose: attendance here is Present
  // or Absent, nothing in between.
  const visibleAlerts = (alerts.data ?? []).filter(
    (a) => a.alertType !== "LATE_LOGIN" && (!users.data || companyUserIds.has(a.userId))
  );

  const activity: ActivityItem[] = useMemo(() => {
    const items: ActivityItem[] = [];
    for (const r of live.data ?? []) {
      const meta = LIVE_TEXT[r.status];
      if (meta && r.loginAt && inMyCompany(r.company)) {
        items.push({ id: `l-${r.userId}`, userId: r.userId, at: r.loginAt, name: r.name, text: meta.text, tone: meta.tone });
      }
    }
    for (const a of visibleAlerts) {
      items.push({
        id: `a-${a.id}`,
        userId: a.userId,
        at: a.createdAt,
        name: a.name,
        text: a.message,
        tone: a.severity === "CRITICAL" ? "rose" : "amber",
      });
    }
    return items
      .filter((i) => (!employeeId || i.userId === employeeId) && (!q || i.name.toLowerCase().includes(q)))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 7);
    // visibleAlerts / inMyCompany are derived from the listed data on every
    // render, so the underlying data is what this memo must follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.data, alerts.data, users.data, myCompany, employeeId, q]);

  const upcoming = (holidaysRes.data?.holidays ?? [])
    .filter((h) => today && h.date >= today)
    .slice(0, 4);

  // --- actions -------------------------------------------------------------------------
  function applyPreset(name: (typeof PRESETS)[number]) {
    if (!today) return;
    if (name === "Today") setRange({ from: today, to: today });
    else if (name === "Last 7 days") setRange({ from: addDays(today, -6), to: today });
    else if (name === "This month") setRange({ from: monthStart(today), to: today });
    else setRange(previousMonth(today));
  }

  const activePreset = !today || !from || !to
    ? null
    : from === today && to === today
      ? "Today"
      : from === addDays(today, -6) && to === today
        ? "Last 7 days"
        : from === monthStart(today) && to === today
          ? "This month"
          : from === previousMonth(today).from && to === previousMonth(today).to
            ? "Last month"
            : null;

  const firstName = me?.firstName ?? "";
  const attention = [
    proposals > 0 && `${proposals} task proposal${proposals === 1 ? "" : "s"}`,
    docsToReview > 0 && `${docsToReview} joiner document${docsToReview === 1 ? "" : "s"}`,
    pendingTickets.length > 0 && `${pendingTickets.length} open ticket${pendingTickets.length === 1 ? "" : "s"}`,
  ].filter(Boolean) as string[];
  const attentionReady = !queue.loading && !candidates.loading && !tickets.loading;
  const reviewHref = proposals > 0 ? "/dashboard/approvals" : docsToReview > 0 ? "/dashboard/candidates" : "/dashboard/queries";

  const rangeTag = from && to ? rangeLabel(from, to) : "…";
  const dim = report.loading && report.data ? "opacity-60 transition-opacity" : "transition-opacity";

  return (
    <div className="page-fluid grid gap-5 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_320px] xl:grid-rows-[auto_1fr]">
      {/* profile row: first on small screens, top of the right column on wide ones */}
      <div className="flex items-center justify-end gap-3 xl:col-start-2 xl:row-start-1">
        <Link
          href="/dashboard/admin?tab=Teams"
          aria-label="Teams, shifts and rules"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-500 shadow-[var(--shadow-card)] hover:text-indigo-600"
        >
          {Ico.cog}
        </Link>

        <div ref={bellRef} className="relative">
          <button
            onClick={() => setBellOpen((v) => !v)}
            aria-label="Notifications"
            className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-500 shadow-[var(--shadow-card)] hover:text-indigo-600"
          >
            {Ico.bell}
            {pendingTotal + visibleAlerts.length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
                {Math.min(99, pendingTotal + visibleAlerts.length)}
              </span>
            )}
          </button>
          {bellOpen && (
            <div className="absolute right-0 z-20 mt-2 w-72 space-y-2 rounded-xl bg-white p-3 shadow-[var(--shadow-lift)] ring-1 ring-indigo-100">
              <p className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Needs attention</p>
              {pendingTotal + visibleAlerts.length === 0 ? (
                <p className="px-1 py-2 text-xs text-slate-500">You&apos;re all caught up.</p>
              ) : (
                <>
                  {proposals > 0 && <ApprovalRow href="/dashboard/approvals" label="Task proposals" count={proposals} tone="violet" />}
                  {docsToReview > 0 && <ApprovalRow href="/dashboard/candidates" label="Joiner documents" count={docsToReview} tone="sky" />}
                  {pendingTickets.length > 0 && <ApprovalRow href="/dashboard/queries" label="Open queries" count={pendingTickets.length} tone="amber" />}
                  {corrections > 0 && <ApprovalRow href="/dashboard/queries?category=ATTENDANCE_CORRECTION" label="Attendance corrections" count={corrections} tone="indigo" />}
                  {visibleAlerts.length > 0 && <ApprovalRow href="/dashboard/team-attendance" label="Alerts today" count={visibleAlerts.length} tone="rose" />}
                </>
              )}
            </div>
          )}
        </div>

        <Link href="/dashboard/profile" className="flex items-center gap-2.5">
          <span className="text-right leading-tight">
            <span className="block text-[13px] font-semibold text-slate-900">
              {me ? `${me.firstName} ${me.lastName}`.trim() : ""}
            </span>
            <span className="block text-[11px] text-slate-400">View profile</span>
          </span>
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-600 text-[13px] font-semibold text-white ring-2 ring-white">
            {me ? initials(`${me.firstName} ${me.lastName}`) : ""}
          </span>
        </Link>
      </div>


      {/* ===================== centre column ===================== */}
      <div className="min-w-0 space-y-5 xl:col-start-1 xl:row-span-2 xl:row-start-1">
        {/* search + quick actions */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-w-[14rem] flex-1 items-center gap-2 rounded-xl bg-white px-4 py-2.5 shadow-[var(--shadow-card)] focus-within:ring-2 focus-within:ring-[var(--ring)]">
            <span className="text-slate-400">{Ico.search}</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search employees by name, ID or role…"
              aria-label="Search employees"
              className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400"
            />
          </label>

          {/* HR and Admin only: this whole screen is. The backend checks the role too. */}
          <EmployeeActions onDone={() => setReload((n) => n + 1)} />

          <div ref={addRef} className="relative">
            <button
              onClick={() => setAddOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-600/25 hover:bg-indigo-700"
            >
              Add New {Ico.chevron}
            </button>
            {addOpen && (
              <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-xl bg-white py-1.5 text-sm shadow-[var(--shadow-lift)] ring-1 ring-indigo-100">
                {[
                  ["/dashboard/admin", "Add an employee"],
                  ["/dashboard/offers", "Send an offer letter"],
                  ["/dashboard/holidays", "Add a holiday"],
                  ["/dashboard/projects", "Create a project"],
                  ["/dashboard/queries", "Query Desk"],
                ].map(([href, label]) => (
                  <Link
                    key={href}
                    href={href}
                    className="block px-4 py-2 text-slate-700 hover:bg-indigo-50 hover:text-indigo-700"
                  >
                    {label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* welcome banner */}
        <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-600 to-indigo-500 p-6 text-white shadow-[var(--shadow-lift)] sm:p-8">
          <svg
            aria-hidden
            viewBox="0 0 320 200"
            className="pointer-events-none absolute -right-6 -top-2 hidden h-[115%] w-auto text-white/15 sm:block"
            fill="currentColor"
          >
            <path d="M160 190C70 170 40 90 110 30c10 60 50 80 50 160z" />
            <path d="M170 190c10-70 50-100 120-110-10 80-50 110-120 110z" opacity=".7" />
            <circle cx="262" cy="34" r="22" opacity=".5" />
            <circle cx="40" cy="150" r="10" opacity=".6" />
          </svg>
          <div className="relative max-w-md">
            <h1 className="text-2xl font-bold tracking-tight sm:text-[28px]">
              {greeting()} {firstName}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-indigo-100">
              {!attentionReady
                ? "Checking what needs your attention…"
                : attention.length === 0
                  ? "Nothing is waiting for you right now. Everything is up to date."
                  : `Waiting for you: ${attention.join(", ")}.`}
            </p>
            {attentionReady && attention.length > 0 && (
              <Link
                href={reviewHref}
                className="mt-4 inline-block rounded-lg bg-white px-4 py-1.5 text-xs font-semibold text-indigo-700 shadow-sm hover:bg-indigo-50"
              >
                Review it
              </Link>
            )}
          </div>
        </section>

        {/* filters */}
        <Card className="p-4">
          <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">Period</p>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    onClick={() => applyPreset(p)}
                    disabled={!today}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      activePreset === p
                        ? "bg-indigo-600 text-white shadow-sm"
                        : "bg-[#EEF0FD] text-indigo-700 hover:bg-indigo-100"
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-end gap-2">
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-slate-400">From</span>
                <input
                  type="date"
                  value={from ?? ""}
                  max={today ?? undefined}
                  disabled={!today}
                  onChange={(e) => e.target.value && to && setRange({ from: e.target.value, to })}
                  className="rounded-lg bg-[#EEF0FD] px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-[var(--ring)]"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-slate-400">To</span>
                <input
                  type="date"
                  value={to ?? ""}
                  max={today ?? undefined}
                  disabled={!today}
                  onChange={(e) => e.target.value && from && setRange({ from, to: e.target.value })}
                  className="rounded-lg bg-[#EEF0FD] px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-[var(--ring)]"
                />
              </label>
            </div>

            <label className="block min-w-44">
              <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-slate-400">Employee</span>
              <select
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="w-full rounded-lg bg-[#EEF0FD] px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-[var(--ring)]"
              >
                <option value="">All employees</option>
                {employeeOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.employeeCode ? ` (${u.employeeCode})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <button
              onClick={() => setReload((n) => n + 1)}
              className="ml-auto rounded-lg px-3 py-1.5 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-50"
            >
              Refresh
            </button>
          </div>
          {rangeError && <p className="mt-3 text-xs text-rose-600">{rangeError}</p>}
        </Card>

        {holidaysRes.error && (
          <ErrorNote
            message={`Couldn't load the company calendar (${holidaysRes.error}). Using your browser's date instead.`}
            onRetry={() => setReload((n) => n + 1)}
          />
        )}
        {report.error && !report.data && (
          <ErrorNote message={`Couldn't load the report: ${report.error}`} onRetry={() => setReload((n) => n + 1)} />
        )}

        {/* stat tiles */}
        <div className={`grid grid-cols-2 gap-3 lg:grid-cols-3 ${dim}`}>
          <StatTile
            label="Total Employees"
            value={String(staff.length)}
            sub={`${staff.length - activeCount} not yet active`}
            tag="Company"
            tone="indigo"
            icon={Ico.people}
            loading={!users.data}
          />
          <StatTile
            label="Present Today"
            value={String(todayTotals?.daysPresent ?? 0)}
            sub={
              todayTotals && todayTotals.daysExpected === 0 && todayTotals.daysPresent === 0
                ? "Not a working day"
                : `of ${todayTotals?.daysExpected ?? 0} expected`
            }
            tag="Today"
            tone="emerald"
            icon={Ico.check}
            loading={!todayTotals}
          />
          <StatTile
            label="Absent Today"
            value={String(todayTotals?.daysAbsent ?? 0)}
            sub="Expected, not clocked in"
            tag="Today"
            tone="rose"
            icon={Ico.cross}
            loading={!todayTotals}
          />
          <StatTile
            label="Active Employees"
            value={String(activeCount)}
            sub={staff.length ? `${pct(activeCount / staff.length)} of all employees` : undefined}
            tag="Company"
            tone="sky"
            icon={Ico.bolt}
            loading={!users.data}
          />
          <StatTile
            label="Tasks Completed"
            value={String(totals?.tasksDone ?? 0)}
            sub={`of ${totals?.tasksTotal ?? 0} approved tasks`}
            tag={rangeTag}
            tone="violet"
            icon={Ico.tasks}
            loading={!totals}
          />
          <StatTile
            label="Overall Productivity"
            value={pct(totals?.attainment ?? 0)}
            sub="productive ÷ expected time"
            tag={rangeTag}
            tone="amber"
            icon={Ico.trend}
            loading={!totals}
          />
        </div>

        {/* charts */}
        <div className={`grid gap-5 lg:grid-cols-2 ${dim}`}>
          <Card className="p-5">
            <SectionTitle
              title="Attendance"
              sub={`Present vs absent per ${groupBy === "day" ? "working day" : "week"} · ${rangeTag}`}
            />
            {!report.data ? (
              <Skeleton className="h-60" />
            ) : chartRows.length === 0 ? (
              <EmptyNote>No working days with attendance expected in this range.</EmptyNote>
            ) : (
              <AttendanceChart rows={chartRows} />
            )}
          </Card>
          <Card className="p-5">
            <SectionTitle
              title="Productivity"
              sub={`Productive time against expected · ${rangeTag}`}
            />
            {!report.data ? (
              <Skeleton className="h-60" />
            ) : chartRows.length === 0 ? (
              <EmptyNote>No productivity recorded in this range.</EmptyNote>
            ) : (
              <ProductivityChart rows={chartRows} />
            )}
          </Card>
        </div>

        {/* performance table */}
        <Card className={`p-5 ${dim}`}>
          <SectionTitle
            title="Employee Performance"
            sub={`${people.length} ${people.length === 1 ? "person" : "people"} · ${rangeTag}`}
            action={
              <Link
                href="/dashboard/reports"
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
              >
                View All
              </Link>
            }
          />
          {!report.data ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : people.length === 0 ? (
            <EmptyNote>{q ? "No employee matches your search." : "No employees in this report."}</EmptyNote>
          ) : (
            <PerformanceTable people={people} />
          )}
        </Card>
      </div>

      {/* ===================== right panel ===================== */}
      <aside className="min-w-0 space-y-5 xl:col-start-2 xl:row-start-2">
        {/* schedule calendar + upcoming events */}
        <Card className="p-5">
          <SectionTitle
            title="Schedule Calendar"
            sub={today ? "Tap a day to view just that day" : undefined}
            action={
              <Link href="/dashboard/holidays" className="rounded-lg bg-[#EEF0FD] px-2.5 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100">
                Holidays
              </Link>
            }
          />
          {!today ? (
            <Skeleton className="h-20" />
          ) : (
            <WeekStrip
              today={today}
              selected={from === to ? from : null}
              holidays={holidaysRes.data?.holidays ?? []}
              onPick={(d) => setRange({ from: d, to: d })}
            />
          )}
          <p className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Upcoming events</p>
          {!holidaysRes.data ? (
            holidaysRes.error ? (
              <EmptyNote>Events unavailable right now.</EmptyNote>
            ) : (
              <Skeleton className="h-14" />
            )
          ) : upcoming.length === 0 ? (
            <EmptyNote>No upcoming holidays or events.</EmptyNote>
          ) : (
            <EventsList holidays={upcoming} today={today!} />
          )}
        </Card>

        {/* pending approvals */}
        <Card className="p-5">
          <SectionTitle title="Pending HR Approvals" sub="Waiting for a decision" />
          {queue.error && candidates.error && tickets.error ? (
            <ErrorNote message="Couldn't load approvals." onRetry={() => setReload((n) => n + 1)} />
          ) : !attentionReady && pendingTotal === 0 ? (
            <div className="space-y-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : pendingTotal === 0 ? (
            <EmptyNote>Nothing is waiting for approval.</EmptyNote>
          ) : (
            <div className="space-y-2">
              {proposals > 0 && (
                <ApprovalRow href="/dashboard/approvals" label="Task proposals" detail="Employees' proposed work for today" count={proposals} tone="violet" />
              )}
              {docsToReview > 0 && (
                <ApprovalRow href="/dashboard/candidates" label="Joiner documents" detail="Submitted, waiting for HR review" count={docsToReview} tone="sky" />
              )}
              {corrections > 0 && (
                <ApprovalRow href="/dashboard/queries?category=ATTENDANCE_CORRECTION" label="Attendance corrections" detail="Employees asking HR to correct attendance" count={corrections} tone="indigo" />
              )}
              {pendingTickets.length > 0 && (
                <ApprovalRow
                  href="/dashboard/queries"
                  label="Open queries"
                  detail={overdueTickets > 0 ? `${overdueTickets} past due` : "All within their due time"}
                  count={pendingTickets.length}
                  tone="amber"
                />
              )}
            </div>
          )}
        </Card>

        {/* recent activity */}
        <Card className="p-5">
          <SectionTitle
            title="Recent Employee Activity"
            sub="Today"
            action={
              <Link href="/dashboard/team-attendance" className="rounded-lg bg-[#EEF0FD] px-2.5 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100">
                Live team
              </Link>
            }
          />
          {live.error && alerts.error ? (
            <ErrorNote message="Couldn't load activity." onRetry={() => setReload((n) => n + 1)} />
          ) : !live.data && !alerts.data ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : activity.length === 0 ? (
            <EmptyNote>No activity yet today.</EmptyNote>
          ) : (
            <ActivityList items={activity} />
          )}
        </Card>
      </aside>
    </div>
  );
}
