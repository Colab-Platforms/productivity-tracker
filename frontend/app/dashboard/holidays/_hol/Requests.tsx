"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { REQUEST_CLASS, REQUEST_LABEL, msg, pretty, type CalendarData, type QueueRow } from "./model";

const chip = (s: string) => <span className={`rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${REQUEST_CLASS[s] ?? ""}`}>{REQUEST_LABEL[s] ?? s}</span>;

/** The person's own optional holidays: ask, see the answer, cancel. Optional days are working days unless approved. */
export function MyOptional({ data, reload, setNotice }: { data: CalendarData; reload: () => void; setNotice: (m: string) => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const optional = data.holidays.filter((h) => h.kind === "OPTIONAL");
  const mine = new Map(data.myOptionalRequests.filter((r) => ["PENDING_MANAGER", "PENDING_HR", "APPROVED"].includes(r.status)).map((r) => [r.holidayId, r]));
  const last = new Map(data.myOptionalRequests.map((r) => [r.holidayId, r]));
  async function act(path: string, ok: string, id: string) {
    setBusy(id); setError("");
    try { await apiPost(path); setNotice(ok); reload(); } catch (e) { setError(msg(e)); } finally { setBusy(""); }
  }
  return (
    <section className="space-y-3 rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]" aria-label="Optional holidays">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Optional holidays</h2>
        <p className="text-sm text-slate-600" data-testid="allowance">You have used {data.optionalUsed} of {data.optionalAllowance} this year.</p>
      </div>
      <p className="text-xs text-slate-500">An optional holiday is a normal working day unless your request is approved. Requests go to your reporting manager, then HR.</p>
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {optional.length === 0 ? <p className="text-sm text-slate-500">No optional holidays are published for {data.year}.</p> : (
        <ul className="divide-y divide-indigo-50">
          {optional.map((h) => {
            const live = mine.get(h.id); const prev = last.get(h.id);
            return (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div>
                  <p className="text-sm font-medium text-slate-900">{h.name}</p>
                  <p className="text-xs text-slate-500">{pretty(h.date)} · {h.weekday}{h.religion ? ` · ${h.religion}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  {live ? chip(live.status) : prev ? chip(prev.status) : null}
                  {live ? (
                    !h.isPast && <button type="button" disabled={busy === live.id} onClick={() => act(`/holiday-calendar/requests/${live.id}/cancel`, "Request cancelled.", live.id)} className="h-8 rounded-lg border border-indigo-100 px-3 text-xs font-medium text-slate-600 hover:bg-indigo-50">Cancel</button>
                  ) : !h.isPast ? (
                    <button type="button" disabled={busy === h.id} onClick={() => act(`/holiday-calendar/optional/${h.id}/request`, "Request sent.", h.id)} className="h-8 rounded-lg bg-indigo-600 px-3 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Request</button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {data.myOptionalRequests.some((r) => r.managerNote || r.hrNote) && (
        <ul className="space-y-1 text-xs text-slate-600">
          {data.myOptionalRequests.filter((r) => r.managerNote || r.hrNote).map((r) => <li key={r.id}><strong>{r.name}:</strong> {[r.managerNote && `Manager: ${r.managerNote}`, r.hrNote && `HR: ${r.hrNote}`].filter(Boolean).join(" · ")}</li>)}
        </ul>
      )}
    </section>
  );
}

/** Requests that wait for this person (a manager: his team; HR: the final step) and a read-only list of the rest. */
export function Approvals({ role, setNotice, onChange }: { role: string; setNotice: (m: string) => void; onChange: () => void }) {
  const [q, setQ] = useState<{ forManager: QueueRow[]; forHr: QueueRow[] } | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const load = useCallback(() => { apiGet<{ forManager: QueueRow[]; forHr: QueueRow[] }>("/holiday-calendar/requests").then(setQ).catch((e) => setError(msg(e))); }, []);
  useEffect(load, [load]);

  async function decide(id: string, approve: boolean) {
    setBusy(id); setError("");
    try { await apiPost(`/holiday-calendar/requests/${id}/decide`, { approve, note: note[id] ?? "" }); setNotice(approve ? "Approved." : "Rejected."); load(); onChange(); } catch (e) { setError(msg(e)); } finally { setBusy(""); }
  }
  if (error && !q) return <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>;
  if (!q) return <p className="text-sm text-slate-500">Loading…</p>;

  const mgr = q.forManager;
  const hrRows = q.forHr;
  const Table = ({ rows, step }: { rows: QueueRow[]; step: "PENDING_MANAGER" | "PENDING_HR" }) => (
    rows.length === 0 ? <p className="text-sm text-slate-500">Nothing here.</p> : (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-3">Employee</th><th className="py-2 pr-3">Holiday</th><th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Status</th><th className="py-2">Decision</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-indigo-50 align-top">
                <td className="py-2 pr-3">{r.person}<span className="block text-xs text-slate-500">{r.code} · {r.company}</span></td>
                <td className="py-2 pr-3">{r.holiday}</td>
                <td className="py-2 pr-3">{pretty(r.date)}</td>
                <td className="py-2 pr-3">{chip(r.status)}</td>
                <td className="py-2">
                  {r.status === step ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <input aria-label={`Note for ${r.person}`} value={note[r.id] ?? ""} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} placeholder="Note (needed to reject)" className="h-8 w-44 rounded-lg border border-indigo-100 px-2 text-xs" />
                      <button type="button" disabled={busy === r.id} onClick={() => decide(r.id, true)} className="h-8 rounded-lg bg-indigo-600 px-3 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Approve</button>
                      <button type="button" disabled={busy === r.id} onClick={() => decide(r.id, false)} className="h-8 rounded-lg border border-rose-200 px-3 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50">Reject</button>
                    </div>
                  ) : <span className="text-xs text-slate-500">{r.status === "PENDING_MANAGER" ? "Waiting for the manager" : r.status === "PENDING_HR" ? "Waiting for HR" : "Decided"}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  );
  return (
    <div className="space-y-5">
      {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {(role === "MANAGER" || role === "ADMIN") && (
        <section className="space-y-2 rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]" aria-label="Team requests">
          <h2 className="text-base font-semibold text-slate-900">Requests from your team</h2>
          <Table rows={mgr} step="PENDING_MANAGER" />
        </section>
      )}
      {(role === "HR" || role === "ADMIN") && (
        <section className="space-y-2 rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]" aria-label="All optional holiday requests">
          <h2 className="text-base font-semibold text-slate-900">{role === "HR" ? "Optional holiday requests (HR step)" : "All optional holiday requests (view)"}</h2>
          <Table rows={hrRows} step={role === "HR" ? "PENDING_HR" : ("NONE" as "PENDING_HR")} />
        </section>
      )}
    </div>
  );
}
