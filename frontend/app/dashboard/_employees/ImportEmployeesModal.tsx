"use client";

// ===========================================================================
// IMPORT EMPLOYEES  (upload -> map columns -> review -> confirm -> result)
//
// The file is read on the BACKEND (/admin/employees/parse), never trusted on
// the way back: every preview and the final import are validated again there.
// Nothing is written until HR presses the confirm button in the last dialog.
//
// What the wizard guarantees HR:
//   - rows that are instructions, notes, empty or the sample row are shown as
//     "Skipped" and can never be imported;
//   - anything that would need a guess (a time typed as 9.30, a blank role...)
//     is rejected until HR ticks that exact interpretation, and every row it
//     touched says so;
//   - IDs, names, dates and times are never changed or renumbered.
// ===========================================================================

import { useMemo, useRef, useState } from "react";
import { apiPost } from "@/lib/api";
import { Modal } from "./Modal";
import { credentialsCsv, download, downloadTemplate, errorReportCsv, readAsBase64, updateErrorReportCsv } from "./files";
import { UPDATE_FILTERS, UpdatePanel, UpdateResult, UpdateTable, updateCount } from "./UpdateReview";
import {
  FIELDS,
  FIELD_INFO,
  MUST_MAP,
  OPTION_COPY,
  type CommitResult,
  type Field,
  type ImportOptions,
  type Mapping,
  type ParseResponse,
  type Preview,
  type RowResult,
  type RowStatus,
  type UpdateCommitResult,
  type UpdatePreview,
  type UpdateStatus,
} from "./types";

type Step = "upload" | "map" | "review" | "result";

const STATUS: Record<RowStatus, { label: string; cls: string }> = {
  VALID: { label: "Ready", cls: "bg-emerald-50 text-emerald-700" },
  ALREADY_EXISTS: { label: "Already in system", cls: "bg-indigo-50 text-indigo-700" },
  INVALID: { label: "Needs fixing", cls: "bg-rose-50 text-rose-700" },
  SKIPPED: { label: "Skipped", cls: "bg-slate-100 text-slate-500" },
};

const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "map", label: "Match columns" },
  { key: "review", label: "Review" },
  { key: "result", label: "Done" },
];

const PAGE = 100;

