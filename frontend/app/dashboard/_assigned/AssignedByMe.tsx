"use client";

// Manager side: "Assigned by me". Create, edit and follow the work you assigned. When an employee marks one completed you CONFIRM it or send it back with a
// reason. Not part of the approval/rating queue for tasks employees submit themselves.
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useTaskRealtime } from "@/lib/realtime";
import { Modal } from "../_employees/Modal";
import { PRIORITY_CHIP, PRIORITY_LABEL, STAGE_CHIP, STAGE_LABEL, dayLabel, matchesFilter, type AssignedPayload, type AssignedTask, type FilterKey } from "./assignedTypes";
import { FilterChips } from "./AssignedToMe";
import { ThreadModal } from "./ThreadModal";

export type Person = { id: string; name: string; code: string | null; projects: { id: string; name: string; primary: boolean }[] };

// `inline` shows the same form as a card (the Assign Tasks tab) instead of a pop-up; `company` words it for someone who assigns across their whole company.
export function TaskForm({ people, task, onClose, onSaved, inline = false, company = false }: { people: Person[]; task: AssignedTask | null; onClose: () => void; onSaved: (p: AssignedPayload) => void; inline?: boolean; company?: boolean }) {
  const [userId, setUserId] = useState(task?.employeeId ?? "");
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [priority, setPriority] = useState(task?.priority ?? "MEDIUM");
  const [due, setDue] = useState(task?.due ?? "");
  const [projectId, setProjectId] = useState(task?.projectId ?? "");
  const [find, setFind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const person = people.find((p) => p.id === userId);
  const editing = !!task;
  const today = new Date().toLocaleDateString("en-CA");

  async function save() {
    setBusy(true); setError("");
    try {
      const body = { title: title.trim(), description: description.trim(), priority, due: due || null, projectId: projectId || null };
      const p = editing
        ? await apiPost<AssignedPayload>(`/tasks/assigned/${task!.id}/edit`, body)
        : await apiPost<AssignedPayload>("/tasks/assigned", { ...body, userId });
      onSaved(p);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const invalid = !title.trim() || (!editing && !userId);
  const shown = people.filter((p) => !find.trim() || `${p.name} ${p.code ?? ""} ${p.projects.map((x) => x.name).join(" ")}`.toLowerCase().includes(find.trim().toLowerCase()));

  const fields = (
    <div className="space-y-3">
      {!editing && (
        <div>
          {company && (
            <label className="mb-1 block text-xs font-medium text-slate-500">
              Search employees (name, ID or project)
              <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Type to narrow the list" data-testid="assign-search" className="mt-1 w-full rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500" />
            </label>
          )}
          <label className="block text-xs font-medium text-slate-500">
            Assign to <span className="text-rose-500">*</span>{company ? <span className="ml-1 font-normal text-slate-400">({shown.length} of {people.length} active employees in your company)</span> : null}
            <select value={userId} onChange={(e) => { setUserId(e.target.value); setProjectId(""); }} data-testid="assign-person" className="mt-1 w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900">
              <option value="">Select a person</option>
              {shown.map((p) => <option key={p.id} value={p.id}>{p.name}{p.code ? ` (${p.code})` : ""}</option>)}
            </select>
          </label>
        </div>
      )}
      <label className="block text-xs font-medium text-slate-500">
        Task <span className="text-rose-500">*</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} data-testid="assign-title" className="mt-1 w-full rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500" />
      </label>
      <label className="block text-xs font-medium text-slate-500">
        Details (optional)
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} className="mt-1 w-full resize-y rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 [overflow-wrap:anywhere]" />
      </label>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="block text-xs font-medium text-slate-500">
          Project
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={editing ? false : !person} className="mt-1 w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900 disabled:opacity-50">
            <option value="">{person && person.projects.length > 0 ? "Their main project" : "No project"}</option>
            {(editing ? (people.find((p) => p.id === task!.employeeId)?.projects ?? []) : person?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="block text-xs font-medium text-slate-500">
          Assigned on
          <input value={editing ? dayLabel(task!.assignedOn.slice(0, 10)) : "Today (set automatically)"} readOnly aria-readonly="true" className="mt-1 w-full rounded-xl border border-indigo-100 bg-slate-50 px-3 py-2 text-sm text-slate-600" />
        </label>
        <label className="block text-xs font-medium text-slate-500">
          Due date (optional)
          <input type="date" value={due} min={editing ? undefined : today} onChange={(e) => setDue(e.target.value)} data-testid="assign-due" className="mt-1 w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900" />
        </label>
        <label className="block text-xs font-medium text-slate-500">
          Priority <span className="font-normal text-slate-400">(for organising only)</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="mt-1 w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900">
            {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((w) => <option key={w} value={w}>{PRIORITY_LABEL[w]}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
    </div>
  );
  const buttons = (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-indigo-50">{inline ? "Clear" : "Cancel"}</button>
      <button type="button" onClick={() => void save()} disabled={busy || invalid} data-testid="assign-submit" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">{editing ? "Save changes" : "Assign task"}</button>
    </div>
  );

  if (inline) {
    return (
      <section className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]" data-testid="assign-new-card" aria-label="Assign new task">
        <h2 className="text-sm font-semibold text-slate-900">Assign new task</h2>
        <p className="mb-3 mt-0.5 text-xs text-slate-500">Give a task to an active employee of your company. They are told at once and see it under Assigned by manager.</p>
        {fields}
        <div className="mt-4">{buttons}</div>
      </section>
    );
  }
  return (
    <Modal
      title={editing ? "Edit assigned task" : "Assign task"}
      subtitle={editing ? `For ${task!.employee}` : "Give a task to someone on your team"}
      onClose={onClose}
      width="max-w-xl"
      footer={buttons}
    >
      {fields}
    </Modal>
  );
}

// `assigner` = an Employee who holds TASK_ASSIGN_COMPANY (Productivity Supervisor): the same list to follow what they assigned, without the manager-only
// buttons (confirming or sending back finished work stays with managers).
export default function AssignedByMe({ assigner = false }: { assigner?: boolean } = {}) {
  const [data, setData] = useState<AssignedPayload | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<FilterKey>("ALL");
  const [who, setWho] = useState("");
  const [form, setForm] = useState<"new" | AssignedTask | null>(null);
  const [thread, setThread] = useState<AssignedTask | null>(null);
  const [busy, setBusy] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const [p, ppl] = await Promise.all([apiGet<AssignedPayload>("/tasks/assigned/by-me"), apiGet<{ people: Person[] }>("/tasks/assigned/people")]);
      setData(p); setPeople(ppl.people);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useTaskRealtime(() => void load());

  async function act(t: AssignedTask, path: string, body: Record<string, unknown>, done: string) {
    setBusy(t.id); setError("");
    try {
      setData(await apiPost<AssignedPayload>(`/tasks/assigned/${t.id}/${path}`, body));
      setNotice(done); setSending(null); setConfirming(null); setReason(""); setNote("");
    } catch (e) { setError((e as Error).message); await load(); } finally { setBusy(""); }
  }

  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const shown = tasks.filter((t) => matchesFilter(t, filter) && (!who || t.employeeId === who));
  const employees = useMemo(() => [...new Map(tasks.map((t) => [t.employeeId, t.employee])).entries()], [tasks]);

  if (!data && !error) return <div className="skeleton h-32" aria-busy="true" />;
  return (
    <div className="space-y-4" data-testid="assigned-by-me">
      {form && <TaskForm people={people} company={assigner} task={form === "new" ? null : form} onClose={() => setForm(null)} onSaved={(p) => { setData(p); setForm(null); setNotice(form === "new" ? "Task assigned. The employee has been notified." : "Changes saved. The employee has been told."); }} />}
      {thread && <ThreadModal taskId={thread.id} title={thread.title} canComment={thread.stage !== "CONFIRMED"} onClose={() => setThread(null)} onChanged={() => void load()} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-500">{assigner ? "Every task you assigned, with its progress. The employee updates progress and marks it completed; their manager stays responsible for evaluating work. You can edit or remove a task that has not started." : "Tasks you assigned. The employee updates progress and marks them completed; you then confirm, or send them back with a reason. No approval or rating applies here."}</p>
        {!assigner && <button type="button" onClick={() => setForm("new")} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Assign task</button>}
      </div>
      {data && (
        <p className="text-xs text-slate-500" data-testid="assigned-counts">
          {data.counts.total} assigned · {data.counts.todo} to do · {data.counts.inProgress} in progress · {data.counts.awaiting} {assigner ? "completed by the employee" : "waiting for your confirmation"} · {data.counts.confirmed} confirmed · {data.counts.overdue} overdue
        </p>
      )}
      {notice && <div role="status" className="flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"><span>{notice}</span><button type="button" onClick={() => setNotice("")} className="shrink-0 text-emerald-700 hover:underline">Dismiss</button></div>}
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-800">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <FilterChips tasks={tasks.filter((t) => !who || t.employeeId === who)} value={filter} onChange={setFilter} />
        {employees.length > 1 && (
          <select aria-label="Filter by employee" value={who} onChange={(e) => setWho(e.target.value)} className="rounded-xl border border-indigo-100 bg-white px-3 py-1.5 text-xs text-slate-700">
            <option value="">All employees</option>
            {employees.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-2xl bg-white p-6 text-center text-sm text-slate-500 shadow-[var(--shadow-card)]">{tasks.length === 0 ? (assigner ? "You have not assigned any tasks yet. Use Assign New Task to start." : "You have not assigned any tasks yet. Use Assign task to start.") : "No tasks match this filter."}</p>
      ) : (
        <ul className="space-y-3">
          {shown.map((t) => (
            <li key={t.id} data-testid="assigned-card" className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-slate-900 [overflow-wrap:anywhere]">{t.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{t.employee}{t.employeeCode ? ` · ${t.employeeCode}` : ""}{t.project ? ` · ${t.project}` : ""}{t.due ? ` · due ${dayLabel(t.due)}` : ""}</p>
                  <p className="mt-0.5 text-xs text-slate-400" data-testid="assigned-dates">Assigned {dayLabel(t.assignedOn.slice(0, 10))}{t.completedAt ? ` · completed ${dayLabel(t.completedAt.slice(0, 10))}` : ""}{t.rating ? ` · manager rating ${t.rating}/5` : ""}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {t.overdue && <span className="rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">Overdue</span>}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_CHIP[t.priority] ?? ""}`}>{PRIORITY_LABEL[t.priority] ?? t.priority}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_CHIP[t.stage]}`}>{assigner && t.stage === "AWAITING_CONFIRMATION" ? "Completed by employee" : STAGE_LABEL[t.stage]}</span>
                </div>
              </div>
              {t.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-600 [overflow-wrap:anywhere]">{t.description}</p>}
              {t.stage === "AWAITING_CONFIRMATION" && t.completionNote && <p className="mt-2 break-words rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800 [overflow-wrap:anywhere]">Employee&apos;s note: {t.completionNote}</p>}
              {t.lastComment && <p className="mt-2 break-words rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-600 [overflow-wrap:anywhere]">Latest comment: {t.lastComment.text}</p>}

              {sending === t.id ? (
                <div className="mt-3 space-y-2">
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} aria-label="Why is it being sent back?" placeholder="Why is it being sent back? (required)" className="w-full resize-y rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 [overflow-wrap:anywhere]" />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void act(t, "send-back", { reason }, "Sent back to the employee.")} disabled={busy === t.id || reason.trim().length < 3} className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-40">Send back</button>
                    <button type="button" onClick={() => { setSending(null); setReason(""); }} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-indigo-50">Cancel</button>
                  </div>
                </div>
              ) : confirming === t.id ? (
                <div className="mt-3 space-y-2">
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} aria-label="Note for the employee (optional)" placeholder="Note for the employee (optional)" className="w-full resize-y rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 [overflow-wrap:anywhere]" />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void act(t, "confirm", { note }, "Confirmed as complete.")} disabled={busy === t.id} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Confirm completed</button>
                    <button type="button" onClick={() => { setConfirming(null); setNote(""); }} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-indigo-50">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {!assigner && t.stage === "AWAITING_CONFIRMATION" && <button type="button" onClick={() => setConfirming(t.id)} className="rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">Confirm completed</button>}
                  {!assigner && t.stage === "AWAITING_CONFIRMATION" && <button type="button" onClick={() => setSending(t.id)} className="rounded-xl border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50">Send back</button>}
                  {t.stage !== "CONFIRMED" && <button type="button" onClick={() => setForm(t)} className="rounded-xl border border-indigo-100 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50">Edit</button>}
                  {t.stage === "TODO" && <button type="button" onClick={() => { if (confirm(`Remove "${t.title}"? It has not been started.`)) void act(t, "cancel", {}, "Task removed."); }} className="rounded-xl px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-rose-600">Remove</button>}
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
