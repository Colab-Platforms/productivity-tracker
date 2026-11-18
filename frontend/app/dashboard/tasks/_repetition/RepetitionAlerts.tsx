"use client";

// "Repetitive task alerts" for reviewers: the reporting manager (their own people), HR (their companies) and Admin (the companies they act on).
// Shown inside Tasks & Performance. A flag is information for a human, never a finding of misconduct: it changes no rating, pay, attendance or productivity.
// Every note carries a label saying who can read it; the employee never sees reviewer notes. The server decides what each role may see and do: the buttons
// shown here come from the server's `can` answer for this flag and this person.
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";
import { formatDateTime } from "@/lib/time";

export type FlagStatus = "NEW" | "UNDER_REVIEW" | "VALID" | "FALSE_POSITIVE" | "RESOLVED";
type Mode = "EMPLOYEE" | "MANAGER" | "HR" | "ADMIN";
type Flag = {
  id: string; employee: string; employeeCode: string | null; reportingManager: string | null; project: string | null; sampleTitle: string; repeatCount: number;
  firstDate: string; lastDate: string; similarity: number; reason: string; status: FlagStatus; statusLabel: string; open: boolean; escalated: boolean; escalatedToAdmin: boolean;
};
type Item = { id: string; at: string; by: string; kind: string; from?: string | null; to?: string | null; note: string | null; visibility?: "EMPLOYEE" | "STAFF" | "HR_ADMIN" };
type Detail = {
  flag: Flag; mode: Mode;
  can: { status: boolean; comment: boolean; escalateHr: boolean; escalateAdmin: boolean; explain: boolean };
  tasks: { id: string; date: string; title: string; description: string | null; status: string; approvalStatus: string; currentStatus: string | null; currentApproval: string | null }[];
  timeline: Item[];
};
type List = { ready: boolean; flags: Flag[]; counts: { open: number; all: number; escalatedAdmin: number }; mode: Mode };

const CHIP: Record<FlagStatus, string> = {
  NEW: "bg-rose-50 text-rose-700", UNDER_REVIEW: "bg-amber-50 text-amber-700", VALID: "bg-violet-50 text-violet-700",
  FALSE_POSITIVE: "bg-slate-100 text-slate-600", RESOLVED: "bg-emerald-50 text-emerald-700",
};
const LABEL: Record<FlagStatus, string> = { NEW: "New", UNDER_REVIEW: "Under Review", VALID: "Valid Repetition", FALSE_POSITIVE: "False Positive", RESOLVED: "Resolved" };
const TASK_STATUS: Record<string, string> = { PENDING: "To do", IN_PROGRESS: "In progress", COMPLETED: "Completed", CANCELLED: "Cancelled" };
const APPROVAL: Record<string, string> = { PENDING: "Waiting for approval", APPROVED: "Approved", REJECTED: "Sent back" };
const KIND: Record<string, string> = {
  DETECTED: "Flag raised", UPDATED: "Updated", STATUS: "Status changed", COMMENT: "Comment", ESCALATED: "Escalated to HR", MANAGER_COMMENT: "Manager comment",
  HR_OBSERVATION: "HR observation", ADMIN_NOTE: "Admin note", ESCALATION_ADMIN: "Escalated to Admin", EXPLANATION: "Employee explanation",
};
const WHO: Record<string, string> = { EMPLOYEE: "Everyone on this case", STAFF: "Managers, HR and Admin", HR_ADMIN: "HR and Admin only" };
const dayLabel = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
const COMMENT_LABEL: Record<string, string> = {
  MANAGER: "Comment (managers, HR and Admin can read it; the employee cannot)",
  HR: "HR observation (HR and Admin only)",
  ADMIN: "Admin note (HR and Admin only)",
};

