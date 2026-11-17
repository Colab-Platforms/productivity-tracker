"use client";

// One assigned task's comments and step-by-step history (newest at the bottom, like a conversation). The employee and the manager who assigned it can both
// read it and add a comment. Nothing here edits a past entry: the history only grows.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { formatDateTime } from "@/lib/time";
import { Modal } from "../_employees/Modal";
import { STAGE_LABEL, dayLabel, type Stage } from "./assignedTypes";

type Ev = { id: string; at: string; by: string; t: string; [k: string]: unknown };
type History = { title: string; events: Ev[] };

function line(e: Ev): { text: string; tone: string } {
  switch (e.t) {
    case "created": return { text: e.due ? `Assigned, due ${dayLabel(String(e.due))}` : "Assigned", tone: "text-slate-700" };
    case "edited": {
      const ch = (e.changes as { field: string; from: string | null; to: string | null }[]) ?? [];
      return { text: "Edited: " + ch.map((c) => (c.field === "Due date" ? `${c.field} ${dayLabel(c.from) || "none"} → ${dayLabel(c.to) || "none"}` : `${c.field} changed`)).join("; "), tone: "text-violet-700" };
    }
    case "progress": return { text: `${STAGE_LABEL[e.from as Stage] ?? e.from} → ${STAGE_LABEL[e.to as Stage] ?? e.to}${e.note ? `. Note: ${e.note}` : ""}`, tone: "text-sky-700" };
    case "comment": return { text: String(e.text), tone: "text-slate-900" };
    case "confirmed": return { text: `Confirmed as complete${e.note ? `. ${e.note}` : ""}`, tone: "text-emerald-700" };
    case "sent_back": return { text: `Sent back: ${e.reason}`, tone: "text-rose-700" };
    case "cancelled": return { text: "Removed before work started", tone: "text-slate-500" };
    default: return { text: "Updated", tone: "text-slate-600" };
  }
}

export function ThreadModal({ taskId, title, canComment, onClose, onChanged }: { taskId: string; title: string; canComment: boolean; onClose: () => void; onChanged: () => void }) {
  const [state, setState] = useState<{ data?: History; error?: string } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setState({ data: await apiGet<History>(`/tasks/assigned/${taskId}/history`) }); } catch (e) { setState({ error: (e as Error).message }); }
  }, [taskId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true); setError("");
    try { await apiPost(`/tasks/assigned/${taskId}/comment`, { text: text.trim() }); setText(""); await load(); onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal title="Comments and history" subtitle={title} onClose={onClose} width="max-w-xl">
      {!state && <div className="skeleton h-24" aria-busy="true" />}
      {state?.error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{state.error}</p>}
      {state?.data && (
        <ol data-testid="assigned-thread" className="space-y-3">
          {state.data.events.length === 0 && <li className="text-sm text-slate-500">Nothing recorded yet.</li>}
          {state.data.events.map((e) => {
            const l = line(e);
            return (
              <li key={e.id} className="rounded-xl border border-indigo-100 px-3 py-2">
                <p className="text-xs text-slate-500">{e.by} · {formatDateTime(e.at, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</p>
                <p className={`mt-0.5 break-words text-sm [overflow-wrap:anywhere] ${l.tone}`}>{l.text}</p>
              </li>
            );
          })}
        </ol>
      )}
      {canComment && (
        <div className="mt-4 space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            maxLength={500}
            aria-label="Add a comment"
            placeholder="Add a comment"
            className="w-full resize-y rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 [overflow-wrap:anywhere]"
          />
          {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
          <button type="button" onClick={() => void send()} disabled={busy || !text.trim()} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Add comment</button>
        </div>
      )}
    </Modal>
  );
}
