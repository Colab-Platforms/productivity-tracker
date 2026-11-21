"use client";

import { useState } from "react";
import { apiPost } from "@/lib/api";
import { Modal } from "../../_employees/Modal";
import { codeOf, msg, type Entry, type Kind } from "./model";

// Add or edit one holiday. A date that has passed needs a tick (reports for that day change). The server re-checks every rule.
export default function EntryModal({ entry, companies, today, onClose, onSaved }: { entry: Entry | null; companies: { id: string; name: string }[]; today: string; onClose: () => void; onSaved: (m: string) => void }) {
  const [name, setName] = useState(entry?.name ?? "");
  const [date, setDate] = useState(entry?.date ?? "");
  const [kind, setKind] = useState<Kind>(entry?.kind ?? "FIXED");
  const [religion, setReligion] = useState(entry?.religion ?? "");
  const [companyId, setCompanyId] = useState(entry?.platformId ?? companies[0]?.id ?? "");
  const [all, setAll] = useState(false);
  const [back, setBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editing = !!entry;
  const isPast = !!date && date < today;

  async function save() {
    setBusy(true); setError("");
    try {
      if (editing) await apiPost(`/holiday-calendar/entry/${entry!.id}/edit`, { name, date, kind, religion });
      else await apiPost("/holiday-calendar/entry", { name, date, kind, religion, companyId, applyToAll: all, confirmBackdate: back });
      onSaved(editing ? "Holiday updated." : "Holiday added and published.");
    } catch (e) {
      if (codeOf(e) === "BACKDATE_CONFIRM_REQUIRED") setBack(false);
      setError(msg(e));
    } finally { setBusy(false); }
  }

  const field = "mt-1 block h-10 w-full rounded-xl border border-indigo-100 bg-white px-3 text-sm";
  return (
    <Modal
      title={editing ? "Edit holiday" : "Add holiday"}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-indigo-100 px-4 text-sm font-medium text-slate-600 hover:bg-indigo-50">Cancel</button>
          <button type="button" disabled={busy || !name.trim() || !date || (isPast && !editing && !back)} onClick={save} className="h-10 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm text-slate-600">Holiday name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={field} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-slate-600">Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
          </label>
          <label className="block text-sm text-slate-600">Type
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={field}>
              <option value="FIXED">Fixed (company holiday)</option>
              <option value="OPTIONAL">Optional (employees request it)</option>
            </select>
          </label>
        </div>
        <label className="block text-sm text-slate-600">Religion / category (description only)
          <input value={religion} onChange={(e) => setReligion(e.target.value)} maxLength={80} className={field} placeholder="General, Marathi, Hindu…" />
        </label>
        {!editing && companies.length > 1 && (
          <>
            <label className="block text-sm text-slate-600">Company
              <select value={companyId} disabled={all} onChange={(e) => setCompanyId(e.target.value)} className={field}>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Add to every company I manage</label>
          </>
        )}
        {isPast && !editing && (
          <label className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <input type="checkbox" checked={back} onChange={(e) => setBack(e.target.checked)} className="mt-0.5" /> That date has passed. Reports for that day will change (it stops counting as a working day).
          </label>
        )}
        {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      </div>
    </Modal>
  );
}
