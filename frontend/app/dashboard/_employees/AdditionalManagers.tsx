"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPut } from "@/lib/api";

// Edit employee > "Additional reporting managers" (Admin only; the server enforces it). The MAIN reporting manager is chosen in the field above and stays
// the only one used for leave routing. Each additional manager gets the same reach a reporting manager has: the person appears in their Attendance,
// Calendar, Reports and task lists, and they can approve the person's tasks when tagged and are notified of them.

type Mgr = { id: string; name: string; employeeCode: string | null; role: string; company: string };
type UserRow = { id: string; name: string; employeeCode: string | null; role: string; status: string; company: string | null };

export function AdditionalManagers({ userId, mainManagerId, initial, ready }: { userId: string; mainManagerId: string | null; initial: Mgr[]; ready: boolean }) {
  const [current, setCurrent] = useState<Mgr[]>(initial);
  const [pool, setPool] = useState<Mgr[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  // Every active Manager or Admin of the companies this Admin acts on (a manager can run people of another company).
  useEffect(() => {
    let live = true;
    Promise.all([apiGet<{ users: UserRow[] }>("/admin/users?role=MANAGER"), apiGet<{ users: UserRow[] }>("/admin/users?role=ADMIN")])
      .then(([a, b]) => {
        if (!live) return;
        const rows = [...a.users, ...b.users].filter((u) => u.status === "ACTIVE" || u.status === "INVITED");
        setPool(rows.map((u) => ({ id: u.id, name: u.name, employeeCode: u.employeeCode, role: u.role, company: u.company ?? "" })));
      })
      .catch(() => live && setPool([]));
    return () => {
      live = false;
    };
  }, []);

  const options = useMemo(
    () => pool.filter((m) => m.id !== userId && m.id !== mainManagerId && !current.some((c) => c.id === m.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [pool, userId, mainManagerId, current]
  );

  async function save(next: Mgr[]) {
    setBusy(true);
    setNote(null);
    try {
      await apiPut(`/admin/employees/${userId}/additional-managers`, { managerIds: next.map((m) => m.id) });
      setCurrent(next);
      setPick("");
      setNote({ text: "Saved.", error: false });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : "Could not save the managers.", error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-indigo-100 p-3">
      <p className="text-xs font-medium text-slate-700">Additional reporting managers</p>
      <p className="mt-0.5 text-xs text-slate-400">They also see this person and can approve their tasks. Leave still goes to the main manager. Saved straight away.</p>
      {!ready && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">Not set up on this server yet. Ask an administrator to finish the database update.</p>}
      {note && <p className={`mt-2 rounded-lg px-3 py-2 text-xs ${note.error ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>{note.text}</p>}
      {current.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {current.map((m) => (
            <li key={m.id} className="flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-xs text-slate-700">
              {m.name}
              {m.employeeCode ? ` (${m.employeeCode})` : ""}
              <button type="button" disabled={busy || !ready} onClick={() => void save(current.filter((c) => c.id !== m.id))} aria-label={`Remove ${m.name}`} className="rounded-full p-0.5 hover:bg-indigo-100 disabled:opacity-40">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex gap-2">
        <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy || !ready} className="w-full rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-700">
          <option value="">Add a manager…</option>
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.employeeCode ? ` (${m.employeeCode})` : ""} · {m.role === "ADMIN" ? "Admin" : "Manager"}
              {m.company ? ` · ${m.company}` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!pick || busy || !ready || current.length >= 5}
          onClick={() => {
            const m = pool.find((x) => x.id === pick);
            if (m) void save([...current, m]);
          }}
          className="whitespace-nowrap rounded-xl bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}
