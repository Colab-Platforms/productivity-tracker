"use client";

import { useState } from "react";
import { Modal } from "../_employees/Modal";

const MIN = 3;
const MAX = 300;

// Shown at clock-in when the person is past the late cut-off. The clock does not start until a reason is given.
export function LateRemarkModal({ minutes, busy, error, onSubmit, onCancel }: { minutes: number; busy: boolean; error: string; onSubmit: (remark: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const ok = trimmed.length >= MIN && trimmed.length <= MAX;
  return (
    <Modal
      title="You're clocking in late"
      subtitle={`You are ${minutes} minute${minutes === 1 ? "" : "s"} past the late cut-off. Add a short reason so your manager can see it.`}
      onClose={onCancel}
      width="max-w-md"
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
          <button onClick={() => ok && onSubmit(trimmed)} disabled={busy || !ok} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "Clocking in…" : "Clock in"}
          </button>
        </div>
      }
    >
      <label className="block text-sm text-slate-600">
        Late remark
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX}
          rows={3}
          autoFocus
          placeholder="For example: traffic on the way, a doctor's visit, a power cut"
          className="mt-1 block w-full resize-y break-words rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800 [overflow-wrap:anywhere]"
        />
      </label>
      <p className="mt-1 text-xs text-slate-400">{text.length}/{MAX} · at least {MIN} characters. The late time still counts; this only records why.</p>
      {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
