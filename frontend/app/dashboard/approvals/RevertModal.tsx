"use client";

import { useState } from "react";
import { Modal } from "../_employees/Modal";

const MIN = 3;
const MAX = 300;

const OPTIONS = [
  { value: "PARTIAL", label: "Partially completed", hint: "Some of the work is done, the rest is not. Say what remains." },
  { value: "NOT_FULL", label: "Not fully completed", hint: "It was marked completed by mistake, or the work was not really done. Say why." },
] as const;

// A manager sends a Completed task back to In Progress. Both options keep the employee's submission and the task's history; a remark is
// required before either one is confirmed, and the employee is told the kind and the remark.
export function RevertModal({ title, who, busy, error, onSubmit, onCancel }: { title: string; who: string; busy: boolean; error: string; onSubmit: (type: "PARTIAL" | "NOT_FULL", remark: string) => void; onCancel: () => void }) {
  const [type, setType] = useState<"PARTIAL" | "NOT_FULL" | "">("");
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const ok = type !== "" && trimmed.length >= MIN && trimmed.length <= MAX;
  return (
    <Modal
      title="Revert / Reopen task"
      subtitle={`“${title}”${who ? ` · ${who}` : ""}. It goes back to In Progress. Their submission and the task history are kept.`}
      onClose={onCancel}
      width="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
          <button onClick={() => ok && onSubmit(type, trimmed)} disabled={busy || !ok} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "Reopening…" : "Confirm"}
          </button>
        </div>
      }
    >
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm text-slate-600">What best describes it?</legend>
        {OPTIONS.map((o) => (
          <label key={o.value} className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 ${type === o.value ? "border-indigo-400 bg-indigo-50/60" : "border-indigo-100 hover:bg-slate-50"}`}>
            <input type="radio" name="revert-type" value={o.value} checked={type === o.value} onChange={() => setType(o.value)} className="mt-1" />
            <span>
              <span className="block text-sm font-medium text-slate-900">{o.label}</span>
              <span className="block text-xs text-slate-500">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="mt-4 block text-sm text-slate-600">
        Remark (required)
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX}
          rows={3}
          placeholder={type === "PARTIAL" ? "What is still incomplete?" : type === "NOT_FULL" ? "Why is it being reverted?" : "Choose an option, then explain"}
          className="mt-1 block w-full resize-y break-words rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800 [overflow-wrap:anywhere]"
        />
      </label>
      <p className="mt-1 text-xs text-slate-400">{text.length}/{MAX} · at least {MIN} characters. The employee is notified and sees this remark.</p>
      {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
