"use client";

// The change history of one task: every edit and every correction step, newest first, with who, when, what changed (old -> new), the approval
// before and after, and (for corrections) the reason, the decision and the rating that was cleared. Read only.
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { formatDateTime } from "@/lib/time";
import { Modal } from "../_employees/Modal";
import { fieldChanges } from "./editTypes";

type Change = {
  id: string; type: "EDIT" | "CORRECTION_REQUESTED" | "CORRECTION_APPROVED" | "CORRECTION_REJECTED"; at: string; by: string; byRole: string | null; changed: string[];
  before: Record<string, unknown>; after: Record<string, unknown>; approvalBefore: string; approvalAfter: string; reason: string | null; decisionNote: string | null;
  previousRejection: string | null; rating: { rating: number; comment: string | null; ratedAt: string } | null; ratingCleared: boolean; state: "PENDING" | "APPROVED" | "REJECTED" | null;
};
type History = { ready: boolean; task: { title: string; employee: string; date: string; project: string | null; approvalStatus: string } | null; changes: Change[]; pending: { requestId: string; at: string } | null };

const TITLE: Record<Change["type"], string> = { EDIT: "Edited", CORRECTION_REQUESTED: "Correction requested", CORRECTION_APPROVED: "Correction approved", CORRECTION_REJECTED: "Correction declined" };
const TONE: Record<Change["type"], string> = { EDIT: "bg-violet-50 text-violet-700", CORRECTION_REQUESTED: "bg-amber-50 text-amber-700", CORRECTION_APPROVED: "bg-emerald-50 text-emerald-700", CORRECTION_REJECTED: "bg-rose-50 text-rose-700" };
const STATE: Record<string, string> = { PENDING: "Waiting for the manager", APPROVED: "Approved", REJECTED: "Declined" };
const approval = (a: string) => ({ PENDING: "Pending", APPROVED: "Approved", REJECTED: "Sent back" }[a] ?? a);

export function TaskHistoryModal({ taskId, title, onClose }: { taskId: string; title: string; onClose: () => void }) {
  const [state, setState] = useState<{ data?: History; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    apiGet<History>(`/tasks/${taskId}/changes`)
      .then((data) => live && setState({ data }))
      .catch((e: Error) => live && setState({ error: e.message }));
    return () => { live = false; };
  }, [taskId]);

  return (
    <Modal title="Task history" subtitle={title} onClose={onClose} width="max-w-2xl">
      {!state && <div className="skeleton h-24" aria-busy="true" />}
      {state?.error && <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">{state.error}</p>}
      {state?.data && !state.data.ready && <p className="text-sm text-slate-500">History is not available yet.</p>}
      {state?.data?.ready && (
        <div data-testid="task-history" className="space-y-3">
          {state.data.pending && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">A correction is waiting for the manager&apos;s decision.</p>}
          {state.data.changes.length === 0 && <p className="text-sm text-slate-500">This task has not been edited.</p>}
          {state.data.changes.map((c) => {
            const lines = fieldChanges(c.before, c.after);
            return (
              <article key={c.id} className="rounded-xl border border-indigo-100 p-3">
                <header className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[c.type]}`}>{TITLE[c.type]}{c.type === "CORRECTION_REQUESTED" && c.state ? ` · ${STATE[c.state]}` : ""}</span>
                  <span className="text-xs text-slate-500">{c.by}{c.byRole ? ` (${c.byRole.toLowerCase()})` : ""} · {formatDateTime(c.at, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                </header>
                <ul className="mt-2 divide-y divide-indigo-50 text-sm">
                  {lines.map((l) => (
                    <li key={l.label} className="py-1.5">
                      <span className="text-xs font-medium text-slate-500">{l.label}: </span>
                      <span className="break-words text-slate-400 line-through [overflow-wrap:anywhere]">{l.from}</span> <span aria-hidden="true">→</span> <span className="break-words font-medium text-slate-900 [overflow-wrap:anywhere]">{l.to}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-xs text-slate-500">Approval: {approval(c.approvalBefore)} → {approval(c.approvalAfter)}</p>
                {c.reason && <p className="mt-1.5 break-words rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700 [overflow-wrap:anywhere]"><span className="font-medium">Reason:</span> {c.reason}</p>}
                {c.decisionNote && <p className="mt-1.5 break-words rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700 [overflow-wrap:anywhere]"><span className="font-medium">Manager&apos;s note:</span> {c.decisionNote}</p>}
                {c.previousRejection && <p className="mt-1.5 break-words rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-800 [overflow-wrap:anywhere]"><span className="font-medium">Previously sent back:</span> {c.previousRejection}</p>}
                {c.ratingCleared && c.rating && <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900"><span className="font-medium">Earlier rating kept here:</span> {c.rating.rating}/5{c.rating.comment ? ` · “${c.rating.comment}”` : ""}. It was cleared so the task can be rated again.</p>}
              </article>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
