"use client";

import { useCallback, useEffect, useState } from "react";
import { API_BASE, apiGet, apiPatch, apiPost, getToken } from "@/lib/api";

// ---------------------------------------------------------------------------
// MY TASKS (a manager's own work). Self-managed: no approval, nothing waits for anyone, nobody is notified, nobody reviews it.
// Each task moves Not started -> In progress -> Completed by the manager himself, with a deadline, work updates and a history.
// Tasks that someone ELSE assigned to the manager keep their normal route (listed separately below).
// Employees never see this screen: it is only used when the server says `selfManagedMode`.
// ---------------------------------------------------------------------------

export type SelfTask = {
  id: string; title: string; description: string | null; weight: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED"; approvalStatus: string; rating?: number | null; reviewNote?: string | null; assignedBy: string | null;
  selfManaged: boolean; startedAt?: string | null; dueDate?: string | null; overdue?: boolean;
};
export type SelfPayload = { tasks: SelfTask[] };
type TaskEvent = { id: string; kind: string; note: string | null; createdAt: string };

const WEIGHTS = [["LOW", "Low"], ["MEDIUM", "Medium"], ["HIGH", "High"], ["CRITICAL", "Critical"]] as const;
const WEIGHT_CHIP: Record<string, string> = { LOW: "bg-[#E7F6F1] text-slate-600", MEDIUM: "bg-sky-50 text-sky-700", HIGH: "bg-amber-50 text-amber-700", CRITICAL: "bg-rose-50 text-rose-700" };
const STATUS_LABEL = { PENDING: "Not started", IN_PROGRESS: "In progress", COMPLETED: "Completed", CANCELLED: "Cancelled" } as const;
const STATUS_CHIP = { PENDING: "bg-slate-100 text-slate-600", IN_PROGRESS: "bg-sky-50 text-sky-700", COMPLETED: "bg-emerald-50 text-emerald-700", CANCELLED: "bg-slate-100 text-slate-500" } as const;
const KIND_LABEL: Record<string, string> = { CREATED: "Task created", STARTED: "Started", COMPLETED: "Marked completed", REOPENED: "Reopened", EDITED: "Edited", UPDATE: "Work update" };
const stamp = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso));
const today = () => new Date().toLocaleDateString("en-CA");

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "That didn't work");
  return data as T;
}

