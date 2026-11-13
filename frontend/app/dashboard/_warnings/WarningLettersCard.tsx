"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { LetterList, type Letter } from "./LetterList";

// My Profile > Warning letter. Same card as Offer letter. Only the signed-in person's own letters come back from the server (the id is taken from the
// sign-in, never sent from here), and the server answers 404 for anyone else's.
export default function WarningLettersCard() {
  const [letters, setLetters] = useState<Letter[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ letters: Letter[] }>("/warning-letters/mine");
      setLetters(res?.letters ?? []);
      setFailed(false);
    } catch {
      setFailed(true); // this card failing must never blank the rest of the profile
      setLetters((cur) => cur ?? []);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const list = letters ?? [];
  const waiting = list.filter((l) => !l.acknowledgedAt).length;

  return (
    <section className="mb-6 overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)] no-print">
      <div className="flex items-center justify-between gap-4 border-b border-indigo-50 px-5 py-3.5">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Warning letter</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            {letters === null ? "Loading…" : list.length === 0 ? "Nothing on file" : `${list.length} issued${waiting ? ` · ${waiting} awaiting your acknowledgment` : ""}`}
          </p>
        </div>
      </div>

      {letters === null ? (
        <div className="space-y-2 p-5" aria-busy="true">
          <div className="skeleton h-10" />
        </div>
      ) : failed && list.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">Could not load your warning letters. Refresh to try again.</p>
      ) : list.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">No warning letters issued.</p>
      ) : (
        <LetterList
          letters={list}
          onAcknowledge={async (id) => {
            const r = await apiPost<{ acknowledgedAt: string }>(`/warning-letters/${id}/acknowledge`);
            setLetters((cur) => (cur ?? []).map((l) => (l.id === id ? { ...l, acknowledgedAt: r.acknowledgedAt } : l)));
          }}
        />
      )}
    </section>
  );
}