export default function RepetitionAlerts() {
  const [state, setState] = useState<List | null>(null);
  const [filter, setFilter] = useState("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"" | "fp" | "escalate" | "admin">("");
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");

  const load = useCallback(async () => {
    try { setState(await apiGet<List>(`/tasks/repetition/flags?status=${encodeURIComponent(filter)}`)); } catch (e) { setError((e as Error).message); }
  }, [filter]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
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
  const reviewerMode = state.mode;
  const filters: [string, string][] = [["open", "Open"], ["all", "All"], ...(reviewerMode === "HR" || reviewerMode === "ADMIN" ? ([["escalatedAdmin", `Escalated to Admin (${state.counts.escalatedAdmin})`]] as [string, string][]) : []), ["VALID", "Valid Repetition"], ["FALSE_POSITIVE", "False Positive"], ["RESOLVED", "Resolved"]];
  const flags = state.flags;
  return (
    <section data-testid="repetition-alerts" className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
      <button type="button" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} className="flex w-full items-center justify-between gap-3 rounded-t-2xl border-b border-amber-100 bg-amber-50/60 px-5 py-3.5 text-left">
        <span>
          <span className="block text-sm font-semibold text-amber-900">Repetitive task alerts ({state.counts.open} open)</span>
          <span className="mt-0.5 block text-xs text-amber-800">People who submitted the same or very similar work several times. For you to check; a flag is not a finding of misconduct and never changes anyone&apos;s rating, pay or attendance.</span>
        </span>
        <span aria-hidden="true" className="text-amber-800">{collapsed ? "Show" : "Hide"}</span>
      </button>
      {!collapsed && (
        <div className="p-5">
          <div role="group" aria-label="Filter alerts" className="flex flex-wrap gap-2">
            {filters.map(([k, label]) => (
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
                      {f.escalatedToAdmin && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">Escalated to Admin</span>}
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
                            <p className="text-xs font-medium text-slate-500">History, explanations and notes</p>
                            <ol className="mt-1 space-y-2" data-testid="repetition-history">
                              {detail.timeline.map((e) => (
                                <li key={e.id} data-kind={e.kind} className="break-words text-xs text-slate-600 [overflow-wrap:anywhere]">
                                  <span className="font-medium text-slate-800">{e.by}</span> · {formatDateTime(e.at, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · <span className="font-medium">{KIND[e.kind] ?? e.kind}</span>
                                  {e.kind === "STATUS" && e.to ? ` → ${LABEL[e.to as FlagStatus] ?? e.to}` : ""}
                                  {e.note ? `: ${e.note}` : ""}
                                  {e.visibility && <span className="ml-1.5 rounded-full bg-slate-200/70 px-1.5 py-0.5 text-[10px] text-slate-600">{WHO[e.visibility]}</span>}
                                </li>
                              ))}
                            </ol>
                          </div>
                          {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p>}
                          {mode ? (
                            <div className="space-y-2">
                              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} aria-label={mode === "fp" ? "Why is this a false positive?" : mode === "admin" ? "Reason for escalating to Admin" : "Note for HR (optional)"} placeholder={mode === "fp" ? "Why is this a false positive? (required)" : mode === "admin" ? "Why does this need Admin's attention? (required)" : "Note for HR (optional)"} className="w-full resize-y rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 [overflow-wrap:anywhere]" />
                              {mode === "admin" && <p className="text-xs text-slate-500">Escalating asks Admin for a closer look. It does not say the employee did anything wrong and changes nothing about them.</p>}
                              <div className="flex gap-2">
                                {mode === "fp" ? (
                                  <button type="button" disabled={busy || note.trim().length < 3} onClick={() => void act("status", { status: "FALSE_POSITIVE", note })} className="rounded-xl bg-slate-700 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-40">Dismiss as false positive</button>
                                ) : mode === "admin" ? (
                                  <button type="button" disabled={busy || note.trim().length < 3} onClick={() => void act("escalate-admin", { reason: note })} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-40">Escalate to Admin</button>
                                ) : (
                                  <button type="button" disabled={busy} onClick={() => void act("escalate", { note })} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Escalate to HR</button>
                                )}
                                <button type="button" onClick={() => { setMode(""); setNote(""); }} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-indigo-50">Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {detail.can.status && detail.flag.status !== "UNDER_REVIEW" && <button type="button" disabled={busy} onClick={() => void act("status", { status: "UNDER_REVIEW" })} className="rounded-xl border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-40">{detail.flag.status === "NEW" ? "Mark as reviewed (under review)" : "Reopen for review"}</button>}
                              {detail.can.status && (detail.flag.status === "NEW" || detail.flag.status === "UNDER_REVIEW") && <button type="button" disabled={busy} onClick={() => void act("status", { status: "VALID" })} className="rounded-xl border border-violet-200 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-40">Valid repetition</button>}
                              {detail.can.status && (detail.flag.status === "NEW" || detail.flag.status === "UNDER_REVIEW") && <button type="button" disabled={busy} onClick={() => setMode("fp")} className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40">False positive…</button>}
                              {detail.can.status && detail.flag.status !== "RESOLVED" && detail.flag.status !== "FALSE_POSITIVE" && <button type="button" disabled={busy} onClick={() => void act("status", { status: "RESOLVED" })} className="rounded-xl border border-emerald-200 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">{detail.mode === "ADMIN" ? "Resolve / close case" : "Resolved"}</button>}
                              {detail.can.escalateHr && <button type="button" disabled={busy} onClick={() => setMode("escalate")} className="rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-40">Escalate to HR…</button>}
                              {detail.can.escalateAdmin && <button type="button" disabled={busy} onClick={() => setMode("admin")} className="rounded-xl border border-violet-200 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-40">Escalate to Admin…</button>}
                            </div>
                          )}
                          {detail.can.comment && (
                            <div className="space-y-1">
                              <label className="block text-xs text-slate-500" htmlFor={`c-${f.id}`}>{COMMENT_LABEL[detail.mode] ?? "Comment"}</label>
                              <div className="flex gap-2">
                                <input id={`c-${f.id}`} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} aria-label="Add a comment" placeholder={detail.mode === "MANAGER" ? "Add a comment" : detail.mode === "HR" ? "Add an HR observation" : "Add an Admin note"} className="min-w-0 flex-1 rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500" />
                                <button type="button" disabled={busy || !comment.trim()} onClick={() => void act("comment", { text: comment })} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Add</button>
                              </div>
                            </div>
                          )}
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
