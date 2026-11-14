"use client";

import { useState } from "react";
import Link from "next/link";
import { useRoleGate } from "../_routing/useRoleGate";
import LeaveApprovalQueue from "../_approvals/LeaveApprovalQueue";
import TaskApprovalQueue from "../_approvals/TaskApprovalQueue";
import { KpiCard } from "../_dashboard/widgets";

// ---------------------------------------------------------------------------
// APPROVAL CENTRE (Admin). Everything that is waiting for THIS Admin's answer, in one place, with the buttons to answer it:
//   - leave tagged to the Admin (a Manager's leave: first stage, HR decides after; HR's own leave: final with the Admin)
//   - tasks employees tagged to the Admin as approver
// Nothing else needs an Admin: attendance corrections and the final leave step are HR's, and the seeing-everything pages are Leave Oversight
// (all leave requests, leave taken) and Task Monitoring. Only an Admin may open this page.
// ---------------------------------------------------------------------------

const icon = (d: string) => (
  <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export default function ApprovalCentrePage() {
  const { allowed } = useRoleGate(["ADMIN"]);
  const [leave, setLeave] = useState<number | null>(null);
  const [tasks, setTasks] = useState<number | null>(null);
  if (!allowed) return null;
  const total = (leave ?? 0) + (tasks ?? 0);

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">
        What is waiting for your answer. To see every leave request and the leave taken, open{" "}
        <Link href="/dashboard/leave" className="font-medium text-indigo-700 hover:underline">Leave Oversight</Link>.
      </p>

      <section aria-label="Waiting for you" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="Waiting for you" value={leave === null || tasks === null ? "…" : String(total)} sub="leave and tasks" tone="amber" icon={icon("M10 5v5l3 2M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14z")} />
        <KpiCard label="Leave requests" value={leave === null ? "…" : String(leave)} sub="first-stage approvals" tone="sky" icon={icon("M5 3v2M15 3v2M3.5 8h13M4.5 5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z")} />
        <KpiCard label="Tasks" value={tasks === null ? "…" : String(tasks)} sub="tagged to you" tone="green" icon={icon("M4 10.5l4 4 8-9")} />
      </section>

      <LeaveApprovalQueue onCount={setLeave} />
      <TaskApprovalQueue onCount={setTasks} />
    </div>
  );
}
