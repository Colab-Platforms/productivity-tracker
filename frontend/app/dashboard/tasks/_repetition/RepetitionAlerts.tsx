"use client";

// "Repetitive task alerts": flags raised when a person submitted the same or very similar work several times. For managers (their own people), HR and Admin
// (the companies they act on). A flag is information for a human: it never changes a rating, salary, attendance or productivity score.
// Lives inside the existing task screens (no sidebar item).
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";
import { formatDateTime } from "@/lib/time";

export type FlagStatus = "NEW" | "UNDER_REVIEW" | "VALID" | "FALSE_POSITIVE" | "RESOLVED";
type Flag = {
  id: string; employee: string; employeeCode: string | null; reportingManager: string | null; project: string | null; sampleTitle: string; repeatCount: number;
  firstDate: string; lastDate: string; similarity: number; reason: string; status: FlagStatus; statusLabel: string; open: boolean; escalated: boolean;
};
type Detail = {
  flag: Flag;
  tasks: { id: string; date: string; title: string; description: string | null; status: string; approvalStatus: string; currentStatus: string | null; currentApproval: string | null }[];
  events: { id: string; at: string; by: string; kind: string; from: string | null; to: string | null; note: string | null }[];
};

const CHIP: Record<FlagStatus, string> = {
  NEW: "bg-rose-50 text-rose-700", UNDER_REVIEW: "bg-amber-50 text-amber-700", VALID: "bg-violet-50 text-violet-700",
  FALSE_POSITIVE: "bg-slate-100 text-slate-600", RESOLVED: "bg-emerald-50 text-emerald-700",
};
const LABEL: Record<FlagStatus, string> = { NEW: "New", UNDER_REVIEW: "Under Review", VALID: "Valid Repetition", FALSE_POSITIVE: "False Positive", RESOLVED: "Resolved" };
const TASK_STATUS: Record<string, string> = { PENDING: "To do", IN_PROGRESS: "In progress", COMPLETED: "Completed", CANCELLED: "Cancelled" };
const APPROVAL: Record<string, string> = { PENDING: "Waiting for approval", APPROVED: "Approved", REJECTED: "Sent back" };
const FILTERS: [string, string][] = [["open", "Open"], ["all", "All"], ["VALID", "Valid Repetition"], ["FALSE_POSITIVE", "False Positive"], ["RESOLVED", "Resolved"]];
const dayLabel = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };

