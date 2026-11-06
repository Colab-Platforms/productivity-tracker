"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";

// ---------------------------------------------------------------------------
// ORGANIZATION OVERVIEW CARD (leave and task approvals by role). Counts only; the Leave and Approvals pages hold the details.
//   HR / Admin: requests waiting for HR, requests still with their first approver, manager-wise distribution, people to map by hand
//   Manager:    leave and tasks waiting for them
//   Employee:   their own leave status and today's task approvals
// Shows nothing until the server answers, and nothing when there is nothing to say.
// ---------------------------------------------------------------------------

type Overview = {
  role: string;
  awaitingHr?: number;
  awaitingFirstLevel?: number;
  awaitingManager?: number;
  awaitingAdmin?: number;
  managers?: { id: string; name: string; employeeCode: string | null; employees: number }[];
  unmapped?: { count: number; people: { id: string; name: string; employeeCode: string | null; role: string }[] };
  awaitingMyLeaveApproval?: number;
  teamSize?: number;
  pendingTaskApprovals?: number;
  myPendingLeave?: { id: string; stage: string; label: string }[];
  myTasksToday?: Record<string, number>;
};

function Tile({ label, value, href, tone = "indigo" }: { label: string; value: number; href?: string; tone?: "indigo" | "amber" | "sky" | "emerald" | "rose" }) {
  const tones = { indigo: "bg-indigo-50 text-indigo-700", amber: "bg-amber-50 text-amber-700", sky: "bg-sky-50 text-sky-700", emerald: "bg-emerald-50 text-emerald-700", rose: "bg-rose-50 text-rose-700" };
  const body = (
    <div className={`rounded-xl px-4 py-3 ${tones[tone]}`}>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      <p className="text-xs">{label}</p>
    </div>
  );
  return href ? <Link href={href} className="block transition hover:opacity-90">{body}</Link> : body;
}

export default function OrgOverview() {
  const [d, setD] = useState<Overview | null>(null);
  useEffect(() => {
    let live = true;
    apiGet<Overview>("/leave/overview").then((r) => live && setD(r)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!d) return null;

  const isStaff = d.role === "HR" || d.role === "ADMIN";
  const tiles: React.ReactNode[] = [];
  if (isStaff) {
    tiles.push(<Tile key="hr" label="Leave waiting for HR's final answer" value={d.awaitingHr ?? 0} href="/dashboard/leave" tone="sky" />);
    tiles.push(<Tile key="first" label="Leave still with its first approver" value={d.awaitingFirstLevel ?? 0} href="/dashboard/leave" tone="amber" />);
    if (d.role === "ADMIN") tiles.push(<Tile key="adm" label="Leave sent to you for approval" value={d.awaitingMyLeaveApproval ?? 0} href="/dashboard/leave" tone="indigo" />);
  }
  if (d.role === "MANAGER") {
    tiles.push(<Tile key="ml" label="Team leave waiting for you" value={d.awaitingMyLeaveApproval ?? 0} href="/dashboard/leave" tone="amber" />);
    tiles.push(<Tile key="mt" label="Task approvals waiting for you" value={d.pendingTaskApprovals ?? 0} href="/dashboard/approvals" tone="indigo" />);
    tiles.push(<Tile key="ts" label="People reporting to you" value={d.teamSize ?? 0} tone="emerald" />);
  }
  if (d.role === "EMPLOYEE" || d.role === "MANAGER" || d.role === "HR") {
    const t = d.myTasksToday ?? {};
    if (d.role !== "MANAGER" && d.role !== "HR") {
      tiles.push(<Tile key="tp" label="Today's tasks waiting for approval" value={t.PENDING ?? 0} href="/dashboard/tasks" tone="amber" />);
      tiles.push(<Tile key="ta" label="Today's tasks approved" value={t.APPROVED ?? 0} href="/dashboard/tasks" tone="emerald" />);
      tiles.push(<Tile key="tr" label="Today's tasks sent back" value={t.REJECTED ?? 0} href="/dashboard/tasks" tone="rose" />);
    }
  }
  const mine = d.myPendingLeave ?? [];
  const showManagers = isStaff && (d.managers?.length ?? 0) > 0;
  const unmapped = d.unmapped?.count ?? 0;
  if (tiles.length === 0 && mine.length === 0 && !showManagers && unmapped === 0) return null;

  return (
    <section className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]" aria-label="Leave and approvals overview">
      <h2 className="text-sm font-semibold text-slate-900">Leave and approvals</h2>
      {tiles.length > 0 && <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">{tiles}</div>}
      {mine.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {mine.map((m) => (
            <Link key={m.id} href="/dashboard/leave" className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 hover:bg-indigo-50">
              <span>Your leave request</span>
              <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">{m.label}</span>
            </Link>
          ))}
        </div>
      )}
      {showManagers && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Employees by manager</p>
          <ul className="mt-2 divide-y divide-indigo-50 text-sm">
            {d.managers!.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-1.5">
                <span className="text-slate-700">{m.name} <span className="text-xs text-slate-400">{m.employeeCode}</span></span>
                <span className="tabular-nums text-slate-600">{m.employees}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {isStaff && unmapped > 0 && (
        <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <p className="font-medium">{unmapped} {unmapped === 1 ? "person has" : "people have"} no valid reporting line yet (an employee needs a Manager, a manager needs an Admin).</p>
          <p className="mt-1">{d.unmapped!.people.map((p) => `${p.name}${p.employeeCode ? ` (${p.employeeCode})` : ""}`).join(", ")}{unmapped > d.unmapped!.people.length ? " …" : ""}</p>
          <Link href="/dashboard/employees" className="mt-1 inline-block font-medium underline">Set it in Admin → People</Link>
        </div>
      )}
    </section>
  );
}
