"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// MANAGER STEP (shared by Leave and Attendance corrections)
// A request goes to the person's manager first; HR decides afterwards. These are the small pieces both pages share:
// how to word where a request is, and the Approve / Reject box a manager uses. The server enforces every rule.
// ---------------------------------------------------------------------------

export type ManagerStep = { status: string; approvers: string[]; decidedBy: string | null; decidedAt: string | null; note: string | null } | null | undefined;

/** The badge wording while a request is still open ("PENDING"); null = use the normal wording. */
export function stepBadge(requestStatus: string, step: ManagerStep): string | null {
  if (requestStatus !== "PENDING" || !step) return null;
  if (step.status === "PENDING") return "Waiting for manager";
  if (step.status === "APPROVED") return "Manager approved · waiting for HR";
  return null;
}

/** One plain sentence about the manager step, or nothing when the request had none. */
export function StepNote({ step }: { step: ManagerStep }) {
  if (!step) return null;
  const who = step.approvers.join(" or ");
  let text = "";
  if (step.status === "PENDING") text = `Manager step: waiting for ${who || "the manager"}`;
  else if (step.status === "APPROVED") text = `Manager step: approved by ${step.decidedBy ?? "the manager"}${step.note ? ` · “${step.note}”` : ""}`;
  else if (step.status === "REJECTED") text = `Manager step: rejected by ${step.decidedBy ?? "the manager"}${step.note ? ` · “${step.note}”` : ""}`;
  else if (step.status === "SKIPPED") text = `Manager step skipped: HR decided without the manager${step.note ? ` · “${step.note}”` : ""}`;
  return <p className="mt-1 text-xs text-slate-500">{text}</p>;
}

/** The manager's Approve / Reject controls for one request. A rejection needs a reason of at least 3 characters. */
export function ManagerDecisionBox({ busy, onDecide, approveLabel = "Approve", hint = "After you approve, HR makes the final decision. A rejection is final." }: { busy: boolean; onDecide: (decision: "APPROVE" | "REJECT", note: string) => void; approveLabel?: string; hint?: string }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy} onClick={() => onDecide("APPROVE", note)} className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{approveLabel}</button>
        <button disabled={busy} onClick={() => setRejecting((v) => !v)} className="rounded-lg border border-red-200 px-3.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">Reject</button>
        <span className="text-xs text-slate-400">{hint}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={rejecting ? "Reason for rejecting (required)" : "Comment (optional)"} className="min-w-[16rem] flex-1 rounded-xl border border-indigo-100 px-3 py-2 text-sm" />
        {rejecting && (
          <button disabled={busy || note.trim().length < 3} onClick={() => onDecide("REJECT", note)} className="rounded-lg bg-red-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">Confirm reject</button>
        )}
      </div>
    </div>
  );
}

/** HR only: decide while the manager has not answered yet. Needs a written reason (at least 5 characters). */
export function SkipManagerBox({ busy, onDecide }: { busy: boolean; onDecide: (decision: "APPROVE" | "REJECT", reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return <button disabled={busy} onClick={() => setOpen(true)} className="rounded-lg border border-indigo-100 px-3.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Decide without the manager</button>;
  }
  const ok = reason.trim().length >= 5;
  return (
    <div className="mt-2 w-full space-y-2 rounded-xl border border-indigo-100 p-3">
      <p className="text-xs text-slate-500">The manager has not answered yet. Give the reason you are deciding without them; it is kept on record.</p>
      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Reason (at least 5 characters)" className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm" />
      <div className="flex flex-wrap gap-2">
        <button disabled={busy || !ok} onClick={() => onDecide("APPROVE", reason)} className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Approve</button>
        <button disabled={busy || !ok} onClick={() => onDecide("REJECT", reason)} className="rounded-lg bg-red-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">Reject</button>
        <button onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50">Cancel</button>
      </div>
    </div>
  );
}
