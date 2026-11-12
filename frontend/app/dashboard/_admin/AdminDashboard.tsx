"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { useMe } from "../layout";
import { roleLabel } from "@/lib/roles";
import EmployeeActions from "../_employees/EmployeeActions";
import { useRealtime } from "@/lib/realtime";
import { AnniversaryList, EmployeeStatusTable, EventsList, KpiCard, Muted, Panel, panelLink, upcomingAnniversaries, type EventItem, type StatusRow } from "../_dashboard/widgets";

// ---------------------------------------------------------------------------
// ADMIN DASHBOARD (the Admin's landing page; HR keeps its own).
// 1 overview cards · 2 who reports to whom · 3 attendance and leave · 4 productivity and tasks · 5 pending approvals · 6 recent activity ·
// 7 quick actions. Every card is a link to the detailed page, with the filter applied where that page supports one in its address.
// All numbers come from /admin-console/overview (read-only, built from the same engines the detailed pages use) plus the same pending-item
// endpoints the HR dashboard reads. Nothing is calculated here.
// ---------------------------------------------------------------------------

type Counts = Record<string, number>;
type Overview = {
  today: string;
  timezone: string;
  people: {
    total: number;
    byRole: Counts;
    byCompany: { id: string; name: string; people: number }[];
    projects: number;
    companies: number;
    managers: { id: string; name: string; employeeCode: string | null; employees: number }[];
    unmappedCount: number;
  };
  attendance: { today: Counts; trend: { date: string; counts: Counts }[]; peopleTracked: number };
  leave: { awaitingHr: number; awaitingFirstLevel: number; awaitingMyApproval: number; onLeaveNext14Days: { date: string; people: number }[] };
  productivity: { trend: { date: string; people: number; avgHours: number }[]; todayAvgHours: number };
  tasks: { today: TaskCounts; week: TaskCounts & { hoursSpent: number } };
  activity: { id: string; at: string; actor: { name: string; role: string | null } | null; module: string; action: string; summary: string }[];
};
type TaskCounts = { planned: number; approved: number; pendingApproval: number; completed: number };

const card = "rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]";
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", day: "numeric", timeZone: "UTC" });
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function useGet<T>(path: string | null, reload = 0) {
  const [res, setRes] = useState<{ data?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    apiGet<T>(path).then((data) => live && setRes((prev) => ({ ...prev, data, error: undefined }))).catch((e: Error) => live && setRes((prev) => ({ data: prev?.data, error: e.message })));
    return () => {
      live = false;
    };
  }, [path, reload]);
  return { data: res?.data ?? null, error: res?.error ?? "", loading: path !== null && res === null };
}

