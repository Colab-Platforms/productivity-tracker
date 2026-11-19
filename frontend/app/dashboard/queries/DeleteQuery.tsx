"use client";

import { useState } from "react";
import { apiPost } from "@/lib/api";
import { Modal } from "../_employees/Modal";

// ---------------------------------------------------------------------------
// DELETE A QUERY (permanent). One confirmation dialog for both kinds of query (the classic ones and department requests). Everyone who can see a
// query may delete it; the server decides again and answers "not found" for one they cannot see. Deleting removes the query, its replies, history
// and files for good. A readable copy of what was removed is kept in the Audit log (HR/Admin read it).
// ---------------------------------------------------------------------------

const trash = (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6M8.5 9v4M11.5 9v4" />
  </svg>
);

export function DeleteButton({ onClick, label = "Delete", className = "" }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label={`${label} query`}
      title="Delete permanently"
      data-testid="delete-query"
      className={`inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 ${className}`}
    >
      {trash}
      {label}
    </button>
  );
}

export function DeleteDialog({
  reference,
  subject,
  path,
  onClose,
  onDone,
}: {
  reference: string | null;
  subject: string;
  /** the delete address, e.g. /queries/<id>/delete or /queries/dept/<id>/delete */
  path: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function go() {
    setBusy(true);
    setErr("");
    try {
      await apiPost(path, { confirm: true });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Delete this query?"
      subtitle={reference ?? undefined}
      onClose={busy ? () => {} : onClose}
      width="max-w-md"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="rounded-xl border border-indigo-100 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-indigo-50 disabled:opacity-50">
            Cancel
          </button>
          <button type="button" disabled={busy} onClick={go} data-testid="confirm-delete" className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
        </div>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        <p className="break-words font-medium text-slate-900 [overflow-wrap:anywhere]">“{subject}”</p>
        <p className="rounded-xl bg-red-50 px-3 py-2 text-red-700">
          This cannot be undone. The query, every reply and note, its history and any attached files are removed for good.
        </p>
        <p className="text-xs text-slate-500">A short record of who deleted it, and what it was, is kept in the Audit log.</p>
        {err && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}
