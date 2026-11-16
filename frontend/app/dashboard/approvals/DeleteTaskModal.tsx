"use client";

import { useState } from "react";
import { Modal } from "../_employees/Modal";
import { formatDate } from "@/lib/time";

const MIN = 3;
const MAX = 300;

// Same codes the server accepts (tasks.delete.logic.ts). "Other" needs a written note; for the rest the note is optional.
const REASONS = [
  { value: "WRONG_EMPLOYEE", label: "Assigned to the wrong employee" },
  { value: "WRONG_PROJECT", label: "Submitted under the wrong project" },
  { value: "MISTAKE", label: "Approved or rated by mistake" },
  { value: "DUPLICATE", label: "Duplicate task" },
  { value: "OTHER", label: "Other (write a note)" },
] as const;

type Props = {
  who: string;
  title: string;
  date: string | null;
  project: string | null;
  rated: boolean;
  busy: boolean;
  error: string;
  onSubmit: (reasonCode: string, note: string) => void;
  onCancel: () => void;
};

// Deleting is a soft delete: nothing is erased. The task leaves every active list, count and report, and stays on file for HR/Admin.
export function DeleteTaskModal({ who, title, date, project, rated, busy, error, onSubmit, onCancel }: Props) {
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const trimmed = note.trim();
  const noteOk = trimmed.length <= MAX && (code !== "OTHER" || trimmed.length >= MIN);
  const ok = code !== "" && noteOk;
  const day = date ? formatDate(`${date}T12:00:00Z`, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "—";
  return (
    <Modal
      title="Delete task"
      subtitle="You are about to remove this task from the active records."
      onClose={onCancel}
      width="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
          <button type="button" onClick={() => ok && onSubmit(code, trimmed)} disabled={busy || !ok} className="rounded-xl bg-rose-600 px-5 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50">
            {busy ? "Deleting…" : "Delete task"}
          </button>
        </div>
      }
    >
      <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5 rounded-xl bg-slate-50 px-3.5 py-3 text-sm">
        <dt className="text-slate-500">Employee</dt>
        <dd className="break-words font-medium text-slate-900">{who || "—"}</dd>
        <dt className="text-slate-500">Task</dt>
        <dd className="break-words text-slate-900 [overflow-wrap:anywhere]">{title}</dd>
        <dt className="text-slate-500">Original date</dt>
        <dd className="text-slate-900">{day}</dd>
        {project && (
          <>
            <dt className="text-slate-500">Project</dt>
            <dd className="break-words text-slate-900">{project}</dd>
          </>
        )}
      </dl>

      <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800" role="alert">
        This task will be removed from the active task records and from reporting (productivity, task counts and ratings){rated ? ", including its rating" : ""}. The employee will be told and cannot edit or resubmit it. It is not erased: HR and Admin can still see it, with who deleted it and why.
      </p>

      <label className="mt-4 block text-sm text-slate-600">
        Reason (required)
        <select value={code} onChange={(e) => setCode(e.target.value)} className="mt-1 block w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800">
          <option value="">Choose a reason</option>
          {REASONS.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </label>
      <label className="mt-3 block text-sm text-slate-600">
        Note {code === "OTHER" ? <span className="text-rose-500">(required)</span> : <span className="text-slate-400">(optional)</span>}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={MAX}
          rows={3}
          placeholder={code === "OTHER" ? "Why is this task being deleted?" : "Anything the employee or HR should know"}
          className="mt-1 block w-full resize-y break-words rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800 [overflow-wrap:anywhere]"
        />
      </label>
      <p className="mt-1 text-xs text-slate-400">{note.length}/{MAX}{code === "OTHER" ? ` · at least ${MIN} characters` : ""}. The employee sees the reason.</p>
      {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
