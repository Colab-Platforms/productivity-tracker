"use client";

import { useState } from "react";

// The pair of download buttons every team report shows: Export CSV (as before) and Export Excel (a real .xlsx file).
// Excel is built in the browser from the complete filtered data, so it can take a moment: the button says so and cannot be pressed twice.
export default function ExportButtons({ onCsv, onExcel, disabled }: { onCsv: () => void; onExcel: () => Promise<void>; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function excel() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onExcel();
    } catch (e) {
      setError((e as Error).message || "Could not create the Excel file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={onCsv} disabled={disabled} className="rounded-xl border border-indigo-100 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
        Export CSV
      </button>
      <button type="button" onClick={excel} disabled={disabled || busy} aria-busy={busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
        {busy ? "Preparing…" : "Export Excel"}
      </button>
      {error && <span role="alert" className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
