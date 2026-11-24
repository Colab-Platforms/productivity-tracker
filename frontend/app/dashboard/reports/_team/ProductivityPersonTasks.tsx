"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { dayLabel } from "./format";
import { durationShort } from "../../_timer/TaskTimer";
import { PROGRESS_LABEL } from "../../_progress/progress";

// The tasks behind one person's row in the Task Productivity report (opened by clicking the person). Real records from
// GET /team-attendance/productivity/person: the tasks the report counts from, and (apart, never added to the figures) tasks a manager assigned.

export type TaskSummary = {
  inPeriod: number; approved: number; awaitingApproval: number; rejected: number; completedAwaitingApproval: number; completedWithoutTime: number; open: number; overdue: number;
  assigned: { total: number; open: number; awaitingConfirmation: number; confirmed: number };
};
export type Reason = "HAS_DATA" | "NO_TASKS" | "AWAITING_APPROVAL" | "NO_COMPLETION_TIME" | "NONE_COMPLETED";

type Submitted = { id: string; title: string; description: string | null; date: string; submittedAt: string; priority: string; progress: string; approvalStatus: string; taggedManager: string | null; reportingManager: string | null; completedAt: string | null; counted: boolean; inScore?: boolean; scoreCompleted?: boolean; ratingStatus?: string; rating?: number | null; timer?: { tracked: boolean; activeSeconds: number } };
type Assigned = { id: string; title: string; description: string | null; priority: string; assignedBy: string; assignedOn: string; due: string | null; overdue: boolean; stage: string; completedAt: string | null; confirmedAt: string | null };
type Person = { from: string; to: string; person: { name: string; employeeCode: string | null }; submitted: Submitted[]; assigned: Assigned[] };

const APPROVAL: Record<string, string> = { PENDING: "Waiting for approval", APPROVED: "Approved", REJECTED: "Rejected" };
const STAGE: Record<string, string> = { TODO: "To do", IN_PROGRESS: "In progress", AWAITING_CONFIRMATION: "Done, waiting for the manager", CONFIRMED: "Confirmed", CANCELLED: "Removed" };
const PRIORITY: Record<string, string> = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
const stamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
const th = "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500 whitespace-nowrap";
const td = "px-3 py-2 align-top text-slate-700";

export const REASON_TEXT: Record<Reason, string> = {
  HAS_DATA: "",
  NO_TASKS: "No tasks submitted in this period",
  AWAITING_APPROVAL: "Tasks are waiting for approval",
  NO_COMPLETION_TIME: "Completed without a completion time",
  NONE_COMPLETED: "No task finished yet",
};

export function Counts({ s }: { s: TaskSummary }) {
  const items: [string, number, string][] = [
    ["Submitted", s.inPeriod, "Tasks dated in the period that are approved or waiting for approval"],
    ["Approved", s.approved, "Approved by the manager"],
    ["Waiting for approval", s.awaitingApproval, "Not counted until the manager approves"],
    ["Open", s.open, "Approved, not finished"],
    ["Overdue", s.overdue, "Open, and the task date is before today"],
    ["Rejected", s.rejected, "Sent back / not approved"],
    ["Manager-assigned", s.assigned.total, "Assigned by a manager. Shown apart: not part of the productivity figures"],
  ];
  return (
    <div className="flex flex-wrap gap-2" data-testid="task-counts">
      {items.map(([l, n, tip]) => (
        <span key={l} title={tip} className="rounded-full bg-white px-3 py-1 text-xs text-slate-600 ring-1 ring-indigo-100">{l} <strong className="ml-1 tabular-nums text-slate-900">{n}</strong></span>
      ))}
    </div>
  );
}

