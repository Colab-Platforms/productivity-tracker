"use client";

import { useState } from "react";
import { Modal } from "../_employees/Modal";
import { BLOCKED_REASON_MAX, BLOCKED_REASON_MIN, blockedReasonProblem } from "./progress";

// Asked when a task is set to Blocked: the employee says what is stopping the work. The reporting manager sees this reason.
export function BlockedReasonModal({ title, initial = "", busy, error, onSubmit, onCancel }: { title: string; initial?: string; busy: boolean; error: string; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const problem = blockedReasonProblem(text);
  return (
    <Modal
      title="Why is this task blocked?"
      subtitle={`“${title}”. Your reporting manager will see this reason.`}
      onClose={onCancel}
      width="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
          <button type="button" onClick={() => !problem && onSubmit(text.trim())} disabled={busy || !!problem} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "Saving…" : "Mark as blocked"}
          </button>
        </div>
      }
    >
      <label className="block text-sm text-slate-600">
        Blocked reason (required)
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={BLOCKED_REASON_MAX}
          rows={4}
          placeholder="For example: waiting for access to the client's system, missing information, a dependency on another team, a technical problem…"
          className="mt-1 block w-full resize-y break-words rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800 [overflow-wrap:anywhere]"
        />
      </label>
      <p className="mt-1 text-xs text-slate-400">{text.length}/{BLOCKED_REASON_MAX} · at least {BLOCKED_REASON_MIN} characters.</p>
      {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
