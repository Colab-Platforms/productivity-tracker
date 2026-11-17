"use client";

// The manager's list of correction requests waiting for THEIR decision (the server returns only the ones they may decide). Hidden when there are none.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { formatDateTime } from "@/lib/time";
import { fieldChanges } from "./editTypes";

type Req = {
  taskId: string; requestId: string; requestedAt: string; employee: string; employeeCode: string | null; title: string; date: string; project: string | null;
  approvalStatus: string; rated: boolean; rating: number | null; ratingComment: string | null; reason: string | null; changed: string[];
  before: Record<string, unknown>; after: Record<string, unknown>;
};

export function CorrectionRequests({ reloadKey, onDecided }: { reloadKey: number; onDecided: () => void }) {
  const [rows, setRows] = useState<Req[]>([]);
  const [declining, setDeclining] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ ready: boolean; corrections: Req[] }>("/tasks/corrections/pending");
      setRows(r.corrections ?? []);
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, reloadKey]);

  async function decide(r: Req, approve: boolean) {
    setBusy(r.requestId);
    setError("");
    try {
      await apiPost(`/tasks/review/${r.taskId}/correction`, { requestId: r.requestId, approve, ...(approve ? {} : { note: note.trim() }) });
      setDeclining(null);
      setNote("");
      await load();
      onDecided();
    } catch (e) {
      setError((e as Error).message || "Could not save that");
      await load();
    } finally {
      setBusy("");
    }
  }

  if (rows.length === 0) return null;
  return (
    <section data-testid="correction-requests" className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
      <div className="border-b border-amber-100 bg-amber-50/60 px-5 py-3.5 rounded-t-2xl">
        <h2 className="text-sm font-semibold text-amber-900">Correction requests ({rows.length})</h2>
        <p className="mt-0.5 text-xs text-amber-800">An employee asked to change an approved task. Nothing changes until you approve it; the original is kept in the task history.</p>
      </div>
      {error && <p role="alert" className="mx-5 mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
      <ul className="divide-y divide-indigo-50">
        {rows.map((r) => {
          const lines = fieldChanges(r.before, r.after);
          return (
            <li key={r.requestId} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">{r.title}</p>
                  <p className="text-xs text-slate-500">{r.employee}{r.employeeCode ? ` · ${r.employeeCode}` : ""} · task of {r.date}{r.project ? ` · ${r.project}` : ""} · asked {formatDateTime(r.requestedAt, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</p>
                </div>
                {r.rated && <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800">Rated {r.rating}/5: approving clears the rating</span>}
              </div>
              <ul className="mt-2 divide-y divide-indigo-50 rounded-xl border border-indigo-100 text-sm">
                {lines.map((l) => (
                  <li key={l.label} className="px-3 py-1.5">
                    <span className="text-xs font-medium text-slate-500">{l.label}: </span>
                    <span className="break-words text-slate-400 line-through [overflow-wrap:anywhere]">{l.from}</span> <span aria-hidden="true">→</span> <span className="break-words font-medium text-slate-900 [overflow-wrap:anywhere]">{l.to}</span>
                  </li>
                ))}
              </ul>
              {r.reason && <p className="mt-2 break-words text-sm text-slate-700 [overflow-wrap:anywhere]"><span className="font-medium">Reason:</span> {r.reason}</p>}
              {declining === r.requestId ? (
                <div className="mt-3 space-y-2">
                  <label className="block text-xs text-slate-500">
                    Why are you declining it? <span className="text-rose-500">*</span>
                    <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} className="mt-1 w-full resize-y rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 [overflow-wrap:anywhere]" aria-label="Reason for declining" />
                  </label>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void decide(r, false)} disabled={busy === r.requestId || note.trim().length < 3} className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-40">Decline</button>
                    <button type="button" onClick={() => { setDeclining(null); setNote(""); }} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-indigo-50">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => void decide(r, true)} disabled={busy === r.requestId} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Approve correction</button>
                  <button type="button" onClick={() => { setDeclining(r.requestId); setNote(""); }} disabled={busy === r.requestId} className="rounded-xl border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-40">Decline</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
