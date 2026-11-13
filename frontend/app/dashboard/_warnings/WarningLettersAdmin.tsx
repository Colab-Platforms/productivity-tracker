"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Modal } from "../_employees/Modal";
import { readFile } from "../policies/_lib";
import { LetterList, type Letter } from "./LetterList";

// HR / Admin: the warning letters of ONE employee and the form to issue a new one. Shown inside the Edit employee drawer. The server checks that the
// signed-in person is HR/Admin of the employee's company; this screen only offers the tools.

const input = "w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-700";
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function WarningLettersAdmin({ userId, name }: { userId: string; name: string }) {
  const [letters, setLetters] = useState<Letter[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState("");

  const load = useCallback(async () => {
    try {
      setLetters((await apiGet<{ letters: Letter[] }>(`/warning-letters/person/${userId}`)).letters);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the warning letters.");
      setLetters((cur) => cur ?? []);
    }
  }, [userId]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mt-6 border-t border-indigo-100 pt-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Warning letters</p>
        <button type="button" onClick={() => { setDone(""); setOpen(true); }} className="rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700">
          Issue warning letter
        </button>
      </div>
      {done && <p className="mb-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{done}</p>}
      {error && <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {letters === null ? (
        <div className="skeleton h-10" aria-busy="true" />
      ) : letters.length === 0 ? (
        <p className="rounded-xl bg-indigo-50/40 px-3 py-4 text-center text-xs text-slate-500">No warning letters issued.</p>
      ) : (
        <div className="-mx-5 rounded-xl">
          <LetterList letters={letters} />
        </div>
      )}
      {open && (
        <IssueModal
          userId={userId}
          name={name}
          onClose={() => setOpen(false)}
          onIssued={() => {
            setOpen(false);
            setDone(`Warning letter issued to ${name}. It now appears in their profile.`);
            void load();
          }}
        />
      )}
    </div>
  );
}

function IssueModal({ userId, name, onClose, onIssued }: { userId: string; name: string; onClose: () => void; onIssued: () => void }) {
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [issueDate, setIssueDate] = useState(today());
  const [mode, setMode] = useState<"upload" | "type">("upload");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    if (title.trim().length < 3) return setError("Give the letter a name (at least 3 characters).");
    if (reason.trim().length < 3) return setError("Write the reason (at least 3 characters).");
    if (mode === "upload" && !file) return setError("Choose the letter file to upload.");
    if (mode === "type" && text.trim().length < 20) return setError("Type the letter (at least 20 characters).");
    setBusy(true);
    try {
      const body: Record<string, unknown> = { userId, title: title.trim(), reason: reason.trim(), issueDate };
      if (mode === "upload" && file) body.file = { data: await readFile(file), fileName: file.name, mimeType: file.type };
      else body.text = text.trim();
      await apiPost("/warning-letters", body);
      onIssued();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not issue the letter.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Issue warning letter"
      subtitle={`To ${name}. They are notified and the letter appears in their profile.`}
      onClose={busy ? () => undefined : onClose}
      width="max-w-xl"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-xl border border-indigo-200 px-4 py-2 text-sm font-medium text-slate-600 hover:border-slate-400 disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "Issuing…" : "Issue letter"}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && <p className="rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</p>}
        <label className="block text-xs text-slate-500">
          Letter name
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. First warning: repeated late arrival" className={`${input} mt-1`} />
        </label>
        <label className="block text-xs text-slate-500">
          Reason
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={3} placeholder="Why is this warning being issued?" className={`${input} mt-1 resize-y`} />
        </label>
        <label className="block text-xs text-slate-500">
          Issue date
          <input type="date" value={issueDate} max={today()} onChange={(e) => setIssueDate(e.target.value)} className={`${input} mt-1`} />
        </label>

        <div>
          <p className="mb-1.5 text-xs text-slate-500">The letter</p>
          <div className="mb-3 inline-flex rounded-xl border border-indigo-100 p-0.5 text-xs font-medium">
            {([["upload", "Upload a file"], ["type", "Type it here"]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setMode(k)} className={`rounded-lg px-3 py-1.5 ${mode === k ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-indigo-50/60"}`}>
                {label}
              </button>
            ))}
          </div>
          {mode === "upload" ? (
            <div>
              <input type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-xl file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-xs file:font-medium file:text-slate-700" />
              <p className="mt-1.5 text-xs text-slate-400">PDF is best. Word or an image also works. 10 MB at most.</p>
            </div>
          ) : (
            <div>
              <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={8000} rows={8} placeholder="Write the letter. The system makes a PDF with the company name, date, employee, reason and your name." className={`${input} resize-y`} />
              <p className="mt-1.5 text-xs text-slate-400">{text.length} / 8,000 characters</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