export default function PersonTasks({ userId, from, to, hrQuery, summary }: { userId: string; from: string; to: string; hrQuery: string; summary: TaskSummary }) {
  const [data, setData] = useState<Person | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const load = useCallback(async () => {
    try {
      setData(await apiGet<Person>(`/team-attendance/productivity/person?userId=${userId}&from=${from}&to=${to}${hrQuery ? `&${hrQuery}` : ""}`));
      setError("");
    } catch (e) { setError((e as Error).message || "Could not load the tasks."); }
  }, [userId, from, to, hrQuery]);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load, tick]);

  return (
    <div className="space-y-4" data-testid="person-tasks">
      <Counts s={summary} />
      {error && (
        <p role="alert" className="flex items-center justify-between rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Couldn&apos;t load the tasks: {error}
          <button onClick={() => { setError(""); setTick((n) => n + 1); }} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium hover:bg-red-100">Retry</button>
        </p>
      )}
      {!data && !error && <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-9" />)}</div>}
      {data && (
        <>
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Tasks submitted for approval · {dayLabel(data.from)}{data.to !== data.from ? ` to ${dayLabel(data.to)}` : ""}</p>
            {data.submitted.length === 0 ? (
              <p className="rounded-xl bg-white px-4 py-4 text-sm text-slate-500" data-testid="no-submitted">No tasks were submitted by this person in the selected dates{summary.assigned.total > 0 ? ", but a manager assigned some (below)" : ""}.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-indigo-50">
                <table className="w-full min-w-[900px] text-xs">
                  <thead className="bg-slate-50"><tr><th className={th}>Task</th><th className={th}>Description</th><th className={th}>Sent to (approver)</th><th className={th}>Task date</th><th className={th}>Submitted</th><th className={th}>Completed</th><th className={th}>Status</th><th className={th}>Approval</th><th className={th}>Priority</th><th className={`${th} text-right`}>Time spent</th><th className={`${th} text-right`}>Counted</th></tr></thead>
                  <tbody>
                    {data.submitted.map((t) => (
                      <tr key={t.id} className="border-t border-indigo-50" data-testid="task-row">
                        <td className={`${td} font-medium text-slate-900`}>{t.title}</td>
                        <td className={`${td} max-w-xs`}><span className="line-clamp-2 break-words">{t.description || "—"}</span></td>
                        <td className={td}>{t.taggedManager ?? t.reportingManager ?? "—"}</td>
                        <td className={`${td} whitespace-nowrap`}>{dayLabel(t.date)}</td>
                        <td className={`${td} whitespace-nowrap`}>{stamp(t.submittedAt)}</td>
                        <td className={`${td} whitespace-nowrap`}>{stamp(t.completedAt)}</td>
                        <td className={td}>{PROGRESS_LABEL[t.progress as keyof typeof PROGRESS_LABEL] ?? t.progress}</td>
                        <td className={td}>{APPROVAL[t.approvalStatus] ?? t.approvalStatus}</td>
                        <td className={td} title={t.inScore ? (t.scoreCompleted ? (t.ratingStatus === "RATED" ? `Completed and rated ${t.rating}/5` : "Completed, pending manager evaluation") : "Eligible, not completed") : "Not part of the performance score (not approved, or dated outside the period)"}>{PRIORITY[t.priority] ?? t.priority}</td>
                        <td className={`${td} text-right tabular-nums`}>{t.timer?.tracked ? durationShort(t.timer.activeSeconds) : <span className="text-slate-400">Not tracked</span>}</td>
                        <td className={`${td} text-right`}>{t.counted ? "Yes" : "No"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          {data.assigned.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Assigned by a manager (not part of the productivity figures)</p>
              <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-indigo-50">
                <table className="w-full min-w-[820px] text-xs">
                  <thead className="bg-slate-50"><tr><th className={th}>Task</th><th className={th}>Description</th><th className={th}>Assigned by</th><th className={th}>Assigned on</th><th className={th}>Due</th><th className={th}>Completed</th><th className={th}>Status</th><th className={th}>Priority</th></tr></thead>
                  <tbody>
                    {data.assigned.map((a) => (
                      <tr key={a.id} className="border-t border-indigo-50" data-testid="assigned-row">
                        <td className={`${td} font-medium text-slate-900`}>{a.title}</td>
                        <td className={`${td} max-w-xs`}><span className="line-clamp-2 break-words">{a.description || "—"}</span></td>
                        <td className={td}>{a.assignedBy}</td>
                        <td className={`${td} whitespace-nowrap`}>{stamp(a.assignedOn)}</td>
                        <td className={`${td} whitespace-nowrap`}>{a.due ? dayLabel(a.due) : "—"}{a.overdue ? <span className="ml-1 text-red-600">overdue</span> : null}</td>
                        <td className={`${td} whitespace-nowrap`}>{stamp(a.completedAt)}</td>
                        <td className={td}>{STAGE[a.stage] ?? a.stage}</td>
                        <td className={td}>{PRIORITY[a.priority] ?? a.priority}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
