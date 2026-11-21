"use client";

import { useRef, useState } from "react";
import { apiPost } from "@/lib/api";
import { Modal } from "../../_employees/Modal";
import { readAsBase64, download, toCsv } from "../../_employees/files";
import { KIND_LABEL, STATE_LABEL, TEMPLATE_ROWS, codeOf, msg, pretty, type Preview } from "./model";

// Upload -> preview (nothing is saved) -> HR corrects or excludes rows -> confirm -> saved as a DRAFT calendar. Publishing is a separate step on the
// calendar page. The server reads the file again on confirm, so what is saved is never taken from this screen.
const STATE_CLASS: Record<string, string> = {
  VALID: "bg-emerald-50 text-emerald-700",
  ERROR: "bg-rose-50 text-rose-700",
  DUPLICATE_IN_FILE: "bg-amber-50 text-amber-700",
  ALREADY_EXISTS: "bg-slate-100 text-slate-600",
};

export default function ImportWizard({ year, companies, companyId, onClose, onDone }: { year: number; companies: { id: string; name: string }[]; companyId: string; onClose: () => void; onDone: (m: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [company, setCompany] = useState(companyId || companies[0]?.id || "");
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replace, setReplace] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [draftExists, setDraftExists] = useState(false);

  async function choose(f: File | undefined) {
    if (!f) return;
    setError(""); setPreview(null); setExcluded(new Set()); setConfirm(false); setDraftExists(false);
    try {
      const b64 = await readAsBase64(f);
      setFile({ name: f.name, b64 });
      await run(f.name, b64);
    } catch (e) { setError(msg(e)); setFile(null); }
  }
  async function run(name: string, b64: string, c = company) {
    setBusy(true); setError("");
    try {
      const p = await apiPost<Preview>("/holiday-calendar/import/preview", { fileName: name, contentBase64: b64, year, companyId: c });
      setPreview(p);
    } catch (e) { setError(msg(e)); setPreview(null); } finally { setBusy(false); }
  }
  const toggle = (n: number) => setExcluded((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });

  const rows = preview?.rows ?? [];
  const willImport = rows.filter((r) => r.state === "VALID" && !excluded.has(r.rowNumber)).length;
  const errors = rows.filter((r) => r.state === "ERROR").length;

  async function commit() {
    if (!file || !preview) return;
    setBusy(true); setError("");
    try {
      const r = await apiPost<{ imported: number; skipped: number; failed: number }>("/holiday-calendar/import/commit", { fileName: file.name, contentBase64: file.b64, year, companyId: company, confirm: true, excludeRows: [...excluded], expectedImport: willImport, replaceDraft: replace });
      onDone(`Saved ${r.imported} holiday(s) as a draft calendar · ${r.skipped} skipped · ${r.failed} failed. Review it, then publish.`);
    } catch (e) {
      if (codeOf(e) === "DRAFT_EXISTS") setDraftExists(true);
      setError(msg(e));
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title="Upload holiday sheet"
      subtitle={`Calendar year ${year}. Nothing is saved until you confirm.`}
      onClose={onClose}
      width="max-w-5xl"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={confirm} disabled={!preview?.ok || willImport === 0} onChange={(e) => setConfirm(e.target.checked)} className="h-4 w-4" />
            I have reviewed the preview and want to save {willImport} holiday(s) as a draft.
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="h-10 rounded-xl border border-indigo-100 px-4 text-sm font-medium text-slate-600 hover:bg-indigo-50">Cancel</button>
            <button type="button" disabled={!confirm || busy || willImport === 0} onClick={commit} className="h-10 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? "Working…" : "Confirm import"}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          {companies.length > 1 && (
            <label className="text-sm text-slate-600">
              Company
              <select value={company} onChange={(e) => { setCompany(e.target.value); if (file) run(file.name, file.b64, e.target.value); }} className="mt-1 block h-10 rounded-xl border border-indigo-100 bg-white px-3 text-sm">
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <div>
            <input ref={input} type="file" accept=".xlsx,.csv" className="sr-only" id="holiday-file" aria-label="Choose holiday sheet" onChange={(e) => choose(e.target.files?.[0])} />
            <button type="button" onClick={() => input.current?.click()} className="h-10 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700">
              {file ? "Choose another file" : "Choose .xlsx or .csv file"}
            </button>
            {file && <span className="ml-3 text-sm text-slate-600">{file.name}</span>}
          </div>
          <button type="button" onClick={() => download("holiday-sheet-template.csv", toCsv(TEMPLATE_ROWS))} className="h-10 rounded-xl border border-indigo-100 px-4 text-sm font-medium text-indigo-700 hover:bg-indigo-50">
            Download template
          </button>
        </div>
        <p className="text-xs text-slate-500">Columns: Date, Day, Holiday, Status (Fixed or Optional), Religion. Names and categories are kept exactly as written. Old .xls files: save as .xlsx first.</p>

        {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        {draftExists && (
          <label className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace the existing unpublished draft for {year} (it is kept as discarded history).
          </label>
        )}
        {busy && !preview && <p className="text-sm text-slate-500">Reading the file…</p>}

        {preview && !preview.ok && (
          <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">The sheet is missing required column(s): {preview.missingColumns?.join(", ")}. Use the template headings.</p>
        )}

        {preview?.ok && (
          <>
            {preview.note && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">{preview.note}</p>}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="import-summary">
              {[["Rows read", preview.summary?.total], ["Ready to import", willImport], ["Errors", errors], ["Already saved", preview.summary?.alreadyExist], ["Excluded", excluded.size]].map(([l, v]) => (
                <div key={String(l)} className="rounded-xl bg-[#F3F7F6] px-3 py-2"><p className="text-xs text-slate-500">{l}</p><p className="text-lg font-semibold text-slate-900">{v ?? 0}</p></div>
              ))}
            </div>
            <div className="max-h-[50vh] overflow-auto rounded-xl border border-indigo-100">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="sticky top-0 bg-white text-xs uppercase text-slate-500">
                  <tr><th className="px-3 py-2">Row</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Day</th><th className="px-3 py-2">Holiday</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Religion / category</th><th className="px-3 py-2">Validation</th><th className="px-3 py-2">Exclude</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.rowNumber} className={`border-t border-indigo-50 align-top ${excluded.has(r.rowNumber) ? "opacity-50" : ""}`}>
                      <td className="px-3 py-2 text-slate-500">{r.rowNumber}</td>
                      <td className="px-3 py-2">{r.date ? pretty(r.date) : <span className="text-rose-600">{r.dateText || "—"}</span>}</td>
                      <td className="px-3 py-2">{r.weekday || r.dayText || "—"}</td>
                      <td className="px-3 py-2">{r.name || "—"}</td>
                      <td className="px-3 py-2">{r.kind ? KIND_LABEL[r.kind] : <span className="text-rose-600">{r.statusText || "—"}</span>}</td>
                      <td className="px-3 py-2">{r.religion || "—"}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${STATE_CLASS[r.state]}`}>{STATE_LABEL[r.state]}</span>
                        {r.messages.map((m, i) => <p key={i} className="mt-1 text-xs text-slate-600">{m}</p>)}
                      </td>
                      <td className="px-3 py-2">
                        <input type="checkbox" aria-label={`Exclude row ${r.rowNumber}`} checked={excluded.has(r.rowNumber)} disabled={r.state !== "VALID"} onChange={() => toggle(r.rowNumber)} className="h-4 w-4" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {errors > 0 && <p className="text-xs text-slate-500">Rows with errors are never imported. Fix them in your sheet and upload it again, or leave them out.</p>}
          </>
        )}
      </div>
    </Modal>
  );
}
