"use client";

import { useState } from "react";
import { fetchBlobUrl, downloadFile, fmtDateTime } from "../policies/_lib";

// One warning letter as the API sends it (real records only; nothing here is a sample).
export type Letter = {
  id: string;
  userId: string;
  title: string;
  reason: string;
  issueDate: string; // YYYY-MM-DD
  issuedBy: { name: string; designation: string | null; role: string } | null;
  fileName: string | null;
  isPdf: boolean;
  mimeType: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
};

const showDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y!, m! - 1, d!)));
};

const btnLight = "rounded-xl border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-indigo-50/60 disabled:opacity-50";
const btnPrimary = "rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50";

// The rows inside a card. `onAcknowledge` is given ONLY to the employee the letter was issued to; HR sees the acknowledgment status, never the button.
export function LetterList({ letters, onAcknowledge }: { letters: Letter[]; onAcknowledge?: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function view(l: Letter) {
    setError("");
    // Open the tab first (inside the click), then point it at the private file; otherwise the browser blocks the pop-up.
    const tab = window.open("", "_blank");
    try {
      const url = await fetchBlobUrl(`/warning-letters/${l.id}/file`);
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : "Could not open the letter.");
    }
  }
  async function download(l: Letter) {
    setError("");
    setBusy(l.id);
    try {
      await downloadFile(`/warning-letters/${l.id}/file?download=1`, l.fileName ?? "warning-letter");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not download the letter.");
    } finally {
      setBusy(null);
    }
  }
  async function acknowledge(l: Letter) {
    if (!onAcknowledge) return;
    setError("");
    setBusy(l.id);
    try {
      await onAcknowledge(l.id);
      setConfirming(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your acknowledgment.");
    } finally {
      setBusy(null);
    }
  }

  const viewable = (l: Letter) => l.isPdf || (l.mimeType ?? "").startsWith("image/");

  return (
    <div>
      {error && <p className="mx-5 mt-3 rounded-xl bg-red-50 px-4 py-2.5 text-xs text-red-700">{error}</p>}
      <ul className="divide-y divide-indigo-50">
        {letters.map((l) => (
          <li key={l.id} className="px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900">{l.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Issued {showDay(l.issueDate)}
                  {l.issuedBy ? ` · by ${l.issuedBy.name}${l.issuedBy.designation ? ` (${l.issuedBy.designation})` : ` (${l.issuedBy.role})`}` : ""}
                </p>
                <p className="mt-1.5 whitespace-pre-line break-words text-sm text-slate-700">
                  <span className="text-slate-500">Reason: </span>
                  {l.reason}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {l.acknowledgedAt ? (
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">Acknowledged {fmtDateTime(l.acknowledgedAt)}</span>
                ) : (
                  <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">{onAcknowledge ? "Awaiting your acknowledgment" : "Not yet acknowledged"}</span>
                )}
                {viewable(l) && (
                  <button type="button" onClick={() => void view(l)} className={btnLight}>
                    View
                  </button>
                )}
                <button type="button" onClick={() => void download(l)} disabled={busy === l.id} className={btnPrimary}>
                  {l.isPdf ? "Download PDF" : "Download"}
                </button>
              </div>
            </div>

            {onAcknowledge && !l.acknowledgedAt && (
              <div className="mt-3">
                {confirming === l.id ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-xl bg-indigo-50/60 px-3 py-2.5">
                    <p className="text-xs text-slate-700">Confirm that you have received and read this letter. The date and time are recorded.</p>
                    <button type="button" onClick={() => void acknowledge(l)} disabled={busy === l.id} className={btnPrimary}>
                      {busy === l.id ? "Saving…" : "Confirm"}
                    </button>
                    <button type="button" onClick={() => setConfirming(null)} className={btnLight}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setConfirming(l.id)} className={btnLight}>
                    Acknowledge receipt
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
