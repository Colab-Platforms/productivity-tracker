"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { useSupervisorGate } from "../_routing/useRoleGate";
import { KpiCard, Muted, Panel, panelLink } from "../_dashboard/widgets";

// ---------------------------------------------------------------------------
// PRODUCTIVITY SUPERVISOR DASHBOARD. The home of the two Productivity Supervisor accounts: an ordinary employee workspace (their own clock, tasks,
// leave) plus a READ-ONLY look at every employee in every company. Every figure comes from the same endpoints the Reports, Attendance and
// Tasks & Performance pages use, so it can never disagree with them; nothing here changes any record, and the server refuses every edit.
// ---------------------------------------------------------------------------

type Live = { date: string; scope: { orgTotal: number; filteredTotal: number }; summary: { online: number; clockedOut: number; notClockedIn: number; onLeave: number; present: number; total: number } };
type QueueTask = { status: string; approvalStatus: string; progress?: string };
type Queue = { date: string; all: QueueTask[]; members: unknown[] };
type Opts = { companies: { id: string; name: string; people: number }[]; projects: { id: string }[] };

const icon = (d: string) => (
  <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const I = {
  people: icon("M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 17c0-2.8 2-4.5 4.5-4.5s4.5 1.7 4.5 4.5M13.5 8.5a2.5 2.5 0 1 0 0-5M14 12.6c2 .2 3.5 1.7 3.5 4.4"),
  clock: icon("M10 5v5l3 2M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14z"),
  off: icon("M4 4l12 12M10 17a7 7 0 1 0-5-2"),
  leave: icon("M5 3v2M15 3v2M3.5 8h13M4.5 5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"),
  task: icon("M4 5h12M4 10h12M4 15h7"),
  done: icon("M4 10.5l4 4 8-9"),
  block: icon("M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM5.5 5.5l9 9"),
  wait: icon("M6 3h8M6 17h8M7 3c0 4 6 4 6 7s-6 3-6 7"),
};

export default function SupervisorDashboardPage() {
  const { me, allowed } = useSupervisorGate();
  const [live, setLive] = useState<Live | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [opts, setOpts] = useState<Opts | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!allowed) return;
    let stop = false;
    const load = () => {
      Promise.all([apiGet<Live>("/team-attendance/live"), apiGet<Queue>("/tasks/review/queue"), apiGet<Opts>("/hr-filters/options")])
        .then(([l, q, o]) => { if (!stop) { setLive(l); setQueue(q); setOpts(o); setError(""); } })
        .catch((e: Error) => { if (!stop) setError(e.message); });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { stop = true; clearInterval(t); };
  }, [allowed]);

  if (!me || !allowed) return null;
  const tasks = queue?.all ?? [];
  const n = (v: number | undefined) => (v === undefined ? "…" : String(v));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Welcome, {me.firstName}</h1>
        <p className="mt-1 text-sm text-slate-500">
          Productivity Supervisor. Your own work is below under My Workspace. Organization Monitoring is <b>view only</b>: you can look at everyone&apos;s productivity, but you cannot change anyone&apos;s records.
        </p>
      </header>

      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <section aria-label="Attendance today" className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Attendance today · all companies</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard label="Employees" value={n(live?.scope.orgTotal)} sub={opts ? `${opts.companies.length} companies · ${opts.projects.length} projects` : undefined} tone="green" icon={I.people} href="/dashboard/supervisor/employees" loading={!live} />
          <KpiCard label="Clocked in now" value={n(live?.summary.online)} sub={live ? `${live.summary.present} present today` : undefined} tone="sky" icon={I.clock} loading={!live} />
          <KpiCard label="Not clocked in" value={n(live?.summary.notClockedIn)} tone="rose" icon={I.off} loading={!live} />
          <KpiCard label="On leave" value={n(live?.summary.onLeave)} tone="amber" icon={I.leave} loading={!live} />
        </div>
      </section>

      <section aria-label="Tasks today" className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Tasks today · all companies</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard label="Tasks" value={queue ? String(tasks.length) : "…"} tone="green" icon={I.task} href="/dashboard/approvals" loading={!queue} />
          <KpiCard label="Completed" value={queue ? String(tasks.filter((t) => t.status === "COMPLETED").length) : "…"} tone="sky" icon={I.done} loading={!queue} />
          <KpiCard label="Blocked" value={queue ? String(tasks.filter((t) => t.progress === "BLOCKED").length) : "…"} tone="rose" icon={I.block} loading={!queue} />
          <KpiCard label="Waiting for a manager" value={queue ? String(tasks.filter((t) => t.approvalStatus === "PENDING").length) : "…"} tone="amber" icon={I.wait} loading={!queue} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel title="Companies" sub="People in each company you can monitor" className="lg:col-span-2" action={<Link href="/dashboard/supervisor/employees" className={panelLink}>All employees</Link>}>
          {!opts ? <div className="skeleton h-24" /> : opts.companies.length === 0 ? <Muted>No companies to show.</Muted> : (
            <ul className="divide-y divide-indigo-50">
              {opts.companies.map((c) => (
                <li key={c.id}>
                  <Link href={`/dashboard/supervisor/employees?company=${c.id}`} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:text-indigo-700">
                    <span className="truncate font-medium text-slate-800">{c.name}</span>
                    <span className="shrink-0 tabular-nums text-slate-500">{c.people} {c.people === 1 ? "person" : "people"}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="space-y-5">
          <Panel title="Monitoring" sub="Read only">
            <ul className="space-y-1.5 text-sm">
              {[
                ["/dashboard/supervisor/employees", "All Employees"],
                ["/dashboard/reports?tab=productivity", "Productivity Tracker"],
                ["/dashboard/approvals", "Tasks & Performance"],
                ["/dashboard/reports", "Reports & Analytics"],
              ].map(([href, label]) => (
                <li key={href}><Link href={href} className="font-medium text-indigo-700 hover:underline">{label}</Link></li>
              ))}
            </ul>
          </Panel>
          <Panel title="My Workspace" sub="Your own work">
            <ul className="space-y-1.5 text-sm">
              {[
                ["/dashboard/employee", "Clock In / Clock Out"],
                ["/dashboard/tasks", "My Daily Tasks"],
                ["/dashboard/attendance-calendar", "My Attendance"],
                ["/dashboard/leave", "My Leave"],
                ["/dashboard/meetings", "Meetings"],
              ].map(([href, label]) => (
                <li key={href}><Link href={href} className="font-medium text-indigo-700 hover:underline">{label}</Link></li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