export default function SelfManagedTasks({ data, onData, error, setError }: { data: SelfPayload; onData: (p: SelfPayload) => void; error: string; setError: (m: string) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [weight, setWeight] = useState("MEDIUM");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const mine = data.tasks.filter((t) => t.selfManaged && t.status !== "CANCELLED");
  const others = data.tasks.filter((t) => !t.selfManaged && t.status !== "CANCELLED");
  const groups: [keyof typeof STATUS_LABEL, string][] = [["PENDING", "Not started"], ["IN_PROGRESS", "In progress"], ["COMPLETED", "Completed"]];
  const counts = { PENDING: 0, IN_PROGRESS: 0, COMPLETED: 0, overdue: 0 };
  for (const t of mine) { counts[t.status as "PENDING" | "IN_PROGRESS" | "COMPLETED"]++; if (t.overdue) counts.overdue++; }

  async function run<T extends SelfPayload>(fn: () => Promise<T>) {
    setBusy(true); setError("");
    try { onData(await fn()); return true; } catch (e) { setError((e as Error).message || "That didn't work"); return false; } finally { setBusy(false); }
  }
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (await run(() => apiPost<SelfPayload>("/tasks", { title, description, weight, ...(due ? { dueDate: due } : {}) }))) { setTitle(""); setDescription(""); setWeight("MEDIUM"); setDue(""); }
  };
  const setStatus = (t: SelfTask, status: string) => run(() => apiPatch<SelfPayload>(`/tasks/${t.id}`, { status }));
  const remove = (t: SelfTask) => { if (confirm(`Remove "${t.title}"?`)) void run(() => del<SelfPayload>(`/tasks/${t.id}`)); };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">My tasks</h1>
        <p className="mt-1 text-sm text-slate-500">Your own work. You manage it yourself: no approval is needed and nobody reviews it. It counts in <b>My performance</b>, not in your team&apos;s figures.</p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([["Not started", counts.PENDING, ""], ["In progress", counts.IN_PROGRESS, ""], ["Completed", counts.COMPLETED, ""], ["Overdue", counts.overdue, counts.overdue > 0 ? "text-red-600" : ""]] as const).map(([label, n, cls]) => (
          <div key={label} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
            <p className="text-xs text-slate-500">{label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${cls || "text-slate-900"}`}>{n}</p>
          </div>
        ))}
      </div>

      <form onSubmit={add} className="space-y-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task for yourself" maxLength={200} className="w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500" />
        <div className="flex flex-wrap items-center gap-2">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Details (optional)" className="min-w-56 flex-1 rounded-xl border border-indigo-200 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:border-indigo-500" />
          <select value={weight} onChange={(e) => setWeight(e.target.value)} aria-label="Priority" className="rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900">
            {WEIGHTS.map(([v, l]) => <option key={v} value={v}>{l} priority</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-500">Deadline <input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} className="rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900" /></label>
          <button type="submit" disabled={busy || !title.trim()} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40">Add task</button>
        </div>
      </form>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}

      {mine.length === 0 && <p className="rounded-2xl bg-white px-5 py-10 text-center text-sm text-slate-400 shadow-[var(--shadow-card)]">No tasks yet. Add your first one above.</p>}

      {groups.map(([status, label]) => {
        const list = mine.filter((t) => t.status === status);
        if (list.length === 0) return null;
        return (
          <section key={status} className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
            <div className="border-b border-indigo-50 px-5 py-3.5"><h2 className="text-sm font-medium text-slate-900">{label} ({list.length})</h2></div>
            <ul className="divide-y divide-indigo-50">
              {list.map((t) => (
                <li key={t.id} className="px-5 py-3.5">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${t.status === "IN_PROGRESS" ? "animate-pulse bg-sky-500" : t.status === "COMPLETED" ? "bg-emerald-500" : "bg-slate-300"}`} />
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm ${t.status === "COMPLETED" ? "text-slate-500" : "text-slate-900"}`}>{t.title}</p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {t.dueDate ? <span className={t.overdue ? "font-medium text-red-600" : ""}>{t.overdue ? "Overdue · " : "Due "}{t.dueDate}</span> : "No deadline"}
                        {t.startedAt && <> · started {stamp(t.startedAt)}</>}
                      </p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${WEIGHT_CHIP[t.weight]}`}>{t.weight.toLowerCase()}</span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[t.status]}`}>{STATUS_LABEL[t.status]}</span>
                    {t.status === "PENDING" && <button onClick={() => setStatus(t, "IN_PROGRESS")} disabled={busy} className="shrink-0 rounded-xl border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-40">Start</button>}
                    {t.status !== "COMPLETED" && <button onClick={() => setStatus(t, "COMPLETED")} disabled={busy} className="shrink-0 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Mark as completed</button>}
                    {t.status === "COMPLETED" && <button onClick={() => setStatus(t, "IN_PROGRESS")} disabled={busy} className="shrink-0 text-xs text-slate-400 hover:text-slate-700">Reopen</button>}
                    <button onClick={() => setOpenId(openId === t.id ? null : t.id)} className="shrink-0 text-xs font-medium text-indigo-600 hover:underline" aria-expanded={openId === t.id}>{openId === t.id ? "Close" : "Details"}</button>
                  </div>
                  {openId === t.id && <Detail task={t} busy={busy} run={run} onDelete={() => remove(t)} />}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {others.length > 0 && (
        <section className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
          <div className="border-b border-indigo-50 px-5 py-3.5">
            <h2 className="text-sm font-medium text-slate-900">Assigned to you by others ({others.length})</h2>
            <p className="mt-0.5 text-xs text-slate-400">These follow their normal route: the person who assigned them reviews them.</p>
          </div>
          <ul className="divide-y divide-indigo-50">
            {others.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1"><p className="text-sm text-slate-900">{t.title}</p><p className="mt-0.5 text-xs text-slate-400">{t.assignedBy ? `Assigned by ${t.assignedBy}` : "Not yet converted to a personal task"}{t.rating != null ? ` · rated ${t.rating}/5` : ""}</p></div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[t.status]}`}>{STATUS_LABEL[t.status]}</span>
                {t.approvalStatus === "APPROVED" && t.status !== "COMPLETED" && t.rating == null && <button onClick={() => setStatus(t, t.status === "PENDING" ? "IN_PROGRESS" : "COMPLETED")} disabled={busy} className="shrink-0 rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-indigo-50 disabled:opacity-40">{t.status === "PENDING" ? "Start" : "Mark done"}</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Detail({ task, busy, run, onDelete }: { task: SelfTask; busy: boolean; run: (fn: () => Promise<SelfPayload>) => Promise<boolean>; onDelete: () => void }) {
  const [desc, setDesc] = useState(task.description ?? "");
  const [weight, setWeight] = useState<string>(task.weight);
  const [due, setDue] = useState(task.dueDate ?? "");
  const [update, setUpdate] = useState("");
  const [events, setEvents] = useState<TaskEvent[] | null>(null);
  const [err, setErr] = useState("");

  const loadHistory = useCallback(async () => {
    try { setEvents((await apiGet<{ events: TaskEvent[] }>(`/tasks/${task.id}/history`)).events); setErr(""); } catch (e) { setErr((e as Error).message); }
  }, [task.id]);
  useEffect(() => {
    const t = setTimeout(() => void loadHistory(), 0);
    return () => clearTimeout(t);
  }, [loadHistory]);

  const save = async () => {
    const body: Record<string, unknown> = {};
    if (desc !== (task.description ?? "")) body.description = desc;
    if (weight !== task.weight) body.weight = weight;
    if (due !== (task.dueDate ?? "")) body.dueDate = due || null;
    if (Object.keys(body).length === 0) return;
    if (await run(() => apiPatch<SelfPayload>(`/tasks/${task.id}`, body))) void loadHistory();
  };
  const post = async () => {
    if (!update.trim()) return;
    if (await run(() => apiPatch<SelfPayload>(`/tasks/${task.id}`, { workUpdate: update }))) { setUpdate(""); void loadHistory(); }
  };

  return (
    <div className="mt-3 grid gap-4 rounded-xl bg-[#F3F7F6] p-4 md:grid-cols-2">
      <div className="space-y-3">
        <label className="block text-xs text-slate-500">Details<textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} maxLength={2000} className="mt-1 w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900" /></label>
        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-slate-500">Priority<select value={weight} onChange={(e) => setWeight(e.target.value)} className="mt-1 block rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900">{WEIGHTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label className="text-xs text-slate-500">Deadline<input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="mt-1 block rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900" /></label>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Save changes</button>
          {task.status === "PENDING" && <button onClick={onDelete} disabled={busy} className="text-xs text-slate-400 hover:text-rose-600">Remove task</button>}
        </div>
      </div>
      <div className="space-y-3">
        <div className="flex gap-2">
          <input value={update} onChange={(e) => setUpdate(e.target.value)} placeholder="Add a work update" maxLength={1000} className="min-w-0 flex-1 rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900" />
          <button onClick={post} disabled={busy || !update.trim()} className="rounded-xl border border-indigo-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-indigo-50 disabled:opacity-40">Add</button>
        </div>
        {err && <p className="text-xs text-red-600">{err}</p>}
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">History</p>
        {events === null ? <p className="text-xs text-slate-400">Loading…</p> : events.length === 0 ? <p className="text-xs text-slate-400">Nothing recorded yet.</p> : (
          <ol className="space-y-1.5">
            {[...events].reverse().map((e) => (
              <li key={e.id} className="text-xs text-slate-600"><span className="text-slate-400">{stamp(e.createdAt)}</span> · <span className="font-medium text-slate-800">{KIND_LABEL[e.kind] ?? e.kind}</span>{e.note ? `: ${e.note}` : ""}</li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