export default function RepetitionAlerts({ canEscalate }: { canEscalate: boolean }) {
  const [state, setState] = useState<{ ready: boolean; flags: Flag[]; counts: { open: number; all: number } } | null>(null);
  const [filter, setFilter] = useState("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"" | "fp" | "escalate">("");
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");

  const load = useCallback(async () => {
    try { setState(await apiGet(`/tasks/repetition/flags?status=${encodeURIComponent(filter)}`)); } catch (e) { setError((e as Error).message); }
  }, [filter]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  // new flags arrive through the same live connection tasks use: the notification signal reloads the list
  useRealtime(["notifications:changed"], () => void load());

  const open = useCallback(async (id: string) => {
    setOpenId(id); setDetail(null); setMode(""); setNote(""); setComment(""); setError("");
    try { setDetail(await apiGet<Detail>(`/tasks/repetition/flags/${id}`)); } catch (e) { setError((e as Error).message); }
  }, []);

  async function act(path: string, body: Record<string, unknown>) {
    if (!openId) return;
    setBusy(true); setError("");
    try {
      setDetail(await apiPost<Detail>(`/tasks/repetition/flags/${openId}/${path}`, body));
      setMode(""); setNote(""); setComment("");
      await load();
    } catch (e) { setError((e as Error).message); await load(); } finally { setBusy(false); }
  }

  if (!state || !state.ready) return null;
  if (state.counts.all === 0) return null; // nothing flagged: the card stays out of the way
  const flags = state.flags;
  return (
    <section data-testid="repetition-alerts" className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
      <button type="button" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} className="flex w-full items-center justify-between gap-3 rounded-t-2xl border-b border-amber-100 bg-amber-50/60 px-5 py-3.5 text-left">
        <span>
          <span className="block text-sm font-semibold text-amber-900">Repetitive task alerts ({state.counts.open} open)</span>
          <span className="mt-0.5 block text-xs text-amber-800">People who submitted the same or very similar work several times. For you to check; a flag never changes anyone&apos;s rating, pay or attendance.</span>
        </span>
        <span aria-hidden="true" className="text-amber-800">{collapsed ? "Show" : "Hide"}</span>
      </button>
      {!collapsed && (
        <div className="p-5">
          <div role="group" aria-label="Filter alerts" className="flex flex-wrap gap-2">
            {FILTERS.map(([k, label]) => (
              <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={"rounded-full px-3 py-1.5 text-xs font-medium " + (filter === k ? "bg-indigo-600 text-white" : "bg-indigo-50 text-indigo-700 hover:bg-indigo-100")}>{label}</button>
            ))}
          </div>
          {error && !openId && <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
          {flags.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">Nothing here.</p>
          ) : (
            <ul className="mt-4 divide-y divide-indigo-50 rounded-xl border border-indigo-100">
              {flags.map((f) => (
                <li key={f.id} data-testid="repetition-flag">
                  <button type="button" onClick={() => (openId === f.id ? setOpenId(null) : void open(f.id))} aria-expanded={openId === f.id} className="flex w-full flex-wrap items-start justify-between gap-2 px-4 py-3 text-left hover:bg-indigo-50/40">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-900">{f.employee}{f.employeeCode ? <span className="font-normal text-slate-500"> · {f.employeeCode}</span> : null}</span>
                      <span className="mt-0.5 block break-words text-sm text-slate-700 [overflow-wrap:anywhere]">&ldquo;{f.sampleTitle}&rdquo;</span>
                      <span className="mt-0.5 block text-xs text-slate-500">Repeated {f.repeatCount} times · {dayLabel(f.firstDate)}{f.firstDate !== f.lastDate ? ` to ${dayLabel(f.lastDate)}` : ""}{f.project ? ` · ${f.project}` : ""} · {f.similarity}% alike</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {f.escalated && <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">Escalated to HR</span>}
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CHIP[f.status]}`}>{LABEL[f.status]}</span>
                    </span>
                  </button>
                  {openId === f.id && (
                    <div className="border-t border-indigo-50 bg-slate-50/50 px-4 py-4">
                      {!detail ? <div className="skeleton h-20" aria-busy="true" /> : (
                        <div className="space-y-4">
                          <p className="text-sm text-slate-700"><span className="font-medium">Why it was flagged:</span> {detail.flag.reason}</p>
                          {detail.flag.reportingManager && <p className="text-xs text-slate-500">Reporting manager: {detail.flag.reportingManager}</p>}
                          <div className="overflow-x-auto rounded-xl border border-indigo-100 bg-white">
                            <table className="min-w-full text-sm" data-testid="repetition-tasks">
                              <thead className="bg-indigo-50/50 text-left text-xs text-slate-500"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Task</th><th className="px-3 py-2">Details</th><th className="px-3 py-2">Status</th></tr></thead>
                              <tbody className="divide-y divide-indigo-50">
                                {detail.tasks.map((t) => (
                                  <tr key={t.id}>
                                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">{dayLabel(t.date)}</td>
                                    <td className="break-words px-3 py-2 text-slate-900 [overflow-wrap:anywhere]">{t.title}</td>
                                    <td className="break-words px-3 py-2 text-slate-600 [overflow-wrap:anywhere]">{t.description || <span className="text-slate-400">none</span>}</td>
                                    <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-600">{TASK_STATUS[t.currentStatus ?? t.status] ?? t.status} · {APPROVAL[t.currentApproval ?? t.approvalStatus] ?? t.approvalStatus}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div>
                            <p className="text-xs font-medium text-slate-500">History</p>
                            <ol className="mt-1 space-y-1.5" data-testid="repetition-history">
                              {detail.events.map((e) => (
                                <li key={e.id} className="break-words text-xs text-slate-600 [overflow-wrap:anywhere]">
                                  <span className="font-medium text-slate-800">{e.by}</span> · {formatDateTime(e.at, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} ·{" "}
                                  {e.kind === "STATUS" ? `set to ${LABEL[e.to as FlagStatus] ?? e.to}` : e.kind === "COMMENT" ? "commented" : e.kind === "ESCALATED" ? "escalated to HR" : e.kind === "UPDATED" ? "updated" : "flag raised"}
                                  {e.note ? `: ${e.note}` : ""}
                                </li>
                              ))}
                            </ol>
                          </div>
                          {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
                          {mode ? (
                            <div className="space-y-2">
                              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} aria-label={mode === "fp" ? "Why is this a false positive?" : "Note for HR (optional)"} placeholder={mode === "fp" ? "Why is this a false positive? (required)" : "Note for HR (optional)"} className="w-full resize-y rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 [overflow-wrap:anywhere]" />
                              <div className="flex gap-2">
                                {mode === "fp" ? (
                                  <button type="button" disabled={busy || note.trim().length < 3} onClick={() => void act("status", { status: "FALSE_POSITIVE", note })} className="rounded-xl bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-40">Dismiss as false positive</button>
                                ) : (
                                  <button type="button" disabled={busy} onClick={() => void act("escalate", { note })} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Escalate to HR</button>
                                )}
                                <button type="button" onClick={() => { setMode(""); setNote(""); }} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-indigo-50">Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {detail.flag.status !== "UNDER_REVIEW" && <button type="button" disabled={busy} onClick={() => void act("status", { status: "UNDER_REVIEW" })} className="rounded-xl border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-40">{detail.flag.status === "NEW" ? "Mark as reviewed (under review)" : "Reopen for review"}</button>}
                              {(detail.flag.status === "NEW" || detail.flag.status === "UNDER_REVIEW") && <button type="button" disabled={busy} onClick={() => void act("status", { status: "VALID" })} className="rounded-xl border border-violet-200 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-40">Valid repetition</button>}
                              {(detail.flag.status === "NEW" || detail.flag.status === "UNDER_REVIEW") && <button type="button" disabled={busy} onClick={() => setMode("fp")} className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40">False positive…</button>}
                              {detail.flag.status !== "RESOLVED" && detail.flag.status !== "FALSE_POSITIVE" && <button type="button" disabled={busy} onClick={() => void act("status", { status: "RESOLVED" })} className="rounded-xl border border-emerald-200 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">Resolved</button>}
                              {canEscalate && !detail.flag.escalated && detail.flag.status !== "RESOLVED" && detail.flag.status !== "FALSE_POSITIVE" && <button type="button" disabled={busy} onClick={() => setMode("escalate")} className="rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-40">Escalate to HR…</button>}
                            </div>
                          )}
                          <div className="flex gap-2">
                            <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} aria-label="Add a comment" placeholder="Add a comment" className="min-w-0 flex-1 rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500" />
                            <button type="button" disabled={busy || !comment.trim()} onClick={() => void act("comment", { text: comment })} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Comment</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
