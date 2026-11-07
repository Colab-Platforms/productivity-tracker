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
import { useRealtime } from "@/lib/realtime";
import { useMe } from "./layout";
import EmployeeActions from "./_employees/EmployeeActions";
import { AttendanceChart, ProductivityChart, type ChartRow } from "./_hr/Charts";
import OrgOverview from "./_approvals/OrgOverview";
import { AnniversaryList, EmployeeStatusTable, EventsList, KpiCard, Muted, Panel, panelLink, upcomingAnniversaries, type EventItem, type StatusRow } from "./_dashboard/widgets";
import {
  ActivityList,
  type ActivityItem,
  ApprovalRow,
  Card,
  EmptyNote,
  ErrorNote,
  PerformanceTable,
  SectionTitle,
  Skeleton,
  WeekStrip,
} from "./_hr/Panels";
import {
  addDays,
  bucketLabel,
  daysBetween,
  greeting,
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
  leave: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3.5" y="4.5" width="13" height="12" rx="2" />
      <path d="M3.5 8.5h13M7 3v3M13 3v3" strokeLinecap="round" />
    </svg>
  ),
  clock: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 6v4.2l2.8 1.6" strokeLinecap="round" strokeLinejoin="round" />
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
  // Today's and upcoming meetings: the same list the Team Huddle page reads (the signed-in person's own meetings).
  const meetingsRes = useApi<{ timezone: string; meetings: { id: string; title: string; startsAt: string; state: string }[] }>("/meetings?scope=upcoming", reload);
  // The ONE shared Socket.IO connection: when a task, an inbox item or a meeting changes the server sends a signal and the numbers are re-read.
  useRealtime(["tasks:changed", "notifications:changed", "meetings:changed"], () => setReload((n) => n + 1));

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

  // --- widgets built from the data above (display only; nothing is invented) ----------------------------------------------------------------------
  const tz = meetingsRes.data?.timezone ?? me?.platform.timezone ?? "Asia/Kolkata";
  const dayIn = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const timeIn = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const events: EventItem[] = today
    ? [
        ...(holidaysRes.data?.holidays ?? [])
          .filter((h) => h.date >= today)
          .map((h): EventItem => ({ id: `h-${h.id}`, date: h.date, title: h.name, kind: "Holiday", href: "/dashboard/holidays", today: h.date === today })),
        ...(meetingsRes.data?.meetings ?? [])
          .filter((m) => m.state === "upcoming" || m.state === "ongoing")
          .map((m): EventItem => ({ id: `m-${m.id}`, date: dayIn(m.startsAt), time: timeIn(m.startsAt), title: m.title, kind: "Meeting", href: `/dashboard/meetings?id=${m.id}`, today: dayIn(m.startsAt) === today }))
          .filter((e) => e.date >= today),
      ]
        .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""))
        .slice(0, 6)
    : [];
  const todayById = new Map((todayReport.data?.people ?? []).map((p) => [p.userId, p]));
  const attendanceOf = (id: string) => {
    const p = todayById.get(id);
    if (!p) return "—";
    return p.daysPresent > 0 ? "Present" : p.daysOnLeave > 0 ? "On leave" : p.daysAbsent > 0 ? "Absent" : "—";
  };
  const statusRows: StatusRow[] = staff
    .filter((u) => (!employeeId || u.id === employeeId) && (!q || u.name.toLowerCase().includes(q) || (u.employeeCode ?? "").toLowerCase().includes(q) || (u.designation ?? "").toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((u) => ({ id: u.id, name: u.name, code: u.employeeCode, photoAt: u.photoAt, designation: u.designation, department: (u.teams ?? []).map((t) => t.name).join(", "), status: u.status, attendance: attendanceOf(u.id) }));
  const anniversaries = today ? upcomingAnniversaries(staff, today) : [];

  return (
    <div className="page-fluid space-y-4 p-4 sm:p-6">
      {/* greeting strip + actions: one compact row instead of an oversized banner */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <p className="truncate text-[15px] font-semibold text-slate-900">{greeting()} {firstName}</p>
          <p className="truncate text-[12px] text-[var(--text-secondary)]">
            {!attentionReady
              ? "Checking what needs your attention…"
              : attention.length === 0
                ? "Nothing is waiting for you right now. Everything is up to date."
                : `Waiting for you: ${attention.join(", ")}.`}
            {attentionReady && attention.length > 0 && (
              <Link href={reviewHref} className="ml-2 font-medium text-indigo-600 hover:underline">Review it</Link>
            )}
          </p>
        </div>

        {/* HR and Admin only: this whole screen is. The backend checks the role too. */}
        <EmployeeActions onDone={() => setReload((n) => n + 1)} />

        <div ref={addRef} className="relative">
          <button
            onClick={() => setAddOpen((v) => !v)}
            className="flex h-10 items-center gap-1.5 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Add New {Ico.chevron}
          </button>
          {addOpen && (
            <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-xl bg-[var(--card)] py-1.5 text-sm shadow-[var(--shadow-lift)]">
              {[
                ["/dashboard/employees", "Add an employee"],
                ["/dashboard/offers", "Send an offer letter"],
                ["/dashboard/holidays", "Add a holiday"],
                ["/dashboard/queries", "Query Desk"],
              ].map(([href, label]) => (
                <Link key={href} href={href} className="block px-4 py-2 text-slate-700 hover:bg-[var(--nav-hover)] hover:text-indigo-700">
                  {label}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* "Needs attention": pending approvals and today's alerts (not the notification inbox, which is the bell in the header) */}
        <div ref={bellRef} className="relative">
          <button
            onClick={() => setBellOpen((v) => !v)}
            aria-label="Notifications"
            className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--card)] text-slate-500 shadow-[var(--shadow-card)] hover:text-indigo-600"
          >
            {Ico.bell}
            {pendingTotal + visibleAlerts.length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
                {Math.min(99, pendingTotal + visibleAlerts.length)}
              </span>
            )}
          </button>
          {bellOpen && (
            <div className="absolute right-0 z-20 mt-2 w-72 space-y-2 rounded-xl bg-[var(--card)] p-3 shadow-[var(--shadow-lift)]">
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
      </div>

      <OrgOverview />

      {/* period, employee and search filters (unchanged behaviour) */}
      <Card className="p-3.5">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <label className="block min-w-[13rem] flex-1">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-slate-400">Search</span>
            <span className="flex items-center gap-2 rounded-lg bg-[var(--brand-50)] px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-[var(--ring)]">
              <span className="text-slate-400">{Ico.search}</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name, ID or role…"
                aria-label="Search employees"
                className="min-w-0 flex-1 bg-transparent text-xs text-slate-800 outline-none placeholder:text-slate-400"
              />
            </span>
          </label>
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">Period</p>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => applyPreset(p)}
                  disabled={!today}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    activePreset === p ? "bg-indigo-600 text-white shadow-sm" : "bg-[var(--brand-50)] text-indigo-700 hover:bg-indigo-100"
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
                className="rounded-lg bg-[var(--brand-50)] px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-[var(--ring)]"
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
                className="rounded-lg bg-[var(--brand-50)] px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-[var(--ring)]"
              />
            </label>
          </div>

          <label className="block min-w-44">
            <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-slate-400">Employee</span>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="w-full rounded-lg bg-[var(--brand-50)] px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:ring-2 focus:ring-[var(--ring)]"
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

      {/* compact KPI strip */}
      <div className={`grid grid-cols-2 gap-3 md:grid-cols-4 ${dim}`}>
        <KpiCard label="Total Employees" value={String(staff.length)} sub={`${staff.length - activeCount} not yet active`} tone="green" icon={Ico.people} loading={!users.data} href="/dashboard/employees" />
        <KpiCard
          label="Present Today"
          value={String(todayTotals?.daysPresent ?? 0)}
          sub={todayTotals && todayTotals.daysExpected === 0 && todayTotals.daysPresent === 0 ? "Not a working day" : `of ${todayTotals?.daysExpected ?? 0} expected`}
          tone="green" icon={Ico.check} loading={!todayTotals} href="/dashboard/team-attendance"
        />
        <KpiCard label="Absent Today" value={String(todayTotals?.daysAbsent ?? 0)} sub="Expected, not clocked in" tone="rose" icon={Ico.cross} loading={!todayTotals} href="/dashboard/team-attendance" />
        <KpiCard label="On Leave Today" value={String(todayTotals?.daysOnLeave ?? 0)} sub="Approved leave" tone="sky" icon={Ico.leave} loading={!todayTotals} href="/dashboard/leave" />
        <KpiCard label="Pending Approvals" value={String(pendingTotal)} sub={pendingTotal === 0 ? "All clear" : "Waiting for a decision"} tone="amber" icon={Ico.clock} loading={!attentionReady && pendingTotal === 0} href="#approvals" />
        <KpiCard label="Active Employees" value={String(activeCount)} sub={staff.length ? `${pct(activeCount / staff.length)} of all employees` : undefined} tone="slate" icon={Ico.bolt} loading={!users.data} />
        <KpiCard label="Tasks Completed" value={String(totals?.tasksDone ?? 0)} sub={`of ${totals?.tasksTotal ?? 0} approved · ${rangeTag}`} tone="violet" icon={Ico.tasks} loading={!totals} />
        <KpiCard label="Overall Productivity" value={pct(totals?.attainment ?? 0)} sub={`productive ÷ expected · ${rangeTag}`} tone="amber" icon={Ico.trend} loading={!totals} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* ===================== main column ===================== */}
        <div className="min-w-0 space-y-4">
          <div className={`grid gap-4 lg:grid-cols-2 ${dim}`}>
            <Panel title="Team Performance" sub={`Productive time against expected · ${rangeTag}`}>
              {!report.data ? (
                <Skeleton className="h-60" />
              ) : chartRows.length === 0 ? (
                <EmptyNote>No productivity recorded in this range.</EmptyNote>
              ) : (
                <ProductivityChart rows={chartRows} />
              )}
            </Panel>
            <Panel title="Attendance" sub={`Present vs absent per ${groupBy === "day" ? "working day" : "week"} · ${rangeTag}`}>
              {!report.data ? (
                <Skeleton className="h-60" />
              ) : chartRows.length === 0 ? (
                <EmptyNote>No working days with attendance expected in this range.</EmptyNote>
              ) : (
                <AttendanceChart rows={chartRows} />
              )}
            </Panel>
          </div>

          {/* employee status */}
          <Panel
            title="Employee Status"
            sub={`${statusRows.length} ${statusRows.length === 1 ? "person" : "people"}${statusRows.length > 8 ? " · showing the first 8" : ""}`}
            action={<Link href="/dashboard/employees" className={panelLink}>View all</Link>}
          >
            {!users.data ? (
              <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : statusRows.length === 0 ? (
              <EmptyNote>{q || employeeId ? "No employee matches." : "No employees yet."}</EmptyNote>
            ) : (
              <EmployeeStatusTable rows={statusRows.slice(0, 8)} />
            )}
          </Panel>

          {/* performance table (unchanged) */}
          <Card className={`p-4 ${dim}`}>
            <SectionTitle
              title="Employee Performance"
              sub={`${people.length} ${people.length === 1 ? "person" : "people"} · ${rangeTag}`}
              action={
                <Link href="/dashboard/reports" className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">
                  View All
                </Link>
              }
            />
            {!report.data ? (
              <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-11" />)}</div>
            ) : people.length === 0 ? (
              <EmptyNote>{q ? "No employee matches your search." : "No employees in this report."}</EmptyNote>
            ) : (
              <PerformanceTable people={people} />
            )}
          </Card>
        </div>

        {/* ===================== side column ===================== */}
        <aside className="min-w-0 space-y-4">
          <Panel
            title="Events and Meetings"
            sub={today ? "Tap a day to view just that day" : undefined}
            action={<Link href="/dashboard/attendance-calendar" className={panelLink}>Calendar</Link>}
          >
            {!today ? (
              <Skeleton className="h-20" />
            ) : (
              <WeekStrip today={today} selected={from === to ? from : null} holidays={holidaysRes.data?.holidays ?? []} onPick={(d) => setRange({ from: d, to: d })} />
            )}
            <p className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Upcoming</p>
            {!holidaysRes.data && !meetingsRes.data ? (
              holidaysRes.error && meetingsRes.error ? <EmptyNote>Events unavailable right now.</EmptyNote> : <Skeleton className="h-14" />
            ) : events.length === 0 ? (
              <EmptyNote>No upcoming holidays or meetings.</EmptyNote>
            ) : (
              <EventsList items={events} />
            )}
          </Panel>

          <Panel id="approvals" title="Pending HR Approvals" sub="Waiting for a decision">
            {queue.error && candidates.error && tickets.error ? (
              <ErrorNote message="Couldn't load approvals." onRetry={() => setReload((n) => n + 1)} />
            ) : !attentionReady && pendingTotal === 0 ? (
              <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
            ) : pendingTotal === 0 ? (
              <EmptyNote>Nothing is waiting for approval.</EmptyNote>
            ) : (
              <div className="space-y-2">
                {proposals > 0 && <ApprovalRow href="/dashboard/approvals" label="Task proposals" detail="Employees' proposed work for today" count={proposals} tone="violet" />}
                {docsToReview > 0 && <ApprovalRow href="/dashboard/candidates" label="Joiner documents" detail="Submitted, waiting for HR review" count={docsToReview} tone="sky" />}
                {corrections > 0 && <ApprovalRow href="/dashboard/queries?category=ATTENDANCE_CORRECTION" label="Attendance corrections" detail="Employees asking HR to correct attendance" count={corrections} tone="indigo" />}
                {pendingTickets.length > 0 && (
                  <ApprovalRow href="/dashboard/queries" label="Open queries" detail={overdueTickets > 0 ? `${overdueTickets} past due` : "All within their due time"} count={pendingTickets.length} tone="amber" />
                )}
              </div>
            )}
          </Panel>

          <Panel title="Work Anniversaries" sub="Next 30 days, from each person's date of joining">
            {!users.data ? <Skeleton className="h-14" /> : anniversaries.length === 0 ? <Muted>No work anniversaries in the next 30 days.</Muted> : <AnniversaryList items={anniversaries.slice(0, 5)} />}
          </Panel>

          <Panel title="Birthdays" sub="This month">
            <Muted>No birthday data yet. Date of birth is not collected in the HRMS, so none can be shown.</Muted>
          </Panel>

          <Panel
            title="Recent Employee Activity"
            sub="Today"
            action={<Link href="/dashboard/team-attendance" className={panelLink}>Live team</Link>}
          >
            {live.error && alerts.error ? (
              <ErrorNote message="Couldn't load activity." onRetry={() => setReload((n) => n + 1)} />
            ) : !live.data && !alerts.data ? (
              <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
            ) : activity.length === 0 ? (
              <EmptyNote>No activity yet today.</EmptyNote>
            ) : (
              <ActivityList items={activity} />
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}
