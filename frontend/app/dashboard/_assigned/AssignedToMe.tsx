"use client";

// Employee side: "Assigned by manager". Work a manager handed over. The employee starts it, adds comments and marks it completed; the manager then
// confirms it or sends it back. No approval and no star rating here (those belong to the tasks the employee submitted).
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useTaskRealtime } from "@/lib/realtime";
import { FILTERS, STAGE_CHIP, STAGE_LABEL, dayLabel, filterCount, matchesFilter, type AssignedPayload, type AssignedTask, type FilterKey } from "./assignedTypes";
import { ThreadModal } from "./ThreadModal";
import { TaskTimer } from "../_timer/TaskTimer";

export function FilterChips({ tasks, value, onChange }: { tasks: AssignedTask[]; value: FilterKey; onChange: (k: FilterKey) => void }) {
  return (
    <div role="group" aria-label="Filter assigned tasks" className="flex flex-wrap gap-2">
      {FILTERS.map(([k, label]) => (
        <button
          key={k}
          type="button"
          aria-pressed={value === k}
          onClick={() => onChange(k)}
          className={"rounded-full px-3 py-1.5 text-xs font-medium " + (value === k ? "bg-indigo-600 text-white" : "bg-white text-slate-600 shadow-[var(--shadow-card)] hover:bg-indigo-50")}
        >
          {label} ({filterCount(tasks, k)})
        </button>
      ))}
    </div>
  );
}

export default function AssignedToMe({ onCount }: { onCount?: (n: number) => void }) {
  const [data, setData] = useState<AssignedPayload | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<FilterKey>("ALL");
  const [busy, setBusy] = useState("");
  const [finishing, setFinishing] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [thread, setThread] = useState<AssignedTask | null>(null);

  const load = useCallback(async () => {
    try {
      const p = await apiGet<AssignedPayload>("/tasks/assigned/mine");
      setData(p);
      onCount?.(p.counts.todo + p.counts.inProgress);
    } catch (e) { setError((e as Error).message); }
  }, [onCount]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useTaskRealtime(() => void load());

  async function move(t: AssignedTask, to: "TODO" | "IN_PROGRESS" | "COMPLETED", withNote?: string) {
    setBusy(t.id); setError("");
    try {
      const p = await apiPost<AssignedPayload>(`/tasks/assigned/${t.id}/progress`, { to, ...(withNote?.trim() ? { note: withNote.trim() } : {}) });
      setData(p); onCount?.(p.counts.todo + p.counts.inProgress);
      setFinishing(null); setNote("");
    } catch (e) { setError((e as Error).message); await load(); } finally { setBusy(""); }
  }

  if (!data && !error) return <div className="skeleton h-32" aria-busy="true" />;
  const tasks = data?.tasks ?? [];
  const shown = tasks.filter((t) => matchesFilter(t, filter));

  return (
    <div className="space-y-4" data-testid="assigned-to-me">
      {thread && <ThreadModal taskId={thread.id} title={thread.title} canComment={thread.stage !== "CONFIRMED"} onClose={() => setThread(null)} onChanged={() => void load()} />}
      <p className="text-sm text-slate-500">Work your manager gave you. Update your progress, add comments, and mark it completed; your manager then confirms it. These tasks are not part of the approval and rating of the tasks you submit yourself.</p>
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-800">{error}</p>}
      <FilterChips tasks={tasks} value={filter} onChange={setFilter} />
      {shown.length === 0 ? (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-slate-500 shadow-[var(--shadow-card)]">{tasks.length === 0 ? "No tasks have been assigned to you." : "No tasks match this filter."}</p>
      ) : (
        <ul className="space-y-3">
          {shown.map((t) => (
            <li key={t.id} data-testid="assigned-card" className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-slate-900 [overflow-wrap:anywhere]">{t.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Assigned by {t.assignedBy || "your manager"}{t.project ? ` · ${t.project}` : ""}{t.due ? ` · due ${dayLabel(t.due)}` : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400" data-testid="assigned-dates">Assigned {dayLabel(t.assignedOn.slice(0, 10))}{t.rating ? ` · manager rating ${t.rating}/5` : ""}</p>
                  <TaskTimer timer={t.timer} status={t.stage === "IN_PROGRESS" ? "IN_PROGRESS" : t.stage === "TODO" ? "PENDING" : "COMPLETED"} onStale={() => void load()} />
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {t.overdue && <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">Overdue</span>}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_CHIP[t.stage]}`}>{STAGE_LABEL[t.stage]}</span>
                </div>
              </div>
              {t.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-600 [overflow-wrap:anywhere]">{t.description}</p>}
              {t.sentBackReason && <p className="mt-2 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700">Your manager sent it back: {t.sentBackReason}</p>}
              {t.stage === "CONFIRMED" && <p className="mt-2 text-xs text-emerald-700">Confirmed by your manager.</p>}
              {t.stage === "AWAITING_CONFIRMATION" && <p className="mt-2 text-xs text-amber-700">Waiting for your manager to confirm.</p>}
              {t.lastComment && <p className="mt-2 break-words rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-600 [overflow-wrap:anywhere]">Latest comment: {t.lastComment.text}</p>}

              {finishing === t.id ? (
                <div className="mt-3 space-y-2">
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} aria-label="Note for your manager (optional)" placeholder="Note for your manager (optional)" className="w-full resize-y rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 [overflow-wrap:anywhere]" />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void move(t, "COMPLETED", note)} disabled={busy === t.id} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Mark completed</button>
                    <button type="button" onClick={() => { setFinishing(null); setNote(""); }} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-indigo-50">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {t.stage === "TODO" && <button type="button" onClick={() => void move(t, "IN_PROGRESS")} disabled={busy === t.id} className="rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Start</button>}
                  {(t.stage === "TODO" || t.stage === "IN_PROGRESS") && <button type="button" onClick={() => setFinishing(t.id)} disabled={busy === t.id} className="rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-40">Mark completed</button>}
                  {t.stage === "IN_PROGRESS" && <button type="button" onClick={() => void move(t, "TODO")} disabled={busy === t.id} className="rounded-xl px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-indigo-50 disabled:opacity-40">Back to To do</button>}
                  {t.stage === "AWAITING_CONFIRMATION" && <button type="button" onClick={() => void move(t, "IN_PROGRESS")} disabled={busy === t.id} className="rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-40">Take back to In progress</button>}
                  <button type="button" onClick={() => setThread(t)} className="rounded-xl px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50">Comments{t.commentCount ? ` (${t.commentCount})` : ""} and history</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