const STAT_LOOK: Record<string, { tone: "green" | "rose" | "sky" | "amber" | "violet" | "slate"; icon: React.ReactNode }> = {
  People: { tone: "green", icon: <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="7.5" cy="7" r="2.6" /><path d="M2.6 16c0-2.6 2.2-4.3 4.9-4.3s4.9 1.7 4.9 4.3M13.4 5.1a2.4 2.4 0 0 1 0 4.4M14.6 11.9c1.6.5 2.8 1.9 2.8 4.1" strokeLinecap="round" /></svg> },
  Managers: { tone: "violet", icon: <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10" cy="6.5" r="2.8" /><path d="M4.5 16c0-3 2.5-4.7 5.5-4.7s5.5 1.7 5.5 4.7" strokeLinecap="round" /></svg> },
  Companies: { tone: "slate", icon: <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 17V4.5h8V17M12 8.5h4V17M2.5 17h15M7 8h2M7 11h2" strokeLinecap="round" strokeLinejoin="round" /></svg> },
  Projects: { tone: "slate", icon: <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 5.5 4.6 7 7.5 4M3 12.5 4.6 14l2.9-3M10.5 5.5H17M10.5 12.5H17" strokeLinecap="round" strokeLinejoin="round" /></svg> },
  "Present today": { tone: "green", icon: <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="10" cy="10" r="7.2" /><path d="m6.8 10.2 2.2 2.2 4.2-4.6" strokeLinecap="round" strokeLinejoin="round" /></svg> },
  "On leave today": { tone: "sky", icon: <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3.5" y="4.5" width="13" height="12" rx="2" /><path d="M3.5 8.5h13M7 3v3M13 3v3" strokeLinecap="round" /></svg> },
  "Late today": { tone: "amber", icon: <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10" cy="10" r="7.2" /><path d="M10 6v4.2l2.8 1.6" strokeLinecap="round" strokeLinejoin="round" /></svg> },
  "Needs your attention": { tone: "amber", icon: <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M10 3 2.8 16h14.4zM10 8v4M10 14h.01" strokeLinecap="round" strokeLinejoin="round" /></svg> },
};

function Stat({ label, value, href, hint }: { label: string; value: number | string; href: string; hint?: string; tone?: string }) {
  const look = STAT_LOOK[label] ?? STAT_LOOK.People;
  return <KpiCard label={label} value={String(value)} sub={hint} tone={look.tone} icon={look.icon} href={href} />;
}

function Section({ title, hint, href, children }: { title: string; hint?: string; href?: string; children: React.ReactNode }) {
  return (
    <section className={card}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
        </div>
        {href && <Link href={href} className="shrink-0 text-xs font-medium text-indigo-600 hover:underline">Open</Link>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

// One bar per day, stacked by status. Plain boxes (no chart library) so it follows the light and dark themes.
const SEG: [string, string, string][] = [
  ["PRESENT", "bg-emerald-500", "Present"],
  ["LATE", "bg-amber-400", "Late"],
  ["HALF_DAY", "bg-orange-400", "Half day"],
  ["LEAVE", "bg-sky-400", "Leave"],
  ["HALF_DAY_LEAVE", "bg-cyan-400", "Half-day leave"],
  ["ABSENT", "bg-red-400", "Absent"],
];

function AttendanceBars({ trend }: { trend: Overview["attendance"]["trend"] }) {
  const max = Math.max(1, ...trend.map((t) => SEG.reduce((n, [k]) => n + (t.counts[k] ?? 0), 0)));
  return (
    <div>
      <div className="flex h-36 items-end gap-2" role="img" aria-label="Attendance for the last seven days">
        {trend.map((t) => {
          const total = SEG.reduce((n, [k]) => n + (t.counts[k] ?? 0), 0);
          return (
            <div key={t.date} className="flex h-full flex-1 flex-col justify-end" title={SEG.map(([k, , l]) => `${l}: ${t.counts[k] ?? 0}`).join(" · ")}>
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-md" style={{ height: `${(total / max) * 100}%` }}>
                {SEG.map(([k, cls]) => (t.counts[k] ? <div key={k} className={cls} style={{ flexGrow: t.counts[k] }} /> : null))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-2">{trend.map((t) => <span key={t.date} className="flex-1 text-center text-[10px] text-slate-400">{dayLabel(t.date)}</span>)}</div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {SEG.map(([k, cls, l]) => <span key={k} className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${cls}`} />{l}</span>)}
      </div>
    </div>
  );
}

function HoursBars({ trend }: { trend: Overview["productivity"]["trend"] }) {
  const max = Math.max(1, ...trend.map((t) => t.avgHours));
  return (
    <div>
      <div className="flex h-28 items-end gap-2" role="img" aria-label="Average productive hours per person, last seven days">
        {trend.map((t) => (
          <div key={t.date} className="flex h-full flex-1 flex-col justify-end" title={`${t.avgHours} h average · ${t.people} people`}>
            <div className="w-full rounded-md bg-indigo-500" style={{ height: `${(t.avgHours / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-2">{trend.map((t) => <span key={t.date} className="flex-1 text-center text-[10px] text-slate-400">{dayLabel(t.date)}</span>)}</div>
    </div>
  );
}

function Row({ label, value, href, tone }: { label: string; value: number; href: string; tone?: string }) {
  return (
    <Link href={href} className="flex items-center justify-between rounded-xl px-3 py-2.5 text-sm transition hover:bg-indigo-50">
      <span className="text-slate-700">{label}</span>
      <span className={`min-w-8 rounded-full px-2 py-0.5 text-center text-xs font-semibold tabular-nums ${value > 0 ? tone ?? "bg-indigo-50 text-indigo-700" : "bg-slate-50 text-slate-400"}`}>{value}</span>
    </Link>
  );
}

export default function AdminDashboard() {
  const me = useMe();
  const [reload, setReload] = useState(0);
  // The ONE shared Socket.IO connection: a task, inbox or meeting signal re-reads the numbers (no polling, no second socket).
  useRealtime(["tasks:changed", "notifications:changed", "meetings:changed"], () => setReload((n) => n + 1));
  const ov = useGet<Overview>("/admin-console/overview", reload);
  const queue = useGet<{ proposals?: unknown[] }>("/tasks/review/queue", reload);
  const corr = useGet<{ pending: number }>("/attendance-corrections/pending-count", reload);
  const queries = useGet<{ needsYou: number }>("/queries/counts", reload);
  const joiners = useGet<{ candidates: { pendingReview: number }[] }>("/onboarding/candidates", reload);
  const d = ov.data;
  // Employee status, events and anniversaries use the same endpoints the Employees, Calendar and Team Huddle pages read.
  const users = useGet<{ users: { id: string; name: string; employeeCode: string | null; status: string; designation: string | null; teams?: { id: string; name: string }[]; dateOfJoining?: string | null; photoAt?: string | null }[] }>("/admin/users", reload);
  const calToday = useGet<{ rows: { userId: string; status: string }[] }>(d ? `/attendance-calendar?from=${d.today}&to=${d.today}` : null, reload);
  const holidays = useGet<{ today: string; holidays: { id: string; date: string; name: string }[] }>("/holidays", reload);
  const meetings = useGet<{ timezone: string; meetings: { id: string; title: string; startsAt: string; state: string }[] }>("/meetings?scope=upcoming", reload);
  const todayIso0 = d?.today ?? holidays.data?.today ?? "";
  const tz = meetings.data?.timezone ?? d?.timezone ?? "Asia/Kolkata";
  const dayIn = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const timeIn = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const events: EventItem[] = todayIso0
    ? [
        ...(holidays.data?.holidays ?? []).filter((h) => h.date >= todayIso0).map((h): EventItem => ({ id: `h-${h.id}`, date: h.date, title: h.name, kind: "Holiday", href: "/dashboard/holidays", today: h.date === todayIso0 })),
        ...(meetings.data?.meetings ?? []).filter((m) => m.state === "upcoming" || m.state === "ongoing").map((m): EventItem => ({ id: `m-${m.id}`, date: dayIn(m.startsAt), time: timeIn(m.startsAt), title: m.title, kind: "Meeting", href: `/dashboard/meetings?id=${m.id}`, today: dayIn(m.startsAt) === todayIso0 })).filter((e) => e.date >= todayIso0),
      ].sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? "")).slice(0, 6)
    : [];
  const attOf = new Map((calToday.data?.rows ?? []).map((r) => [r.userId, r.status]));
  const attLabel = (id: string) => { const st = attOf.get(id); return st === "PRESENT" || st === "LATE" || st === "HALF_DAY" ? "Present" : st === "LEAVE" || st === "HALF_DAY_LEAVE" ? "On leave" : st === "ABSENT" ? "Absent" : "—"; };
  const statusRows: StatusRow[] = (users.data?.users ?? []).filter((u) => u.status !== "EXITED").sort((a, b) => a.name.localeCompare(b.name))
    .map((u) => ({ id: u.id, name: u.name, code: u.employeeCode, photoAt: u.photoAt, designation: u.designation, department: (u.teams ?? []).map((t) => t.name).join(", "), status: u.status, attendance: attLabel(u.id) }));
  const anniversaries = todayIso0 ? upcomingAnniversaries((users.data?.users ?? []).map((u) => ({ ...u })), todayIso0) : [];
  const att = d?.attendance.today ?? {};
  const present = (att.PRESENT ?? 0) + (att.LATE ?? 0) + (att.HALF_DAY ?? 0);
  const onLeave = (att.LEAVE ?? 0) + (att.HALF_DAY_LEAVE ?? 0);
  const proposals = queue.data?.proposals?.length ?? 0;
  const docs = (joiners.data?.candidates ?? []).reduce((n, c) => n + (Number(c.pendingReview) || 0), 0);
  const pendingTotal = (d?.leave.awaitingMyApproval ?? 0) + (d?.leave.awaitingHr ?? 0) + proposals + (corr.data?.pending ?? 0) + (queries.data?.needsYou ?? 0) + docs;
  const todayIso = d?.today ?? "";
  const maxMgr = Math.max(1, ...(d?.people.managers.map((m) => m.employees) ?? [1]));

  return (
    <div className="page-fluid space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-slate-900">{me ? `Welcome, ${me.firstName}` : "Welcome"}</p>
          <p className="truncate text-[12px] text-[var(--text-secondary)]">Everything in your organization on one page. Select any card for the details.</p>
        </div>
        {/* 7. quick actions */}
        <div className="flex flex-wrap items-center gap-2" aria-label="Quick actions">
          <EmployeeActions onDone={() => setReload((n) => n + 1)} />
          <Link href="/dashboard/projects" className="flex h-10 items-center rounded-xl border border-indigo-200 bg-[var(--card)] px-3 text-sm font-medium text-indigo-700 hover:bg-indigo-50">Add Project</Link>
          <Link href="/dashboard/employees" className="flex h-10 items-center rounded-xl border border-indigo-200 bg-[var(--card)] px-3 text-sm font-medium text-indigo-700 hover:bg-indigo-50">Manage Employees</Link>
          <Link href="/dashboard/reports" className="flex h-10 items-center rounded-xl border border-indigo-200 bg-[var(--card)] px-3 text-sm font-medium text-indigo-700 hover:bg-indigo-50">View Reports</Link>
          <Link href="/dashboard/office-network" className="flex h-10 items-center rounded-xl border border-indigo-200 bg-[var(--card)] px-3 text-sm font-medium text-indigo-700 hover:bg-indigo-50">Office Network</Link>
        </div>
      </header>

      {ov.error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{ov.error}</p>}
      {ov.loading && <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-24" />)}</div>}

      {d && (
        <>
          {/* 1. overview cards */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="People" value={d.people.total} href="/dashboard/employees" hint={`${d.people.byRole.EMPLOYEE ?? 0} employees`} />
            <Stat label="Managers" value={d.people.byRole.MANAGER ?? 0} href="/dashboard/employees?role=MANAGER" />
            <Stat label="Companies" value={d.people.companies} href="/dashboard/companies" />
            <Stat label="Projects" value={d.people.projects} href="/dashboard/projects" />
            <Stat label="Present today" value={present} href="/dashboard/team-attendance" hint={`of ${d.attendance.peopleTracked}`} tone="text-emerald-700" />
            <Stat label="Late today" value={att.LATE ?? 0} href={`/dashboard/attendance-calendar?from=${todayIso}&to=${todayIso}&status=LATE`} />
            <Stat label="On leave today" value={onLeave} href={`/dashboard/attendance-calendar?from=${todayIso}&to=${todayIso}&status=LEAVE`} tone="text-sky-700" />
            <Stat label="Needs your attention" value={pendingTotal} href="#approvals" tone={pendingTotal > 0 ? "text-amber-700" : "text-slate-900"} />
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            {/* 2. distribution */}
            <Section title="Who reports to whom" hint="Employees under each manager" href="/dashboard/employees">
              {d.people.managers.length === 0 && <p className="text-sm text-slate-500">No managers yet.</p>}
              <ul className="space-y-2.5">
                {d.people.managers.map((m) => (
                  <li key={m.id}>
                    <Link href={`/dashboard/employees?q=${encodeURIComponent(m.employeeCode ?? m.name)}`} className="block">
                      <div className="flex items-center justify-between text-sm"><span className="text-slate-700">{m.name} <span className="text-xs text-slate-400">{m.employeeCode}</span></span><span className="tabular-nums text-slate-600">{m.employees}</span></div>
                      <div className="mt-1 h-1.5 rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${(m.employees / maxMgr) * 100}%` }} /></div>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-4 grid grid-cols-4 gap-2 text-center text-xs">
                {(["ADMIN", "HR", "MANAGER", "EMPLOYEE"] as const).map((r) => (
                  <Link key={r} href={`/dashboard/employees?role=${r}`} className="rounded-xl bg-[#F3F7F6] px-2 py-2 hover:bg-indigo-50">
                    <p className="text-base font-semibold tabular-nums text-slate-900">{d.people.byRole[r] ?? 0}</p>
                    <p className="text-slate-500">{roleLabel(r)}</p>
                  </Link>
                ))}
              </div>
              {d.people.byCompany.length > 1 && (
                <ul className="mt-4 divide-y divide-indigo-50 text-sm">
                  {d.people.byCompany.map((c) => <li key={c.id} className="flex justify-between py-1.5"><span className="text-slate-600">{c.name}</span><span className="tabular-nums text-slate-700">{c.people}</span></li>)}
                </ul>
              )}
              {d.people.unmappedCount > 0 && (
                <Link href="/dashboard/employees" className="mt-4 block rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-800 hover:bg-amber-100">
                  <span className="font-medium">{d.people.unmappedCount} {d.people.unmappedCount === 1 ? "person has" : "people have"} no valid reporting line yet.</span> Set it in Manage Employees.
                </Link>
              )}
            </Section>

            {/* 3. attendance and leave */}
            <Section title="Attendance and leave" hint="Last 7 days, same rules as the Calendar" href="/dashboard/attendance-calendar">
              <AttendanceBars trend={d.attendance.trend} />
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                <Link href={`/dashboard/attendance-calendar?from=${todayIso}&to=${todayIso}&status=LATE`} className="rounded-xl bg-amber-50 px-2 py-2 hover:bg-amber-100"><p className="text-base font-semibold tabular-nums text-amber-800">{att.LATE ?? 0}</p><p className="text-amber-700">Late today</p></Link>
                <Link href={`/dashboard/attendance-calendar?from=${todayIso}&to=${todayIso}&status=HALF_DAY`} className="rounded-xl bg-orange-50 px-2 py-2 hover:bg-orange-100"><p className="text-base font-semibold tabular-nums text-orange-800">{att.HALF_DAY ?? 0}</p><p className="text-orange-700">Half day</p></Link>
                <Link href={`/dashboard/attendance-calendar?from=${todayIso}&to=${todayIso}&status=ABSENT`} className="rounded-xl bg-red-50 px-2 py-2 hover:bg-red-100"><p className="text-base font-semibold tabular-nums text-red-700">{att.ABSENT ?? 0}</p><p className="text-red-600">Absent</p></Link>
              </div>
              <p className="mt-4 text-xs text-slate-500">
                Leave: <span className="font-medium text-slate-700">{d.leave.awaitingFirstLevel}</span> with their first approver · <span className="font-medium text-slate-700">{d.leave.awaitingHr}</span> waiting for HR ·{" "}
                <span className="font-medium text-slate-700">{d.leave.onLeaveNext14Days.reduce((n, x) => n + x.people, 0)}</span> leave days in the next 14 days
              </p>
            </Section>

            {/* 4. productivity and tasks */}
            <Section title="Productivity and tasks" hint="Average productive hours per person, last 7 days" href="/dashboard/reports">
              <HoursBars trend={d.productivity.trend} />
              <div className="mt-4 grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4">
                {[
                  ["Planned today", d.tasks.today.planned],
                  ["Approved", d.tasks.today.approved],
                  ["Waiting", d.tasks.today.pendingApproval],
                  ["Completed", d.tasks.today.completed],
                ].map(([l, v]) => (
                  <Link key={String(l)} href="/dashboard/approvals" className="rounded-xl bg-[#F3F7F6] px-2 py-2 hover:bg-indigo-50"><p className="text-base font-semibold tabular-nums text-slate-900">{v}</p><p className="text-slate-500">{l}</p></Link>
                ))}
              </div>
              <p className="mt-3 text-xs text-slate-500">This week: {d.tasks.week.planned} tasks planned, {d.tasks.week.completed} completed, {d.tasks.week.hoursSpent} hours recorded on them.</p>
            </Section>
          </div>

          <div className="grid gap-5 lg:grid-cols-2" id="approvals">
            {/* 5. pending approvals */}
            <Section title="Pending approvals" hint="What is waiting, and for whom">
              <div className="space-y-0.5">
                <Row label="Leave sent to you for approval" value={d.leave.awaitingMyApproval} href="/dashboard/leave?tab=team" tone="bg-amber-50 text-amber-700" />
                <Row label="Leave waiting for HR's final answer" value={d.leave.awaitingHr} href="/dashboard/leave?tab=review" tone="bg-sky-50 text-sky-700" />
                <Row label="Leave still with its first approver" value={d.leave.awaitingFirstLevel} href="/dashboard/leave?tab=review" />
                <Row label="Task approvals (managers decide; you can view)" value={proposals} href="/dashboard/approvals" />
                <Row label="Attendance corrections" value={corr.data?.pending ?? 0} href="/dashboard/corrections" />
                <Row label="Queries that need an answer" value={queries.data?.needsYou ?? 0} href="/dashboard/queries" />
                <Row label="Joiner documents to review" value={docs} href="/dashboard/candidates" />
              </div>
            </Section>

            {/* 6. recent activity */}
            <Section title="Recent organization activity" hint="Latest recorded changes" href="/dashboard/audit-logs">
              {d.activity.length === 0 && <p className="text-sm text-slate-500">Nothing recorded yet.</p>}
              <ul className="divide-y divide-indigo-50">
                {d.activity.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate text-slate-800">{a.summary || `${a.module} ${a.action.toLowerCase()}`}</p>
                      <p className="text-xs text-slate-400">{a.actor?.name ?? "System"} · {a.module}</p>
                    </div>
                    <span className="shrink-0 text-xs text-slate-400">{when(a.at)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          </div>

          {/* employee status, events and anniversaries (same components as the HR dashboard) */}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
            <Panel title="Employee Status" sub={`${statusRows.length} ${statusRows.length === 1 ? "person" : "people"}${statusRows.length > 8 ? " · showing the first 8" : ""}`} action={<Link href="/dashboard/employees" className={panelLink}>View all</Link>}>
              {!users.data ? <div className="space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10" />)}</div> : statusRows.length === 0 ? <Muted>No employees yet.</Muted> : <EmployeeStatusTable rows={statusRows.slice(0, 8)} />}
            </Panel>
            <div className="min-w-0 space-y-5">
              <Panel title="Events and Meetings" sub="Holidays and your upcoming meetings" action={<Link href="/dashboard/attendance-calendar" className={panelLink}>Calendar</Link>}>
                {!holidays.data && !meetings.data ? <div className="skeleton h-14" /> : events.length === 0 ? <Muted>No upcoming holidays or meetings.</Muted> : <EventsList items={events} />}
              </Panel>
              <Panel title="Work Anniversaries" sub="Next 30 days, from each person's date of joining">
                {!users.data ? <div className="skeleton h-14" /> : anniversaries.length === 0 ? <Muted>No work anniversaries in the next 30 days.</Muted> : <AnniversaryList items={anniversaries.slice(0, 5)} />}
              </Panel>
              <Panel title="Birthdays" sub="This month">
                <Muted>No birthday data yet. Date of birth is not collected in the HRMS, so none can be shown.</Muted>
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
