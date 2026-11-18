"use client";

// The employee's own "Repetitive task alert" inside Daily Tasks. It says, in plain words, that similar tasks were noticed, shows which entries and why, the
// review status and outcome, and lets the person explain. It is not a finding of misconduct. The employee never sees reviewer comments, who reviewed, or
// whether the case was escalated: the server sends only what an employee may see.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";

type Flag = { id: string; sampleTitle: string; repeatCount: number; firstDate: string; lastDate: string; reason: string; status: string; statusLabel: string; open: boolean; outcome: string; project: string | null };
type List = { ready: boolean; flags: Flag[]; notesReady?: boolean };
type Detail = {
  flag: Flag;
  can: { explain: boolean };
  tasks: { id: string; date: string; title: string; description: string | null }[];
  timeline: { id: string; at: string; kind: string; to?: string | null; note: string | null; by: string }[];
};

const dayLabel = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
const CHIP: Record<string, string> = { NEW: "bg-amber-50 text-amber-700", UNDER_REVIEW: "bg-amber-50 text-amber-700", VALID: "bg-violet-50 text-violet-700", FALSE_POSITIVE: "bg-slate-100 text-slate-600", RESOLVED: "bg-emerald-50 text-emerald-700" };
const WORDS: Record<string, string> = { NEW: "Noticed", UNDER_REVIEW: "Being reviewed", VALID: "Reviewed", FALSE_POSITIVE: "Dismissed", RESOLVED: "Closed" };

export default function EmployeeRepetitionAlert() {
  const [list, setList] = useState<List | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setList(await apiGet<List>("/tasks/repetition/flags?mine=1&status=all")); } catch { setList(null); }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useRealtime(["notifications:changed"], () => { void load(); if (openId) void apiGet<Detail>(`/tasks/repetition/flags/${openId}`).then(setDetail).catch(() => undefined); });

  async function open(id: string) {
    setOpenId(id); setDetail(null); setText(""); setError("");
    try { setDetail(await apiGet<Detail>(`/tasks/repetition/flags/${id}`)); } catch (e) { setError((e as Error).message); }
  }
  async function send() {
    if (!openId || busy) return;
    setBusy(true); setError("");
    try { setDetail(await apiPost<Detail>(`/tasks/repetition/flags/${openId}/explain`, { text })); setText(""); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (!list || !list.ready || list.flags.length === 0) return null;
  const active = list.flags.filter((f) => f.open).length;
  return (
    <section data-testid="employee-repetition-alert" className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4">
      <h2 className="text-sm font-semibold text-amber-900">Repetitive task alert{active > 1 ? "s" : ""}</h2>
      <p className="mt-0.5 text-xs text-amber-900/80">Some of your tasks look very similar. This is a routine check, not a finding of misconduct. You can look at the entries and add an explanation.</p>
      <ul className="mt-3 space-y-2">
        {list.flags.map((f) => (
          <li key={f.id} data-testid="employee-flag" className="rounded-xl bg-white shadow-[var(--shadow-card)]">
            <button type="button" aria-expanded={openId === f.id} onClick={() => (openId === f.id ? setOpenId(null) : void open(f.id))} className="flex w-full flex-wrap items-start justify-between gap-2 px-4 py-3 text-left">
              <span className="min-w-0">
                <span className="block break-words text-sm font-medium text-slate-900 [overflow-wrap:anywhere]">&ldquo;{f.sampleTitle}&rdquo;</span>
                <span className="block text-xs text-slate-500">Similar entries {f.repeatCount} times · {dayLabel(f.firstDate)}{f.firstDate !== f.lastDate ? ` to ${dayLabel(f.lastDate)}` : ""}{f.project ? ` · ${f.project}` : ""}</span>
              </span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CHIP[f.status] ?? ""}`} data-testid="employee-flag-status">{WORDS[f.status] ?? f.statusLabel}</span>
            </button>
            {openId === f.id && (
              <div className="space-y-3 border-t border-amber-100 px-4 py-3">
                {!detail ? <div className="skeleton h-16" aria-busy="true" /> : (
                  <>
                    <p className="text-sm text-slate-700"><span className="font-medium">Why this was noticed:</span> {detail.flag.reason}</p>
                    <ul className="divide-y divide-amber-50 rounded-xl border border-amber-100 text-sm" data-testid="employee-flag-tasks">
                      {detail.tasks.map((t) => (
                        <li key={t.id} className="px-3 py-2"><span className="text-xs text-slate-500">{dayLabel(t.date)}</span><span className="block break-words text-slate-900 [overflow-wrap:anywhere]">{t.title}</span>{t.description && <span className="block break-words text-xs text-slate-600 [overflow-wrap:anywhere]">{t.description}</span>}</li>
                      ))}
                    </ul>
                    <p className="text-sm text-slate-700" data-testid="employee-flag-outcome"><span className="font-medium">Status:</span> {detail.flag.outcome}</p>
                    {detail.timeline.filter((e) => e.kind === "EXPLANATION").length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-slate-500">Your explanations</p>
                        <ul className="mt-1 space-y-1" data-testid="employee-explanations">
                          {detail.timeline.filter((e) => e.kind === "EXPLANATION").map((e) => <li key={e.id} className="break-words text-xs text-slate-700 [overflow-wrap:anywhere]">{new Date(e.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}: {e.note}</li>)}
                        </ul>
                      </div>
                    )}
                    {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
                    {detail.can.explain ? (
                      <div className="space-y-2">
                        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={1000} aria-label="Your explanation" placeholder="Explain or clarify, for example why these entries are different pieces of work" className="w-full resize-y rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 [overflow-wrap:anywhere]" />
                        <button type="button" onClick={() => void send()} disabled={busy || text.trim().length < 3} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Send explanation</button>
                        <p className="text-xs text-slate-500">Your manager and the review team can read your explanation.</p>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500">{f.open ? "Explanations are not available right now." : "This alert is closed."}</p>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
