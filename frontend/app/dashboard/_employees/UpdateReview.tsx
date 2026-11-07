"use client";

// The review and result screens for "Update employees". The wizard itself
// (upload, column matching, the confirm dialog) is shared with Import.

import { OPTION_COPY, type ImportOptions, type UpdateCommitResult, type UpdatePreview, type UpdateRowResult, type UpdateStatus } from "./types";

const STATUS: Record<UpdateStatus, { label: string; cls: string }> = {
  UPDATE: { label: "Will update", cls: "bg-emerald-50 text-emerald-700" },
  NO_CHANGE: { label: "No change", cls: "bg-indigo-50 text-indigo-700" },
  INVALID: { label: "Needs fixing", cls: "bg-rose-50 text-rose-700" },
  SKIPPED: { label: "Skipped", cls: "bg-slate-100 text-slate-500" },
};

export const UPDATE_FILTERS: { key: UpdateStatus | "ALL"; label: string; tone: string }[] = [
  { key: "ALL", label: "All", tone: "bg-[#EDF3F1] text-slate-700" },
  { key: "UPDATE", label: "Will update", tone: "bg-emerald-50 text-emerald-700" },
  { key: "NO_CHANGE", label: "No change", tone: "bg-indigo-50 text-indigo-700" },
  { key: "INVALID", label: "Needs fixing", tone: "bg-rose-50 text-rose-700" },
  { key: "SKIPPED", label: "Skipped", tone: "bg-slate-100 text-slate-600" },
];

export function updateCount(p: UpdatePreview, k: UpdateStatus | "ALL") {
  const s = p.summary;
  return k === "ALL" ? s.total : k === "UPDATE" ? p.rows.filter((r) => r.status === "UPDATE").length : k === "NO_CHANGE" ? s.noChange : k === "INVALID" ? s.invalid : s.skipped;
}