export default function ImportEmployeesModal({
  onClose,
  onDone,
  mode = "add",
}: {
  onClose: () => void;
  onDone: (message: string) => void;
  // "add" creates new people; "update" fills in details for people already in the system.
  mode?: "add" | "update";
}) {
  const [step, setStep] = useState<Step>("upload");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [fileName, setFileName] = useState("");
  const [b64, setB64] = useState("");
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [options, setOptions] = useState<ImportOptions>({ onboarding: "EXISTING" });
  const [preview, setPreview] = useState<Preview | null>(null);
  // update mode
  const [updPreview, setUpdPreview] = useState<UpdatePreview | null>(null);
  const [overwrite, setOverwrite] = useState<Record<string, string[]>>({});
  const [updResult, setUpdResult] = useState<UpdateCommitResult | null>(null);
  const [updFilter, setUpdFilter] = useState<UpdateStatus | "ALL">("ALL");
  const [updSearch, setUpdSearch] = useState("");
  const [previewing, setPreviewing] = useState(false);

  const [filter, setFilter] = useState<RowStatus | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const previewSeq = useRef(0);

  // ---- step 1: upload -------------------------------------------------------------
  async function parseFile(name: string, base64: string, sheetName?: string) {
    setBusy(true);
    setError("");
    try {
      const p = await apiPost<ParseResponse>("/admin/employees/parse", { fileName: name, contentBase64: base64, sheetName });
      setParsed(p);
      setMapping(p.suggestedMapping);
      setFileName(name);
      setB64(base64);
      setStep("map");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (!/\.(xlsx|csv)$/i.test(file.name)) return setError("Choose an .xlsx or .csv file.");
    if (file.size > 5 * 1024 * 1024) return setError("That file is larger than 5 MB.");
    if (file.size === 0) return setError("That file is empty.");
    setBusy(true);
    setError("");
    try {
      await parseFile(file.name, await readAsBase64(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
      setBusy(false);
    }
  }

  // ---- preview (re-run whenever mapping or a confirmation changes) --------------------
  async function runPreview(nextMapping: Mapping, nextOptions: ImportOptions, nextOverwrite: Record<string, string[]> = overwrite) {
    if (!parsed) return;
    const seq = ++previewSeq.current;
    setPreviewing(true);
    setError("");
    try {
      if (mode === "update") {
        const u = await apiPost<UpdatePreview>("/admin/employees/update/preview", { rows: parsed.rows, mapping: nextMapping, options: nextOptions, overwrite: nextOverwrite });
        if (seq === previewSeq.current) {
          setUpdPreview(u);
          setShown(PAGE);
        }
        return;
      }
      const p = await apiPost<Preview>("/admin/employees/preview", { rows: parsed.rows, mapping: nextMapping, options: nextOptions });
      if (seq === previewSeq.current) {
        setPreview(p);
        setShown(PAGE);
      }
    } catch (e) {
      if (seq === previewSeq.current) setError(e instanceof Error ? e.message : "Could not check the file.");
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  }

  async function toReview() {
    setStep("review");
    await runPreview(mapping, options);
  }

  function toggle(key: keyof Omit<ImportOptions, "onboarding">, on: boolean) {
    const next = { ...options, [key]: on };
    setOptions(next);
    void runPreview(mapping, next);
  }

  // Ticking a conflict means "overwrite this person's current value for this field".
  function toggleOverwrite(rowNumber: number, field: string, on: boolean) {
    const key = String(rowNumber);
    const current = overwrite[key] ?? [];
    const next = { ...overwrite, [key]: on ? [...current.filter((f) => f !== field), field] : current.filter((f) => f !== field) };
    setOverwrite(next);
    void runPreview(mapping, options, next);
  }

  async function runUpdate() {
    if (!parsed || !updPreview) return;
    setBusy(true);
    setError("");
    try {
      const done = await apiPost<UpdateCommitResult>("/admin/employees/update/commit", {
        rows: parsed.rows,
        mapping,
        options,
        overwrite,
        confirm: true,
        expectedUpdates: updPreview.summary.toUpdate,
      });
      setUpdResult(done);
      setConfirming(false);
      setStep("result");
      onDone(`Updated ${done.summary.updated} employee${done.summary.updated === 1 ? "" : "s"}`);
    } catch (e) {
      setConfirming(false);
      setError(e instanceof Error ? e.message : "The update failed. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  // ---- step 4: the import ---------------------------------------------------------------
  async function runImport() {
    if (!parsed || !preview) return;
    setBusy(true);
    setError("");
    try {
      const done = await apiPost<CommitResult>("/admin/employees/commit", {
        rows: parsed.rows,
        mapping,
        options,
        confirm: true,
        expectedValid: preview.summary.valid,
      });
      setResult(done);
      setConfirming(false);
      setStep("result");
      onDone(`Imported ${done.summary.imported} employee${done.summary.imported === 1 ? "" : "s"}`);
    } catch (e) {
      setConfirming(false);
      setError(e instanceof Error ? e.message : "The import failed. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (preview?.rows ?? []).filter(
      (r) =>
        (filter === "ALL" || r.status === filter) &&
        (!q || `${r.values.fullName} ${r.values.employeeId} ${r.values.company} ${r.values.email}`.toLowerCase().includes(q))
    );
  }, [preview, filter, search]);

  const otherCompanyRows = (preview?.rows ?? []).filter((r) => r.issues.some((i) => i.code === "OUTSIDE_YOUR_COMPANY")).length;
  // To UPDATE someone, only the Employee ID is needed: it is how they are found.
  const mustMap = mode === "update" ? (["employeeId"] as typeof MUST_MAP) : MUST_MAP;
  const required = mustMap.filter((f) => mapping[f] === null || mapping[f] === undefined);
  const updRows = (updPreview?.rows ?? []).filter(
    (r) =>
      (updFilter === "ALL" || r.status === updFilter) &&
      (!updSearch.trim() || `${r.name} ${r.employeeId} ${r.company}`.toLowerCase().includes(updSearch.trim().toLowerCase()))
  );
  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const summary = preview?.summary;

  // The confirmations to show: the ones some row needs, plus any already ticked
  // (so they can be un-ticked again).
  const optionKeys = (Object.keys(OPTION_COPY) as (keyof typeof OPTION_COPY)[]).filter(
    (k) => (preview?.needsConfirmation[k] ?? 0) > 0 || options[k]
  );

  // ---------------------------------------------------------------------------
  const stepper = (
    <ol className="mb-5 flex flex-wrap items-center gap-2 text-xs">
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full font-semibold ${i < stepIndex ? "bg-emerald-100 text-emerald-700" : i === stepIndex ? "bg-indigo-600 text-white" : "bg-[#EDF3F1] text-slate-400"}`}>
            {i < stepIndex ? "✓" : i + 1}
          </span>
          <span className={i === stepIndex ? "font-semibold text-slate-900" : "text-slate-400"}>{s.label}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-5 bg-indigo-100" />}
        </li>
      ))}
    </ol>
  );

  const errorBox = error && <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>;

  // ====================== UPDATE: RESULT ======================
  if (mode === "update" && step === "result" && updResult) {
    return (
      <Modal
        title="Update complete"
        subtitle={fileName}
        onClose={onClose}
        width="max-w-4xl"
        footer={
          <div className="flex justify-end">
            <button onClick={onClose} className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">Done</button>
          </div>
        }
      >
        {stepper}
        <UpdateResult result={updResult} />
      </Modal>
    );
  }

  // ====================== RESULT ======================
  if (step === "result" && result) {
    const s = result.summary;
    return (
      <Modal
        title="Import complete"
        subtitle={fileName}
        onClose={onClose}
        width="max-w-4xl"
        footer={
          <div className="flex justify-end">
            <button onClick={onClose} className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">Done</button>
          </div>
        }
      >
        {stepper}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Imported", s.imported, "text-emerald-600"],
            ["Already in system", s.skippedExisting, "text-indigo-600"],
            ["Failed", s.failed, "text-rose-600"],
            ["Skipped rows", s.skippedRows, "text-slate-500"],
          ].map(([label, n, tone]) => (
            <div key={String(label)} className="rounded-2xl bg-[#F3F7F6] p-4">
              <p className="text-xs font-medium text-slate-500">{label}</p>
              <p className={`mt-1 text-2xl font-bold tabular-nums ${tone}`}>{n}</p>
            </div>
          ))}
        </div>

        {result.shiftsCreated.length > 0 && (
          <p className="mt-4 rounded-2xl bg-[#F3F7F6] px-4 py-3 text-sm text-slate-600">
            New shifts created: {result.shiftsCreated.map((x) => `${x.name} (${x.company})`).join(", ")}.
          </p>
        )}
        <p className="mt-3 text-sm text-slate-500">
          {options.onboarding === "EXISTING"
            ? "These are existing employees, so the tracker opens as soon as each person sets their own password."
            : `Welcome emails: ${result.mail.sent} sent, ${result.mail.failed} could not be sent, ${result.mail.noEmail} have no real email.`}
        </p>

        <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">One-time sign-in details</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800">
            These temporary passwords are shown only now. Only a scrambled copy is stored, so they cannot be looked up
            again. Download the list, hand each person their own line, and delete the file. Everyone must change their
            password at first sign-in.
          </p>
          <button
            onClick={() => download("employee-credentials.csv", credentialsCsv(result.credentials))}
            className="mt-3 rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700"
          >
            Download sign-in list (CSV)
          </button>
        </div>

        <div className="mt-5 overflow-x-auto rounded-2xl border border-indigo-100">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-[#F3F7F6] text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Employee ID</th>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Company</th>
                <th className="px-4 py-2.5">Sign in with</th>
                <th className="px-4 py-2.5">Temporary password</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-indigo-50">
              {result.credentials.map((c) => (
                <tr key={c.rowNumber}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{c.employeeId}</td>
                  <td className="px-4 py-2.5">{c.name}</td>
                  <td className="px-4 py-2.5 text-slate-500">{c.company}</td>
                  <td className="px-4 py-2.5 text-slate-500">{c.signInWith}</td>
                  <td className="px-4 py-2.5 font-mono tracking-wide">{c.temporaryPassword}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {preview && s.failed > 0 && (
          <button onClick={() => download("employee-import-errors.csv", errorReportCsv(preview.rows))} className="mt-5 rounded-xl border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50">
            Download error report ({s.failed} row{s.failed === 1 ? "" : "s"} not imported)
          </button>
        )}
      </Modal>
    );
  }

  // ====================== UPLOAD ======================
  if (step === "upload") {
    return (
      <Modal
        title={mode === "update" ? "Update employees" : "Import employees"}
        subtitle={mode === "update" ? "Fill in missing details for people who are already in the system, from an Excel or CSV file." : "Add many people at once from an Excel or CSV file."}
        onClose={onClose}
        dismissible={!busy}
        width="max-w-2xl"
      >
        {stepper}
        {errorBox}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); void onFile(e.dataTransfer.files[0]); }}
          className={`flex flex-col items-center rounded-3xl border-2 border-dashed px-6 py-12 text-center transition ${dragging ? "border-indigo-500 bg-indigo-50" : "border-indigo-200 bg-[#F3F7F6]"}`}
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-indigo-600 shadow-sm">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <p className="mt-4 text-sm font-medium text-slate-800">{busy ? "Reading your file…" : "Drop your file here"}</p>
          <p className="mt-1 text-xs text-slate-500">.xlsx or .csv, up to 5 MB and 2,000 people</p>
          <input ref={input} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
          <button disabled={busy} onClick={() => input.current?.click()} className="mt-5 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-600/25 transition hover:bg-indigo-700 disabled:opacity-50">
            Choose a file
          </button>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-100 px-4 py-3 text-sm">
          <p className="text-slate-600">Not sure of the layout? Start from the sample.</p>
          <button
            onClick={() => void downloadTemplate().catch((e: Error) => setError(e.message))}
            className="rounded-xl border border-indigo-200 px-4 py-2 font-medium text-indigo-700 hover:bg-indigo-50"
          >
            Download sample template
          </button>
        </div>
        <ul className="mt-4 space-y-1.5 text-xs leading-relaxed text-slate-500">
          <li>• The heading row is found automatically, so notes above it are ignored.</li>
          <li>• A row marked “EXAMPLE ROW”, empty rows and note lines are never imported.</li>
          <li>• Nothing is saved until you review the preview and confirm.</li>
        </ul>
      </Modal>
    );
  }

  // ====================== MAP ======================
  if (step === "map" && parsed) {
    const importable = parsed.rows.filter((r) => !r.skip).length;
    const skipped = parsed.rows.length - importable;
    return (
      <Modal
        title="Match your columns"
        subtitle={`${fileName} · heading found on row ${parsed.headerRow}`}
        onClose={onClose}
        width="max-w-3xl"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button onClick={() => { setStep("upload"); setParsed(null); }} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-indigo-50">Back</button>
            <div className="flex items-center gap-3">
              {required.length > 0 && <span className="text-xs text-rose-600">Match: {required.map((f) => FIELD_INFO[f].label).join(", ")}</span>}
              <button disabled={required.length > 0} onClick={() => void toReview()} className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-600/25 transition hover:bg-indigo-700 disabled:opacity-40 disabled:shadow-none">
                Check the data
              </button>
            </div>
          </div>
        }
      >
        {stepper}
        {errorBox}
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-[#F3F7F6] p-3.5 text-sm"><p className="text-xs text-slate-500">People found</p><p className="text-xl font-bold text-slate-900">{importable}</p></div>
          <div className="rounded-2xl bg-[#F3F7F6] p-3.5 text-sm"><p className="text-xs text-slate-500">Rows skipped</p><p className="text-xl font-bold text-slate-900">{skipped}</p><p className="text-[11px] text-slate-400">example, empty or note rows</p></div>
          <div className="rounded-2xl bg-[#F3F7F6] p-3.5 text-sm"><p className="text-xs text-slate-500">Instruction rows above the headings</p><p className="text-xl font-bold text-slate-900">{parsed.ignoredAboveHeader}</p><p className="text-[11px] text-slate-400">ignored</p></div>
        </div>

        {parsed.sheets.length > 1 && (
          <div className="mb-4 flex items-center gap-3 text-sm">
            <span className="text-slate-500">Sheet</span>
            <select value={parsed.sheet} disabled={busy} onChange={(e) => void parseFile(fileName, b64, e.target.value)} className="rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm">
              {parsed.sheets.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
        )}

        <div className="overflow-hidden rounded-2xl border border-indigo-100">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-[#F3F7F6] text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-4 py-2.5">System field</th><th className="px-4 py-2.5">Column in your file</th><th className="hidden px-4 py-2.5 sm:table-cell">First value</th></tr>
            </thead>
            <tbody className="divide-y divide-indigo-50">
              {FIELDS.map((f: Field) => {
                const idx = mapping[f];
                const first = idx !== null && idx !== undefined ? parsed.rows.find((r) => !r.skip)?.cells[idx] : null;
                const must = MUST_MAP.includes(f);
                return (
                  <tr key={f}>
                    <td className="px-4 py-2">
                      <span className="font-medium text-slate-800">{FIELD_INFO[f].label}</span>
                      {FIELD_INFO[f].required && <span className="ml-1 text-rose-500" title="Required">*</span>}
                      {FIELD_INFO[f].hint && <span className="block text-[11px] text-slate-400">{FIELD_INFO[f].hint}</span>}
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={idx ?? ""}
                        onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value === "" ? null : Number(e.target.value) }))}
                        className={`w-full rounded-xl border bg-white px-3 py-2 text-sm ${must && (idx === null || idx === undefined) ? "border-rose-300" : "border-indigo-200"}`}
                      >
                        <option value="">— not in my file —</option>
                        {parsed.headers.map((h, i) => (h ? <option key={i} value={i}>{h}</option> : null))}
                      </select>
                    </td>
                    <td className="hidden max-w-[12rem] truncate px-4 py-2 text-slate-400 sm:table-cell">{first === null || first === undefined ? "" : String(first)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Modal>
    );
  }

  // ====================== UPDATE: REVIEW ======================
  if (mode === "update" && step === "review") {
    const us = updPreview?.summary;
    return (
      <>
        <Modal
          title="Review the updates"
          subtitle={`${fileName} · nothing has been changed yet`}
          onClose={onClose}
          dismissible={!busy}
          width="max-w-7xl"
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button onClick={() => setStep("map")} disabled={busy} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-indigo-50 disabled:opacity-50">Back</button>
              <div className="flex flex-wrap items-center gap-3">
                {updPreview && updPreview.summary.invalid > 0 && (
                  <button onClick={() => download("employee-update-errors.csv", updateErrorReportCsv(updPreview.rows))} className="rounded-xl border border-rose-200 px-4 py-2.5 text-sm font-medium text-rose-700 hover:bg-rose-50">Download error report</button>
                )}
                <button
                  disabled={!us || us.toUpdate === 0 || previewing || busy}
                  onClick={() => setConfirming(true)}
                  className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-600/25 transition hover:bg-indigo-700 disabled:opacity-40 disabled:shadow-none"
                >
                  {us && us.toUpdate > 0 ? `Update ${us.toUpdate} employee${us.toUpdate === 1 ? "" : "s"}…` : "Nothing to update"}
                </button>
              </div>
            </div>
          }
        >
          {stepper}
          {errorBox}
          {!updPreview ? (
            <div className="space-y-3">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-12" />)}</div>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
              <div className={`min-w-0 ${previewing ? "opacity-60 transition-opacity" : "transition-opacity"}`}>
                <div className="mb-4 flex flex-wrap gap-2">
                  {UPDATE_FILTERS.map((f) => (
                    <button key={f.key} onClick={() => { setUpdFilter(f.key); setShown(PAGE); }} className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${f.tone} ${updFilter === f.key ? "ring-2 ring-indigo-500" : "opacity-80 hover:opacity-100"}`}>
                      {f.label} <span className="ml-1 tabular-nums">{updateCount(updPreview, f.key)}</span>
                    </button>
                  ))}
                  <input value={updSearch} onChange={(e) => { setUpdSearch(e.target.value); setShown(PAGE); }} placeholder="Search name or ID…" className="ml-auto w-full rounded-xl border border-indigo-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-500 sm:w-60" />
                </div>
                <div className="overflow-x-auto rounded-2xl border border-indigo-100">
                  <UpdateTable rows={updRows.slice(0, shown)} overwrite={overwrite} onToggle={toggleOverwrite} disabled={previewing} />
                </div>
                {updRows.length > shown && <button onClick={() => setShown((n) => n + PAGE)} className="mt-3 rounded-xl border border-indigo-200 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50">Show {Math.min(PAGE, updRows.length - shown)} more</button>}
              </div>
              <aside className="order-first lg:order-none">
                <UpdatePanel preview={updPreview} options={options} previewing={previewing} onToggle={toggle} />
              </aside>
            </div>
          )}
        </Modal>

        {confirming && us && (
          <Modal
            title={`Update ${us.toUpdate} employee${us.toUpdate === 1 ? "" : "s"}?`}
            subtitle="This changes real employee records. Please check the summary."
            onClose={() => setConfirming(false)}
            dismissible={!busy}
            width="max-w-lg"
            footer={
              <div className="flex justify-end gap-2">
                <button disabled={busy} onClick={() => setConfirming(false)} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-indigo-50 disabled:opacity-50">Go back</button>
                <button disabled={busy} onClick={() => void runUpdate()} className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-600/25 hover:bg-indigo-700 disabled:opacity-50">{busy ? "Updating…" : `Yes, update ${us.toUpdate}`}</button>
              </div>
            }
          >
            <ul className="space-y-2 text-sm text-slate-700">
              <li>✓ <b>{us.fieldsToFill}</b> empty field{us.fieldsToFill === 1 ? "" : "s"} will be filled in.</li>
              <li>✓ <b>{us.conflictsChosen}</b> existing value{us.conflictsChosen === 1 ? "" : "s"} will be <b>overwritten</b> (the ones you ticked).</li>
              <li>• <b>{us.conflicts - us.conflictsChosen}</b> conflict{us.conflicts - us.conflictsChosen === 1 ? "" : "s"} you did not tick will be left exactly as they are.</li>
              <li>• <b>{us.noChange}</b> already match; <b>{us.invalid}</b> row{us.invalid === 1 ? "" : "s"} with problems will <b>not</b> be applied.</li>
              {options.createMissingShifts && (updPreview?.shiftsToCreate.length ?? 0) > 0 && <li>• {updPreview!.shiftsToCreate.length} new shift{updPreview!.shiftsToCreate.length === 1 ? "" : "s"} will be created.</li>}
            </ul>
            <p className="mt-4 rounded-2xl bg-[#F3F7F6] px-4 py-3 text-xs leading-relaxed text-slate-600">
              Names and employee IDs are never changed. Everything saves together or not at all, and the old value of every change is kept in the audit log.
            </p>
          </Modal>
        )}
      </>
    );
  }

  // ====================== REVIEW ======================
  const confirmPanel = (
    <div className="space-y-3">
      <div className="rounded-2xl border border-indigo-100 p-4">
        <p className="text-sm font-semibold text-slate-900">How should these people start?</p>
        <div className="mt-3 space-y-2 text-sm">
          {([
            ["EXISTING", "They already work here", "The tracker opens as soon as they set their own password."],
            ["NEW_JOINER", "They are new joiners", "Document onboarding first; a welcome email goes to real addresses."],
          ] as const).map(([v, t, d]) => (
            <label key={v} className="flex cursor-pointer items-start gap-2.5">
              <input type="radio" name="imp-onb" checked={options.onboarding === v} onChange={() => { const n = { ...options, onboarding: v }; setOptions(n); void runPreview(mapping, n); }} className="mt-1 h-4 w-4 text-indigo-600" />
              <span><span className="font-medium text-slate-800">{t}</span><span className="block text-xs text-slate-500">{d}</span></span>
            </label>
          ))}
        </div>
      </div>

      {optionKeys.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
          <p className="text-sm font-semibold text-amber-900">Needs your confirmation</p>
          <p className="mt-0.5 text-xs text-amber-800">Your file has values that need interpreting. Nothing is assumed: tick the ones you agree with, and each affected row will say so.</p>
          <div className="mt-3 space-y-3">
            {optionKeys.map((k) => (
              <label key={k} className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input type="checkbox" checked={!!options[k]} disabled={previewing} onChange={(e) => toggle(k, e.target.checked)} className="mt-1 h-4 w-4 rounded border-amber-400 text-indigo-600" />
                <span>
                  <span className="font-medium text-slate-900">{OPTION_COPY[k].title}</span>
                  {(preview?.needsConfirmation[k] ?? 0) > 0 && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">{preview?.needsConfirmation[k]} rows</span>}
                  <span className="block text-xs text-slate-500">{OPTION_COPY[k].detail}</span>
                </span>
              </label>
            ))}
          </div>
          {options.createMissingShifts && (preview?.shiftsToCreate.length ?? 0) > 0 && (
            <ul className="mt-3 space-y-1 rounded-xl bg-white p-3 text-xs text-slate-600">
              {preview!.shiftsToCreate.map((s, i) => (
                <li key={i}>• {s.platformName}: {s.start}–{s.end}, {s.days.length} day{s.days.length === 1 ? "" : "s"} a week ({s.rows} {s.rows === 1 ? "person" : "people"})</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      <Modal
        title="Review before importing"
        subtitle={`${fileName} · nothing has been saved yet`}
        onClose={onClose}
        dismissible={!busy}
        width="max-w-7xl"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button onClick={() => setStep("map")} disabled={busy} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-indigo-50 disabled:opacity-50">Back</button>
            <div className="flex flex-wrap items-center gap-3">
              {preview && preview.summary.invalid > 0 && (
                <button onClick={() => download("employee-import-errors.csv", errorReportCsv(preview.rows))} className="rounded-xl border border-rose-200 px-4 py-2.5 text-sm font-medium text-rose-700 hover:bg-rose-50">
                  Download error report
                </button>
              )}
              <button
                disabled={!summary || summary.valid === 0 || previewing || busy}
                onClick={() => setConfirming(true)}
                className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-600/25 transition hover:bg-indigo-700 disabled:opacity-40 disabled:shadow-none"
              >
                {summary && summary.valid > 0 ? `Import ${summary.valid} employee${summary.valid === 1 ? "" : "s"}…` : "Nothing to import"}
              </button>
            </div>
          </div>
        }
      >
        {stepper}
        {errorBox}

        {!preview ? (
          <div className="space-y-3">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-12" />)}</div>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
            <div className={`min-w-0 ${previewing ? "opacity-60 transition-opacity" : "transition-opacity"}`}>
              {otherCompanyRows > 0 && (
                <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <b>{otherCompanyRows}</b> row{otherCompanyRows === 1 ? " belongs" : "s belong"} to other companies. You can only add people to your own
                  company, so those can&apos;t be imported from this account. An owner-level Admin can import the whole file.
                </div>
              )}
              <div className="mb-4 flex flex-wrap gap-2">
                {([
                  ["ALL", "All", preview.summary.total, "bg-[#EDF3F1] text-slate-700"],
                  ["VALID", "Ready", preview.summary.valid, "bg-emerald-50 text-emerald-700"],
                  ["ALREADY_EXISTS", "Already in system", preview.summary.alreadyExists, "bg-indigo-50 text-indigo-700"],
                  ["INVALID", "Needs fixing", preview.summary.invalid, "bg-rose-50 text-rose-700"],
                  ["SKIPPED", "Skipped", preview.summary.skipped, "bg-slate-100 text-slate-600"],
                ] as const).map(([k, label, n, cls]) => (
                  <button key={k} onClick={() => { setFilter(k); setShown(PAGE); }} className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${cls} ${filter === k ? "ring-2 ring-indigo-500" : "opacity-80 hover:opacity-100"}`}>
                    {label} <span className="ml-1 tabular-nums">{n}</span>
                  </button>
                ))}
                <input value={search} onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }} placeholder="Search name, ID, company…" className="ml-auto w-full rounded-xl border border-indigo-200 px-3 py-1.5 text-sm outline-none focus:border-indigo-500 sm:w-60" />
              </div>

              <div className="overflow-x-auto rounded-2xl border border-indigo-100">
                <table className="min-w-[640px] w-full text-left text-[13px]">
                  <thead className="bg-[#F3F7F6] text-[11px] uppercase tracking-wide text-slate-500">
                    <tr><th className="px-3 py-2.5">Row</th><th className="px-3 py-2.5">Status</th><th className="px-3 py-2.5">Employee</th><th className="px-3 py-2.5">Details</th></tr>
                  </thead>
                  <tbody className="divide-y divide-indigo-50">
                    {rows.slice(0, shown).map((r: RowResult) => (
                      <tr key={r.rowNumber} className={`align-top ${r.status === "INVALID" ? "bg-rose-50/40" : r.status === "SKIPPED" ? "bg-slate-50/60 text-slate-400" : ""}`}>
                        <td className="px-3 py-3 tabular-nums text-slate-400">{r.rowNumber}</td>
                        <td className="px-3 py-3"><span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
                        <td className="px-3 py-3">
                          <span className="block font-medium text-slate-800">{r.values.fullName || "—"}</span>
                          <span className="block text-[11px] text-slate-500">{[r.values.employeeId, r.values.company].filter(Boolean).join(" · ")}</span>
                          {r.values.email && <span className="block text-[11px] text-slate-400">{r.values.email}</span>}
                          <span className="mt-1 block text-[11px] text-slate-600">{r.values.role || "no role"} · {r.values.shift || "no shift"}</span>
                          {r.values.reportsTo && <span className="block text-[11px] text-slate-400">reports to {r.values.reportsTo}</span>}
                        </td>
                        <td className="min-w-[16rem] px-3 py-3">
                          {r.skipReason && <span className="block text-[11px] text-slate-500">{r.skipReason}</span>}
                          {r.issues.filter((i) => i.severity === "error").map((i, n) => <span key={n} className="block text-[11.5px] leading-snug text-rose-600">✕ {i.message}</span>)}
                          {r.issues.filter((i) => i.severity === "warning").map((i, n) => <span key={n} className="block text-[11.5px] leading-snug text-amber-600">! {i.message}</span>)}
                          {r.notes.map((n, k) => <span key={k} className="block text-[11.5px] leading-snug text-slate-400">• {n}</span>)}
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-400">No rows match.</td></tr>}
                  </tbody>
                </table>
              </div>
              {rows.length > shown && <button onClick={() => setShown((n) => n + PAGE)} className="mt-3 rounded-xl border border-indigo-200 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50">Show {Math.min(PAGE, rows.length - shown)} more</button>}
            </div>
            {/* On a phone the confirmations come first: they decide what the table below shows. */}
            <aside className="order-first lg:order-none">{confirmPanel}</aside>
          </div>
        )}
      </Modal>

      {confirming && summary && (
        <Modal
          title={`Import ${summary.valid} employee${summary.valid === 1 ? "" : "s"}?`}
          subtitle="This creates real accounts. Please check the summary."
          onClose={() => setConfirming(false)}
          dismissible={!busy}
          width="max-w-lg"
          footer={
            <div className="flex justify-end gap-2">
              <button disabled={busy} onClick={() => setConfirming(false)} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-indigo-50 disabled:opacity-50">Go back</button>
              <button disabled={busy} onClick={() => void runImport()} className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-600/25 hover:bg-indigo-700 disabled:opacity-50">
                {busy ? "Importing…" : `Yes, import ${summary.valid}`}
              </button>
            </div>
          }
        >
          <ul className="space-y-2 text-sm text-slate-700">
            <li>✓ <b>{summary.valid}</b> new account{summary.valid === 1 ? "" : "s"} will be created.</li>
            <li>• <b>{summary.alreadyExists}</b> already in the system: left exactly as they are.</li>
            <li>• <b>{summary.invalid}</b> row{summary.invalid === 1 ? "" : "s"} with problems: <b>not</b> imported.</li>
            <li>• <b>{summary.skipped}</b> example, empty or note row{summary.skipped === 1 ? "" : "s"}: ignored.</li>
            {options.createMissingShifts && (preview?.shiftsToCreate.length ?? 0) > 0 && <li>• {preview!.shiftsToCreate.length} new shift{preview!.shiftsToCreate.length === 1 ? "" : "s"} will be created.</li>}
            <li>• {options.onboarding === "EXISTING" ? "Existing employees: the tracker opens once each person sets their own password." : "New joiners: document onboarding comes first."}</li>
          </ul>
          <p className="mt-4 rounded-2xl bg-[#F3F7F6] px-4 py-3 text-xs leading-relaxed text-slate-600">
            Each person gets a different random temporary password, shown to you once after the import. All of it saves
            together or not at all: if anything goes wrong, nothing is created.
          </p>
        </Modal>
      )}
    </>
  );
}
