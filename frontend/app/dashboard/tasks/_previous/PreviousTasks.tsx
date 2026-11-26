"use client";

// A manager's personal notebook of work finished before the system. It is a tab inside Daily Tasks, kept apart from the live task records:
// nothing here is submitted, approved, rated or counted in any score or report (the server hides these entries from every task reader).
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost, apiDelete } from "@/lib/api";
import { Modal } from "../../_employees/Modal";

type Entry = { id: string; title: string; description: string; completedOn: string; createdAt: string; updatedAt: string };
type Payload = { entries: Entry[]; today: string };

const TITLE_MIN = 3, TITLE_MAX = 120, DESC_MAX = 1000;
const day = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

export default function PreviousTasks() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Entry | "new" | null>(null);
  const [removing, setRemoving] = useState<Entry | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Payload>("/tasks/previous"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = (data?.entries ?? []).filter((e) => !q.trim() || `${e.title} ${e.description}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <section className="space-y-4" data-testid="previous-tasks">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Previous tasks</h2>
          <p className="mt-0.5 max-w-xl text-sm text-slate-500">
            Your own record of work you completed before using the system. It is kept separate from your daily tasks: it is never approved, rated or counted in any score or report.
          </p>
        </div>
        <button type="button" onClick={() => setEditing("new")} data-testid="add-previous" className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700">
          Add previous task
        </button>
      </div>

      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      {data && data.entries.length > 0 && (
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your previous tasks" aria-label="Search your previous tasks" className="w-full max-w-sm rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500" />
      )}

      {!data && !error && <p className="text-sm text-slate-400">Loading…</p>}
      {data && data.entries.length === 0 && (
        <div className="rounded-2xl bg-white p-8 text-center shadow-[var(--shadow-card)]" data-testid="previous-empty">
          <p className="font-medium text-slate-700">No previous tasks yet</p>
          <p className="mt-1 text-sm text-slate-500">Use “Add previous task” to record work you finished earlier.</p>
        </div>
      )}
      {data && data.entries.length > 0 && shown.length === 0 && <p className="text-sm text-slate-500">No previous task matches your search.</p>}

      <ul className="space-y-3">
        {shown.map((e) => (
          <li key={e.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]" data-testid="previous-row">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium text-slate-900">{e.title}</p>
                {e.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-600">{e.description}</p>}
                <p className="mt-2 text-xs text-slate-500">Completed on <span className="font-medium text-slate-700">{day(e.completedOn)}</span></p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => setEditing(e)} aria-label={`Edit ${e.title}`} className="rounded-xl border border-indigo-100 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50">Edit</button>
                <button type="button" onClick={() => setRemoving(e)} aria-label={`Delete ${e.title}`} className="rounded-xl border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50">Delete</button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {editing && data && (
        <EntryForm entry={editing === "new" ? null : editing} today={data.today} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      )}
      {removing && (
        <DeleteDialog entry={removing} onClose={() => setRemoving(null)} onDeleted={() => { setRemoving(null); void load(); }} />
      )}
    </section>
  );
}

function EntryForm({ entry, today, onClose, onSaved }: { entry: Entry | null; today: string; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [description, setDescription] = useState(entry?.description ?? "");
  const [completedOn, setCompletedOn] = useState(entry?.completedOn ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tried, setTried] = useState(false);

  const t = title.trim();
  const problems = {
    title: t.length < TITLE_MIN ? `Give the task a title of at least ${TITLE_MIN} characters.` : t.length > TITLE_MAX ? `Keep the title to ${TITLE_MAX} characters or fewer.` : "",
    date: !completedOn ? "Choose the date the task was completed." : completedOn > today ? "A completed task can't have a completion date in the future." : "",
    description: description.trim().length > DESC_MAX ? `Keep the description to ${DESC_MAX} characters or fewer.` : "",
  };
  const valid = !problems.title && !problems.date && !problems.description;

  async function save() {
    setTried(true);
    if (!valid || busy) return;
    setBusy(true);
    setErr("");
    try {
      const body = { title: t, description: description.trim(), completedOn };
      if (entry) await apiPatch(`/tasks/previous/${entry.id}`, body);
      else await apiPost("/tasks/previous", body);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const field = "mt-1 w-full rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500";
  return (
    <Modal
      title={entry ? "Edit previous task" : "Add previous task"}
      subtitle="A personal record. It does not go for approval and is not counted anywhere."
      onClose={onClose}
      width="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-indigo-50">Cancel</button>
          <button type="button" onClick={save} disabled={busy} data-testid="save-previous" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? "Saving…" : entry ? "Save changes" : "Add task"}</button>
        </div>
      }
    >
      <div className="space-y-4">
        <label className="block text-sm font-medium text-slate-700">
          Task title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TITLE_MAX + 20} data-testid="prev-title" className={field} />
          {tried && problems.title && <span className="mt-1 block text-xs text-rose-600">{problems.title}</span>}
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Description <span className="font-normal text-slate-400">(optional)</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} data-testid="prev-description" className={`${field} resize-y break-words`} />
          <span className="mt-1 flex justify-between text-xs"><span className="text-rose-600">{tried ? problems.description : ""}</span><span className="text-slate-400">{description.length}/{DESC_MAX}</span></span>
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Completion date
          <input type="date" value={completedOn} max={today} onChange={(e) => setCompletedOn(e.target.value)} data-testid="prev-date" className={field} />
          {tried && problems.date && <span className="mt-1 block text-xs text-rose-600">{problems.date}</span>}
        </label>
        {err && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</p>}
      </div>
    </Modal>
  );
}

function DeleteDialog({ entry, onClose, onDeleted }: { entry: Entry; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function remove() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await apiDelete(`/tasks/previous/${entry.id}`);
      onDeleted();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Delete previous task?"
      onClose={onClose}
      width="max-w-md"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-indigo-50">Cancel</button>
          <button type="button" onClick={remove} disabled={busy} data-testid="confirm-delete-previous" className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50">{busy ? "Deleting…" : "Delete"}</button>
        </div>
      }
    >
      <p className="text-sm text-slate-600">“{entry.title}” will be removed from your previous tasks. This cannot be undone.</p>
      {err && <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</p>}
    </Modal>
  );
}