export function UpdateTable({
  rows,
  overwrite,
  onToggle,
  disabled,
}: {
  rows: UpdateRowResult[];
  overwrite: Record<string, string[]>;
  onToggle: (rowNumber: number, field: string, on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <table className="w-full min-w-[640px] text-left text-[13px]">
      <thead className="bg-[#F3F7F6] text-[11px] uppercase tracking-wide text-slate-500">
        <tr>
          <th className="px-3 py-2.5">Row</th>
          <th className="px-3 py-2.5">Status</th>
          <th className="px-3 py-2.5">Employee</th>
          <th className="px-3 py-2.5">What would change</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-indigo-50">
        {rows.map((r) => (
          <tr key={r.rowNumber} className={`align-top ${r.status === "INVALID" ? "bg-rose-50/40" : r.status === "SKIPPED" ? "bg-slate-50/60 text-slate-400" : ""}`}>
            <td className="px-3 py-3 tabular-nums text-slate-400">{r.rowNumber}</td>
            <td className="px-3 py-3">
              <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
            </td>
            <td className="px-3 py-3">
              <span className="block font-medium text-slate-800">{r.name || "—"}</span>
              <span className="block text-[11px] text-slate-500">{[r.employeeId, r.company].filter(Boolean).join(" · ")}</span>
            </td>
            <td className="min-w-[18rem] px-3 py-3">
              {r.skipReason && <span className="block text-[11px] text-slate-500">{r.skipReason}</span>}
              {r.status === "NO_CHANGE" && <span className="block text-[11.5px] text-slate-400">Nothing to change: everything in the sheet already matches (blank cells are left as they are).</span>}
              {r.changes.map((c) => {
                const ticked = (overwrite[String(r.rowNumber)] ?? []).includes(c.field);
                return (
                  <div key={c.field} className="mb-1.5 text-[12px] leading-snug">
                    <span className="font-medium text-slate-700">{c.label}</span>{" "}
                    {c.kind === "fill" ? (
                      <>
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">fill</span>{" "}
                        <span className="text-slate-400">was empty</span> → <span className="text-slate-900">{c.proposed}</span>
                      </>
                    ) : (
                      <>
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700">conflict</span>{" "}
                        <span className="text-slate-500 line-through decoration-slate-300">{c.current || "—"}</span> → <span className="text-slate-900">{c.proposed}</span>
                        <label className="mt-1 flex cursor-pointer items-center gap-2 text-[11.5px] text-amber-800">
                          <input type="checkbox" checked={ticked} disabled={disabled || r.status === "INVALID"} onChange={(e) => onToggle(r.rowNumber, c.field, e.target.checked)} className="h-3.5 w-3.5 rounded border-amber-400 text-indigo-600" />
                          Overwrite the current value
                          {!ticked && <span className="text-slate-400">(left as it is unless ticked)</span>}
                        </label>
                      </>
                    )}
                  </div>
                );
              })}
              {r.issues.filter((i) => i.severity === "error").map((i, n) => <span key={n} className="block text-[11.5px] leading-snug text-rose-600">✕ {i.message}</span>)}
              {r.issues.filter((i) => i.severity === "warning").map((i, n) => <span key={n} className="block text-[11.5px] leading-snug text-amber-600">! {i.message}</span>)}
              {r.notes.map((n, k) => <span key={k} className="block text-[11.5px] leading-snug text-slate-400">• {n}</span>)}
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-400">No rows match.</td></tr>
        )}
      </tbody>
    </table>
  );
}

export function UpdatePanel({
  preview,
  options,
  previewing,
  onToggle,
}: {
  preview: UpdatePreview;
  options: ImportOptions;
  previewing: boolean;
  onToggle: (key: "decimalTimes" | "pmEndTimes" | "createMissingShifts", on: boolean) => void;
}) {
  const keys = (["decimalTimes", "pmEndTimes", "createMissingShifts"] as const).filter((k) => (preview.needsConfirmation[k] ?? 0) > 0 || options[k]);
  const s = preview.summary;
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-indigo-100 p-4 text-sm">
        <p className="font-semibold text-slate-900">How an update works</p>
        <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-slate-600">
          <li>• People are found by <b>Employee ID</b>. Names and IDs are never changed.</li>
          <li>• A <b>blank</b> cell leaves the current value as it is.</li>
          <li>• <b>Empty</b> fields are filled automatically.</li>
          <li>• A <b>different</b> value is a conflict: it changes only if you tick it.</li>
        </ul>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-xl bg-emerald-50 p-2.5"><p className="text-lg font-bold text-emerald-700">{s.fieldsToFill}</p><p className="text-[11px] text-emerald-700">fields to fill</p></div>
          <div className="rounded-xl bg-amber-50 p-2.5"><p className="text-lg font-bold text-amber-700">{s.conflictsChosen}/{s.conflicts}</p><p className="text-[11px] text-amber-700">conflicts to overwrite</p></div>
        </div>
      </div>

      {keys.length > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
          <p className="text-sm font-semibold text-amber-900">Needs your confirmation</p>
          <p className="mt-0.5 text-xs text-amber-800">Nothing is assumed: tick the ones you agree with, and each affected row says so.</p>
          <div className="mt-3 space-y-3">
            {keys.map((k) => (
              <label key={k} className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input type="checkbox" checked={!!options[k]} disabled={previewing} onChange={(e) => onToggle(k, e.target.checked)} className="mt-1 h-4 w-4 rounded border-amber-400 text-indigo-600" />
                <span>
                  <span className="font-medium text-slate-900">{OPTION_COPY[k].title}</span>
                  {(preview.needsConfirmation[k] ?? 0) > 0 && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">{preview.needsConfirmation[k]} {preview.needsConfirmation[k] === 1 ? "person" : "people"}</span>}
                  <span className="block text-xs text-slate-500">{OPTION_COPY[k].detail}</span>
                </span>
              </label>
            ))}
          </div>
          {options.createMissingShifts && preview.shiftsToCreate.length > 0 && (
            <ul className="mt-3 space-y-1 rounded-xl bg-white p-3 text-xs text-slate-600">
              {preview.shiftsToCreate.map((x, i) => (
                <li key={i}>• {x.platformName}: {x.start}–{x.end}, {x.days.length} day{x.days.length === 1 ? "" : "s"} a week ({x.people} {x.people === 1 ? "person" : "people"})</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function UpdateResult({ result }: { result: UpdateCommitResult }) {
  const s = result.summary;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([
          ["People updated", s.updated, "text-emerald-600"],
          ["Fields changed", s.fieldsChanged, "text-indigo-600"],
          ["Conflicts left alone", s.conflictsLeftAlone, "text-amber-600"],
          ["Not applied (errors)", s.invalid, "text-rose-600"],
        ] as const).map(([label, n, tone]) => (
          <div key={label} className="rounded-2xl bg-[#F3F7F6] p-4">
            <p className="text-xs font-medium text-slate-500">{label}</p>
            <p className={`mt-1 text-2xl font-bold tabular-nums ${tone}`}>{n}</p>
          </div>
        ))}
      </div>
      {result.shiftsCreated.length > 0 && (
        <p className="mt-4 rounded-2xl bg-[#F3F7F6] px-4 py-3 text-sm text-slate-600">New shifts created: {result.shiftsCreated.map((x) => `${x.name} (${x.company})`).join(", ")}.</p>
      )}
      <p className="mt-3 text-sm text-slate-500">A before-and-after record of every change was saved to the audit log.</p>
      <div className="mt-4 max-h-80 overflow-y-auto rounded-2xl border border-indigo-100">
        <table className="min-w-full text-left text-[13px]">
          <thead className="sticky top-0 bg-[#F3F7F6] text-[11px] uppercase tracking-wide text-slate-500">
            <tr><th className="px-4 py-2.5">Employee</th><th className="px-4 py-2.5">Changed</th></tr>
          </thead>
          <tbody className="divide-y divide-indigo-50">
            {result.rows.map((r) => (
              <tr key={r.rowNumber} className="align-top">
                <td className="px-4 py-2.5"><span className="block font-medium text-slate-800">{r.name}</span><span className="block text-[11px] text-slate-500">{r.employeeId}</span></td>
                <td className="px-4 py-2.5">{r.applied.map((a, i) => <span key={i} className="block text-[12px] text-slate-600"><b className="font-medium text-slate-700">{a.field}</b>: <span className="text-slate-400">{a.from || "empty"}</span> → {a.to}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
