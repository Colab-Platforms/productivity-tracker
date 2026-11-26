"use client";

// Manager Evaluation: a manager adjusts one person's Overall Performance Score, Evaluation Status and Productivity % for the exact period the table shows.
// The system-calculated values are never overwritten: they are listed beside each field, and every change (original, new value, manager, time, reason)
// is kept in the history below. HR, Admin and supervisors open the same window read-only.
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Modal } from "../../_employees/Modal";
import { STATUS_LABEL, type Weighted } from "../../_weighted/Weighted";

type Status = keyof typeof STATUS_LABEL;
const STATUSES = Object.keys(STATUS_LABEL) as Status[];
type Original = { score: number | null; status: string | null; productivity: number | null };
type Entry = { at: string; byName: string; reason: string; before: Original; after: Original };
export type Evaluation = { adjusted: boolean; by: string | null; at: string; reason: string; original: Original; adjustedFields: { score: boolean; status: boolean; productivity: boolean } } | null;
type PersonLike = { userId: string; name: string; employeeCode: string | null; weighted?: Weighted; overallPercent: number | null; evaluation?: Evaluation };

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "N/A" : `${v}%`);
const label = (s: string | null | undefined) => (s ? STATUS_LABEL[s as Status] ?? s : "system value");
const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));

export default function EvaluationModal({ person, from, to, canEdit, onClose, onSaved }: { person: PersonLike; from: string; to: string; canEdit: boolean; onClose: () => void; onSaved: () => void }) {
  const orig = person.evaluation?.original ?? { score: person.weighted?.percent ?? null, status: person.weighted?.status ?? null, productivity: person.overallPercent };
  const [score, setScore] = useState(person.weighted?.percent != null ? String(person.weighted.percent) : "");
  const [status, setStatus] = useState<string>(person.weighted?.status ?? "");
  const [prod, setProd] = useState(person.overallPercent != null ? String(person.overallPercent) : "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [tried, setTried] = useState(false);
  const [history, setHistory] = useState<Entry[] | null>(null);

  useEffect(() => {
    apiGet<{ entries: Entry[] }>(`/team-attendance/evaluation/history?userId=${person.userId}&from=${from}&to=${to}`).then((r) => setHistory(r.entries)).catch(() => setHistory([]));
  }, [person.userId, from, to]);

  const range = (v: string) => v.trim() === "" || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100);
  const r = reason.trim();
  const problems = {
    score: range(score) ? "" : "Enter a number from 0 to 100.",
    prod: range(prod) ? "" : "Enter a number from 0 to 100.",
    reason: r.length < 5 ? "Give a reason (at least 5 characters)." : r.length > 300 ? "Keep the reason to 300 characters or fewer." : "",
  };
  const valid = !problems.score && !problems.prod && !problems.reason;

  async function save(resetToSystem = false) {
    setTried(true);
    if (busy) return;
    if (!resetToSystem && !valid) return;
    if (resetToSystem && problems.reason) return;
    setBusy(true);
    setErr("");
    try {
      await apiPost("/team-attendance/evaluation", resetToSystem
        ? { userId: person.userId, from, to, score: null, status: null, productivity: null, reason: r }
        : { userId: person.userId, from, to, score: score.trim() === "" ? null : Number(score), status: status || null, productivity: prod.trim() === "" ? null : Number(prod), reason: r });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const field = "mt-1 w-full rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500 disabled:bg-slate-50";
  const sys = (text: string) => <span className="mt-1 block text-[11px] text-slate-400">System calculated: {text}</span>;
  return (
    <Modal
      title={canEdit ? "Manager evaluation" : "Evaluation history"}
      subtitle={`${person.name}${person.employeeCode ? ` · ${person.employeeCode}` : ""} · ${from === to ? from : `${from} to ${to}`}`}
      onClose={onClose}
      width="max-w-xl"
      footer={canEdit ? (
        <div className="flex flex-wrap justify-between gap-2">
          <button type="button" onClick={() => void save(true)} disabled={busy || !person.evaluation} data-testid="eval-reset" title={person.evaluation ? "Go back to the system-calculated values (needs a reason)" : "Nothing is adjusted"} className="rounded-xl border border-indigo-100 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-indigo-50 disabled:opacity-40">Reset to system values</button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-indigo-50">Cancel</button>
            <button type="button" onClick={() => void save(false)} disabled={busy} data-testid="eval-save" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? "Saving…" : "Save evaluation"}</button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end"><button type="button" onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-indigo-50">Close</button></div>
      )}
    >
      <div className="space-y-4">
        {canEdit && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm font-medium text-slate-700">
                Overall Performance Score (%)
                <input type="number" min={0} max={100} step="0.01" value={score} onChange={(e) => setScore(e.target.value)} data-testid="eval-score" className={field} placeholder="Keep the system score" />
                {sys(pct(orig.score))}
                {tried && problems.score && <span className="mt-1 block text-xs text-rose-600">{problems.score}</span>}
              </label>
              <label className="block text-sm font-medium text-slate-700">
                Productivity (%)
                <input type="number" min={0} max={100} step="0.01" value={prod} onChange={(e) => setProd(e.target.value)} data-testid="eval-prod" className={field} placeholder="Keep the system value" />
                {sys(pct(orig.productivity))}
                {tried && problems.prod && <span className="mt-1 block text-xs text-rose-600">{problems.prod}</span>}
              </label>
            </div>
            <label className="block text-sm font-medium text-slate-700">
              Evaluation status
              <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="eval-status" className={field}>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
              {sys(label(orig.status))}
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Reason for the adjustment
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-testid="eval-reason" className={`${field} resize-y break-words`} />
              <span className="mt-1 flex justify-between text-xs"><span className="text-rose-600">{tried ? problems.reason : ""}</span><span className="text-slate-400">{reason.length}/300</span></span>
            </label>
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">Saving marks this evaluation as Evaluated (or Updated if you have saved it before), even if you keep the system values. The calculated score and productivity are never changed or deleted. Your values are stored separately, shown as the effective ones for exactly this period, and every change is recorded below.</p>
            {err && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</p>}
          </>
        )}
        <div>
          <p className="text-sm font-medium text-slate-700">History</p>
          {history === null && <p className="mt-1 text-xs text-slate-400">Loading…</p>}
          {history && history.length === 0 && <p className="mt-1 text-xs text-slate-500" data-testid="eval-history-empty">No adjustments for this period.</p>}
          <ul className="mt-2 space-y-2" data-testid="eval-history">
            {(history ?? []).map((h, i) => (
              <li key={i} className="rounded-xl border border-indigo-50 bg-white px-3 py-2 text-xs text-slate-600">
                <p className="font-medium text-slate-800">{h.byName} <span className="font-normal text-slate-400">· {when(h.at)}</span></p>
                <p className="mt-0.5">Score {pct(h.before.score)} → <b>{h.after.score !== null ? pct(h.after.score) : "system"}</b> · Status {label(h.before.status)} → <b>{label(h.after.status)}</b> · Productivity {pct(h.before.productivity)} → <b>{h.after.productivity !== null ? pct(h.after.productivity) : "system"}</b></p>
                <p className="mt-0.5 break-words text-slate-500">Reason: {h.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
