"use client";

// The manager's "End Huddle": asks once in a dialog, then ends the Team Huddle for EVERYONE (server: POST /meetings/:id/end, organizer only).
// Everyone still in it is stopped at the same server moment; their screens update live and each gets "The Manager has ended the Team Huddle."
import { useState } from "react";
import { apiPost } from "@/lib/api";
import { Modal } from "../../_employees/Modal";

export default function EndHuddle({ id, title, huddle = true, onDone, className }: { id: string; title?: string; huddle?: boolean; onDone: () => void; className?: string }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const noun = huddle ? "Team Huddle" : "meeting";
  async function end() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await apiPost(`/meetings/${id}/end`);
      setAsking(false);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" onClick={() => { setErr(""); setAsking(true); }} data-testid="end-huddle" className={className ?? "rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50"}>
        {huddle ? "End Huddle" : "End meeting"}
      </button>
      {asking && (
        <Modal
          title={huddle ? "End Team Huddle?" : "End meeting?"}
          subtitle={title}
          onClose={() => !busy && setAsking(false)}
          width="max-w-md"
          footer={
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setAsking(false)} disabled={busy} data-testid="end-huddle-cancel" className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-indigo-50">Cancel</button>
              <button type="button" onClick={end} disabled={busy} data-testid="end-huddle-confirm" className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50">{busy ? "Ending…" : `End ${noun}`}</button>
            </div>
          }
        >
          <p className="text-sm text-slate-700" data-testid="end-huddle-text">Are you sure you want to end this {noun} for all participants?</p>
          <p className="mt-2 text-xs text-slate-500">Everyone still in it is removed at the same moment, their participation time stops now, and they are told the Manager has ended it. This cannot be undone.</p>
          {err && <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</p>}
        </Modal>
      )}
    </>
  );
}
