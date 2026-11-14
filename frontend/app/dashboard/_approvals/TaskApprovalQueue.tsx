"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost } from "@/lib/api";
import { plural } from "@/lib/plural";

// ---------------------------------------------------------------------------
// TASKS WAITING FOR THIS PERSON'S APPROVAL (Approval Centre, Admin).
// Only tasks the employee tagged to this Admin as approver appear (the server's own `proposals`: pending AND decidable by the viewer; HR and
// every other Admin only view them in Tasks & Performance). Same calls as that page: POST /tasks/review/:id/approve with approve true, or false
// plus a reason (sending it back needs one).
// ---------------------------------------------------------------------------

type Task = {
  id: string;
  title: string;
  description: string | null;
  weight: string;
  who?: string;
  employeeCode?: string | null;
  approvalStatus?: string;
  personName?: string | null;
  project?: string | null;
  hoursSpent?: number | null;
  progress?: string | null;
  date?: string;
  canAct?: boolean;
};
type Queue = { proposals: Task[]; all?: Task[] };

const WEIGHT: Record<string, string> = { LOW: "bg-slate-100 text-slate-600", MEDIUM: "bg-sky-50 text-sky-700", HIGH: "bg-amber-50 text-amber-700", CRITICAL: "bg-rose-50 text-rose-700" };
const PROGRESS: Record<string, string> = { COMPLETED: "Completed", IN_PROGRESS: "In progress", BLOCKED: "Blocked", NOT_STARTED: "Not started" };
const dayText = (iso?: string) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : null);

export default function TaskApprovalQueue({ onCount }: { onCount?: (waiting: number) => void }) {
  const [rows, setRows] = useState<Task[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [comments, setComments] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    apiGet<Queue>("/tasks/review/queue")
      .then((q) => {
        if (!live) return;
        // "all" carries who each task belongs to; a pending task the viewer may decide is exactly what the server calls a proposal
        const named = new Map((q.all ?? []).map((t) => [t.id, t]));
        const mine = (q.proposals ?? []).filter((t) => t.canAct !== false).map((t) => ({ ...t, ...(named.get(t.id) ?? {}) }));
        setRows(mine);
        setError("");
        onCount?.(mine.length);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // onCount is a plain callback from the parent; the list reloads only after a decision
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  async function decide(t: Task, approve: boolean, note?: string) {
    if (busy) return;
    setBusy(t.id);
    setError("");
    setNotice("");
    try {
      await apiPost(`/tasks/review/${t.id}/approve`, approve ? { approve: true, ...(note ? { comment: note } : {}) } : { approve: false, rejectionNote: note });
      setNotice(approve ? `Approved "${t.title}".` : `Sent back "${t.title}". The employee has been told why.`);
      setRejecting(null);
      setReason("");
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]" aria-label="Tasks waiting for your approval">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-900">Tasks sent to you for approval</h2>
          <p className="mt-1 text-sm text-slate-500">Only tasks an employee tagged to you as approver appear here. Until you approve a task it counts for nobody.</p>
        </div>
        <Link href="/dashboard/approvals" className="text-xs font-medium text-indigo-700 hover:underline">All tasks in Task Monitoring</Link>
      </div>
      {notice && <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}
      {!rows && !error && <div className="mt-4 skeleton h-20" />}
      {rows && rows.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">No tasks are waiting for you.</p>}
      <ul className="mt-4 divide-y divide-indigo-100">
        {rows?.map((t) => (
          <li key={t.id} className="py-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900">{t.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {t.who ?? t.personName ?? "Employee"}{t.employeeCode ? ` (${t.employeeCode})` : ""}
                  {t.project ? ` · ${t.project}` : ""}
                  {t.date ? ` · ${dayText(t.date)}` : ""}
                  {t.progress ? ` · ${PROGRESS[t.progress] ?? t.progress}` : ""}
                  {typeof t.hoursSpent === "number" ? ` · ${t.hoursSpent}h` : ""}
                </p>
                {t.description && <p className="mt-1 text-xs text-slate-500">{t.description}</p>}
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${WEIGHT[t.weight] ?? WEIGHT.LOW}`}>{t.weight.toLowerCase()}</span>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <input
                  value={comments[t.id] ?? ""}
                  onChange={(e) => setComments({ ...comments, [t.id]: e.target.value })}
                  maxLength={300}
                  aria-label="Comment (optional)"
                  placeholder="Comment (optional)"
                  className="h-9 w-40 rounded-xl border border-indigo-100 px-3 text-xs"
                />
                <button disabled={!!busy} onClick={() => void decide(t, true, comments[t.id]?.trim() || undefined)} className="h-9 rounded-xl bg-emerald-600 px-4 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
                  Approve
                </button>
                <button
                  disabled={!!busy}
                  onClick={() => {
                    setRejecting(rejecting === t.id ? null : t.id);
                    setReason("");
                  }}
                  className="h-9 rounded-xl border border-indigo-200 px-4 text-xs font-medium text-slate-600 hover:border-rose-300 hover:text-rose-700 disabled:opacity-40"
                >
                  Send back
                </button>
              </div>
            </div>
            {rejecting === t.id && (
              <div className="mt-3 flex flex-wrap gap-2">
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  autoFocus
                  maxLength={300}
                  placeholder="Why are you sending it back? They'll see this."
                  className="h-10 min-w-56 flex-1 rounded-xl border border-indigo-200 px-3 text-sm outline-none focus:border-indigo-500"
                />
                <button disabled={!!busy || !reason.trim()} onClick={() => void decide(t, false, reason.trim())} className="h-10 rounded-xl bg-rose-600 px-4 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-40">
                  Send back
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {rows && rows.length > 0 && <p className="mt-3 text-xs text-slate-400">{plural(rows.length, "task")} waiting.</p>}
    </section>
  );
}
