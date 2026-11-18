"use client";

// QUERY DESK, DEPARTMENT REQUESTS tab.
// Employee raises a query and tags a department -> the reporting manager approves -> the Admin gives the final approval -> only then the tagged
// department sees it and does the work -> the employee confirms it is resolved or reopens it.
// The server decides who sees and does what (and enforces every rule); this screen only shows what comes back.
import { useEffect, useMemo, useState } from "react";
import { API_BASE, apiGet, apiPost, getToken } from "@/lib/api";
import { Modal } from "../../_employees/Modal";
import { useMe } from "../../layout";
import { DeptRaiseModal } from "./RaiseForm";

type Item = {
  id: string; reference: string; title: string; priority: string; priorityLabel: string; approvalStatus: string; approvalLabel: string;
  workStatus: string | null; workLabel: string | null; stage: string; department: string; departmentId: string;
  raisedBy: { id: string; name: string; employeeCode: string | null }; assignedTo: string | null; createdAt: string; isMine: boolean; needsYou: boolean;
};
type List = { ready: boolean; view?: string; total: number; counts: Record<string, number>; items: Item[]; isDeptMember?: boolean };
type Dept = { id: string; name: string };
type Ev = { id: string; kind: string; by: string | null; byRole: string | null; from: string | null; to: string | null; note: string | null; visibility: string; at: string; attachment: { name: string } | null };
type Detail = {
  id: string; reference: string; title: string; description: string; priority: string; priorityLabel: string; approvalStatus: string; approvalLabel: string;
  workStatus: string | null; workLabel: string | null; stage: string; department: string; raisedBy: { id: string; name: string; employeeCode: string | null };
  responsible: string[]; manager: string | null; admins: string[]; assignedTo: { id: string; name: string } | null; createdAt: string;
  managerDecidedAt: string | null; adminDecidedAt: string | null; startedAt: string | null; completedAt: string | null; confirmedAt: string | null; reopenCount: number;
  timeline: Ev[]; commentModes: string[]; reassignOptions: { id: string; name: string }[];
  permissions: { canManagerDecide: boolean; canAdminDecide: boolean; canAccept: boolean; canUpdateProgress: boolean; canReassign: boolean; canConfirm: boolean; canReopen: boolean; canComment: boolean; isOversight: boolean; allowedProgress: string[] };
};

const APPROVAL_CHIP: Record<string, string> = { PENDING_MANAGER: "bg-amber-50 text-amber-700", PENDING_ADMIN: "bg-violet-50 text-violet-700", APPROVED: "bg-emerald-50 text-emerald-700", REJECTED: "bg-red-50 text-red-600" };
const WORK_CHIP: Record<string, string> = { AWAITING_ACTION: "bg-amber-50 text-amber-700", NOT_STARTED: "bg-slate-100 text-slate-600", IN_PROGRESS: "bg-sky-50 text-sky-700", ON_HOLD: "bg-orange-50 text-orange-700", COMPLETED: "bg-emerald-50 text-emerald-700", REOPENED: "bg-rose-50 text-rose-700" };
const PRIORITY_CHIP: Record<string, string> = { LOW: "bg-slate-100 text-slate-600", MEDIUM: "bg-sky-50 text-sky-700", HIGH: "bg-orange-50 text-orange-700", URGENT: "bg-red-50 text-red-600" };
const WORK_LABEL: Record<string, string> = { NOT_STARTED: "Not Started", IN_PROGRESS: "In Progress", ON_HOLD: "On Hold", COMPLETED: "Completed" };
const VIEW_LABEL: Record<string, string> = {
  ALL: "All", MINE: "Raised by me", APPROVE: "Waiting for my decision", DEPT_AWAITING: "Awaiting department action", DEPT_ASSIGNED: "Assigned to me",
  DEPT_PROGRESS: "In progress", DEPT_HOLD: "On hold", DEPT_DONE: "Completed",
};
const EVENT_TEXT: Record<string, string> = {
  CREATED: "Raised", MANAGER_APPROVED: "Reporting manager approved", MANAGER_REJECTED: "Reporting manager rejected", ADMIN_APPROVED: "Admin approved (final)", ADMIN_REJECTED: "Admin rejected",
  ACCEPTED: "Department accepted the request", PROGRESS: "Progress updated", COMMENT: "Comment", ASSIGNED: "Reassigned", CONFIRMED: "Employee confirmed it is resolved", REOPENED: "Employee reopened it",
};

const when = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(s));
const dayOnly = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(s));
const readFile = (file: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error("Could not read that file")); r.readAsDataURL(file); });
async function openFile(path: string) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error("Could not open the file");
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
const input = "w-full rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800";
const Pill = ({ cls, children }: { cls: string; children: React.ReactNode }) => <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;

function useApi<T>(path: string | null, reload: number) {
  const [res, setRes] = useState<{ path: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    apiGet<T>(path).then((data) => live && setRes({ path, data })).catch((e: Error) => live && setRes((prev) => ({ path, data: prev?.data, error: e.message })));
    return () => { live = false; };
  }, [path, reload]);
  return { data: res?.data ?? null, error: res && res.path === path ? (res.error ?? "") : "" };
}

export default function DeptRequests({ openId: linkedId, tabs }: { openId: string | null; tabs: React.ReactNode }) {
  const me = useMe();
  const isAdmin = me?.role === "ADMIN";
  const [reload, setReload] = useState(0);
  const [view, setView] = useState("ALL");
  const [approval, setApproval] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [priority, setPriority] = useState("");
  const [q, setQ] = useState("");
  const [qApplied, setQApplied] = useState("");
  const [raising, setRaising] = useState(false);
  const [managing, setManaging] = useState(false);
  const [notice, setNotice] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [closedLink, setClosedLink] = useState<string | null>(null);
  const openId = chosen ?? (linkedId && linkedId !== closedLink ? linkedId : null);

  useEffect(() => { const t = setTimeout(() => setQApplied(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const qs = new URLSearchParams();
  qs.set("view", view);
  if (approval) qs.set("approval", approval);
  if (departmentId) qs.set("departmentId", departmentId);
  if (priority) qs.set("priority", priority);
  if (qApplied) qs.set("q", qApplied);
  const list = useApi<List>(`/queries/dept?${qs.toString()}`, reload);
  const depts = useApi<{ ready: boolean; departments: Dept[] }>("/queries/dept/departments", reload);
  const d = list.data;
  const filtersOn = !!(approval || departmentId || priority || q.trim());
  const views = useMemo(() => {
    const c = d?.counts ?? {};
    const show = (v: string) => v === "ALL" || v === "MINE" || (c[v] ?? 0) > 0 || (v === "APPROVE" && (me?.role === "MANAGER" || me?.role === "ADMIN")) || (v.startsWith("DEPT_") && d?.isDeptMember);
    return Object.keys(VIEW_LABEL).filter(show).map((v) => ({ key: v, label: VIEW_LABEL[v], n: c[v] ?? 0 }));
  }, [d, me?.role]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Query Desk</h1>
          <p className="mt-1 text-sm text-slate-500">Ask a department to do something. Your manager and an Admin approve it first, then the department works on it and you confirm the result.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isAdmin && <button onClick={() => setManaging(true)} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50">Manage departments</button>}
          {me?.role !== "ADMIN" && <button onClick={() => setRaising(true)} className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">New department request</button>}
        </div>
      </header>
      {tabs}

      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700" role="status">{notice}</p>}
      {list.error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{list.error}</p>}
      {d && !d.ready && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Department requests are not switched on yet on this server. Ask an administrator to finish the database update.</p>}

      <section className="space-y-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] sm:p-5">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Work queue">
          {views.map((v) => (
            <button key={v.key} onClick={() => setView(v.key)} aria-pressed={view === v.key} className={`rounded-full px-3 py-1 text-xs font-medium ${view === v.key ? "bg-indigo-600 text-white" : "bg-[#F3F7F6] text-slate-600 hover:bg-indigo-50"}`}>
              {v.label}{v.n > 0 && v.key !== "ALL" ? ` (${v.n})` : ""}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-500">Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, reference or name" className={`mt-1 block w-52 ${input}`} /></label>
          <label className="text-xs text-slate-500">Department
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={`mt-1 block ${input}`}>
              <option value="">All departments</option>
              {(depts.data?.departments ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500">Approval
            <select value={approval} onChange={(e) => setApproval(e.target.value)} className={`mt-1 block ${input}`}>
              <option value="">Any approval status</option>
              <option value="PENDING_MANAGER">Pending Manager Approval</option>
              <option value="PENDING_ADMIN">Pending Admin Approval</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </label>
          <label className="text-xs text-slate-500">Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value)} className={`mt-1 block ${input}`}>
              <option value="">Any priority</option>
              <option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="URGENT">Urgent</option>
            </select>
          </label>
          {filtersOn && <button onClick={() => { setApproval(""); setDepartmentId(""); setPriority(""); setQ(""); setQApplied(""); }} className="rounded-xl px-3 py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50">Clear filters</button>}
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        {!d && !list.error && <div className="space-y-2 p-5" aria-busy="true"><div className="skeleton h-14" /><div className="skeleton h-14" /><div className="skeleton h-14" /></div>}
        {d && d.ready && d.items.length === 0 && <p className="px-6 py-14 text-center text-sm text-slate-500">{filtersOn || view !== "ALL" ? "Nothing matches this view." : "No department requests yet."}</p>}
        <ul className="divide-y divide-indigo-50">
          {d?.items.map((i) => (
            <li key={i.id}>
              <button onClick={() => setChosen(i.id)} className="flex w-full flex-wrap items-start justify-between gap-3 px-4 py-4 text-left hover:bg-indigo-50/40 sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="rounded-full bg-[#F3F7F6] px-2 py-0.5 font-medium text-slate-600">{i.department}</span>
                    <span className="tabular-nums">{i.reference}</span>
                    <Pill cls={PRIORITY_CHIP[i.priority] ?? ""}>{i.priorityLabel}</Pill>
                    {i.needsYou && <span className="rounded-full bg-rose-500 px-2 py-0.5 font-medium text-white">Needs you</span>}
                  </p>
                  <p className="mt-1 truncate text-sm font-medium text-slate-900">{i.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{i.isMine ? "" : `${i.raisedBy.name}${i.raisedBy.employeeCode ? ` (${i.raisedBy.employeeCode})` : ""} · `}{dayOnly(i.createdAt)}{i.assignedTo ? ` · handled by ${i.assignedTo}` : ""} · {i.stage}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Pill cls={APPROVAL_CHIP[i.approvalStatus] ?? ""}>{i.approvalLabel}</Pill>
                  {i.workLabel && <Pill cls={WORK_CHIP[i.workStatus ?? ""] ?? ""}>{i.workLabel}</Pill>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {raising && <DeptRaiseModal departments={depts.data?.departments ?? []} onClose={() => setRaising(false)} onDone={(ref, stage) => { setRaising(false); setNotice(`Sent as ${ref}. ${stage === "PENDING_MANAGER" ? "Your reporting manager decides first." : "It goes to an Admin for approval."}`); setReload((n) => n + 1); }} />}
      {managing && <ManageDepartments onClose={() => { setManaging(false); setReload((n) => n + 1); }} />}
      {openId && <DetailModal id={openId} onClose={() => { setChosen(null); if (!chosen) setClosedLink(linkedId); }} onChanged={() => setReload((n) => n + 1)} />}
    </div>
  );
}

// ===========================================================================
function Steps({ d }: { d: Detail }) {
  const rejected = d.approvalStatus === "REJECTED";
  const mgrDone = !!d.managerDecidedAt;
  const adminDone = !!d.adminDecidedAt;
  const approved = d.approvalStatus === "APPROVED";
  type S = { label: string; state: "done" | "current" | "todo" | "skipped" | "rejected"; sub?: string };
  const steps: S[] = [
    { label: "Raised", state: "done", sub: when(d.createdAt) },
    d.manager === null && d.approvalStatus !== "PENDING_MANAGER" && !mgrDone
      ? { label: "Reporting manager", state: "skipped", sub: "No manager step" }
      : { label: "Reporting manager", state: d.approvalStatus === "PENDING_MANAGER" ? "current" : rejected && !adminDone && !d.managerDecidedAt ? "todo" : rejected && mgrDone && !adminDone ? "rejected" : "done", sub: d.manager ?? undefined },
    { label: "Admin", state: d.approvalStatus === "PENDING_ADMIN" ? "current" : rejected && adminDone ? "rejected" : approved ? "done" : "todo", sub: d.admins.join(", ") || undefined },
    { label: "Department work", state: approved ? (d.workStatus === "COMPLETED" ? "done" : "current") : "todo", sub: d.workLabel ?? undefined },
    { label: "Employee confirms", state: d.confirmedAt ? "done" : d.workStatus === "COMPLETED" ? "current" : "todo" },
  ];
  const dot = (s: S["state"]) => s === "done" ? "bg-emerald-500" : s === "current" ? "bg-indigo-600" : s === "rejected" ? "bg-red-500" : s === "skipped" ? "bg-slate-300" : "bg-slate-200";
  return (
    <ol className="grid gap-2 sm:grid-cols-5" aria-label="Approval timeline">
      {steps.map((s) => (
        <li key={s.label} className="rounded-xl bg-[#F3F7F6] p-3">
          <p className="flex items-center gap-2 text-xs font-medium text-slate-700"><span className={`h-2.5 w-2.5 rounded-full ${dot(s.state)}`} />{s.label}</p>
          <p className="mt-1 text-xs text-slate-500">{s.state === "rejected" ? "Rejected" : s.sub ?? (s.state === "todo" ? "Waiting" : "")}</p>
        </li>
      ))}
    </ol>
  );
}

function DetailModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [reload, setReload] = useState(0);
  const { data: d, error } = useApi<Detail>(`/queries/dept/${id}`, reload);
  const [note, setNote] = useState("");
  const [progress, setProgress] = useState("");
  const [progressNote, setProgressNote] = useState("");
  const [assignee, setAssignee] = useState("");
  const [comment, setComment] = useState("");
  const [mode, setMode] = useState("ALL");
  const [file, setFile] = useState<File | null>(null);
  const [reopening, setReopening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    if (busy) return;
    setBusy(true); setErr("");
    try { await fn(); after?.(); setReload((n) => n + 1); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const p = d?.permissions;
  const base = `/queries/dept/${id}`;

  return (
    <Modal title={d ? d.title : "Department request"} subtitle={d ? `${d.reference} · ${d.department}` : undefined} onClose={onClose} width="max-w-3xl">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {d && p && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Pill cls={APPROVAL_CHIP[d.approvalStatus] ?? ""}>{d.approvalLabel}</Pill>
            {d.workLabel && <Pill cls={WORK_CHIP[d.workStatus ?? ""] ?? ""}>{d.workLabel}</Pill>}
            <Pill cls={PRIORITY_CHIP[d.priority] ?? ""}>{d.priorityLabel} priority</Pill>
            <span className="text-xs text-slate-500">Raised by {d.raisedBy.name}{d.raisedBy.employeeCode ? ` (${d.raisedBy.employeeCode})` : ""} · {when(d.createdAt)}</span>
          </div>
          <p className="rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-900" data-testid="stage-line"><b>{d.stage}</b>{d.responsible.length > 0 ? ` · responsible: ${d.responsible.join(", ")}` : ""}{d.reopenCount > 0 ? ` · reopened ${d.reopenCount}×` : ""}</p>
          <Steps d={d} />

          <div className="rounded-2xl bg-[#F3F7F6] p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">What was asked</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">{d.description}</p>
          </div>

          {(p.canManagerDecide || p.canAdminDecide) && (
            <div className="space-y-2 rounded-2xl border border-indigo-100 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{p.canManagerDecide ? "Your approval (reporting manager)" : "Final approval (Admin)"}</p>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} placeholder="Comment (needed if you reject; the employee sees a rejection reason, approval comments stay between approvers)" className={input} />
              <div className="flex flex-wrap gap-2">
                <button disabled={busy} onClick={() => act(() => apiPost(`${base}/${p.canManagerDecide ? "manager-decision" : "admin-decision"}`, { approve: true, note }), () => setNote(""))} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Approve</button>
                <button disabled={busy || note.trim().length < 3} onClick={() => act(() => apiPost(`${base}/${p.canManagerDecide ? "manager-decision" : "admin-decision"}`, { approve: false, note }), () => setNote(""))} className="rounded-xl border border-red-200 px-5 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">Reject</button>
              </div>
            </div>
          )}

          {(p.canAccept || p.canUpdateProgress || p.canReassign) && (
            <div className="space-y-4 rounded-2xl border border-indigo-100 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Department work{d.assignedTo ? ` · handled by ${d.assignedTo.name}` : ""}</p>
              {p.canAccept && <button disabled={busy} onClick={() => act(() => apiPost(`${base}/accept`, {}))} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Accept and take this request</button>}
              {p.canUpdateProgress && (
                <div className="flex flex-wrap gap-2">
                  <select aria-label="New progress" value={progress} onChange={(e) => setProgress(e.target.value)} className={`${input} max-w-[13rem]`}>
                    <option value="">Update progress…</option>
                    {p.allowedProgress.map((s) => <option key={s} value={s}>{WORK_LABEL[s]}</option>)}
                  </select>
                  <input value={progressNote} onChange={(e) => setProgressNote(e.target.value)} maxLength={2000} placeholder={progress === "ON_HOLD" || progress === "COMPLETED" ? "What happened (required)" : "Work update (optional)"} className={`${input} min-w-[14rem] flex-1`} />
                  <button disabled={busy || !progress} onClick={() => act(() => apiPost(`${base}/progress`, { status: progress, note: progressNote }), () => { setProgress(""); setProgressNote(""); })} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Update</button>
                </div>
              )}
              {p.canReassign && d.reassignOptions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  <select aria-label="Reassign to" value={assignee} onChange={(e) => setAssignee(e.target.value)} className={`${input} max-w-[16rem]`}>
                    <option value="">Hand over to…</option>
                    {d.reassignOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <button disabled={busy || !assignee} onClick={() => act(() => apiPost(`${base}/reassign`, { assigneeId: assignee }), () => setAssignee(""))} className="rounded-xl border border-indigo-200 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">Reassign</button>
                </div>
              )}
            </div>
          )}

          {(p.canConfirm || p.canReopen) && (
            <div className="space-y-2 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4">
              <p className="text-sm font-medium text-emerald-900">The department marked this completed. Is it resolved?</p>
              {!reopening ? (
                <div className="flex flex-wrap gap-2">
                  <button disabled={busy} onClick={() => act(() => apiPost(`${base}/confirm`, {}))} className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">Confirm resolved</button>
                  <button disabled={busy} onClick={() => setReopening(true)} className="rounded-xl border border-red-200 px-5 py-2 text-sm font-medium text-red-600 hover:bg-red-50">Reopen</button>
                </div>
              ) : (
                <div className="space-y-2">
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} placeholder="Why is it not resolved? (required)" className={input} />
                  <div className="flex gap-2">
                    <button disabled={busy || note.trim().length < 3} onClick={() => act(() => apiPost(`${base}/reopen`, { note }), () => { setNote(""); setReopening(false); })} className="rounded-xl bg-red-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">Reopen with this reason</button>
                    <button onClick={() => setReopening(false)} className="rounded-xl px-3 py-2 text-sm text-slate-500">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600" role="alert">{err}</p>}

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">History and updates</p>
            <ol className="mt-2 space-y-2 border-l-2 border-indigo-100 pl-4" data-testid="history">
              {d.timeline.map((e) => (
                <li key={e.id} className="text-sm text-slate-700">
                  <span className="font-medium">{EVENT_TEXT[e.kind] ?? e.kind}</span>
                  {e.kind === "PROGRESS" && e.to ? `: ${WORK_LABEL[e.to] ?? e.to}` : ""}
                  {e.by ? ` · ${e.by}` : ""}
                  <span className="text-xs text-slate-400"> · {when(e.at)}</span>
                  {e.visibility !== "ALL" && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">{e.visibility === "APPROVERS" ? "Approvers only" : "Department only"}</span>}
                  {e.note && <p className="mt-0.5 whitespace-pre-wrap break-words text-slate-600">“{e.note}”</p>}
                  {e.attachment && <button onClick={() => openFile(`/queries/dept/${d.id}/events/${e.id}/attachment`).catch((x: Error) => setErr(x.message))} className="mt-1 rounded-lg border border-indigo-100 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50">Open attachment: {e.attachment.name}</button>}
                </li>
              ))}
            </ol>
          </div>

          {p.canComment && (
            <div className="space-y-2">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} maxLength={2000} placeholder="Add a comment or update" className={input} />
              <div className="flex flex-wrap items-center gap-3">
                <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm text-slate-600" />
                {d.commentModes.length > 1 && (
                  <select aria-label="Who can read this" value={mode} onChange={(e) => setMode(e.target.value)} className={`${input} max-w-[15rem]`}>
                    {d.commentModes.map((m) => <option key={m} value={m}>{m === "ALL" ? "Everyone on this request" : m === "APPROVERS" ? "Approvers only (hidden from employee and department)" : "Department only (hidden from the employee)"}</option>)}
                  </select>
                )}
                <button disabled={busy || comment.trim().length < 1} onClick={() => act(async () => {
                  const attachment = file ? { fileName: file.name, data: await readFile(file), mimeType: file.type } : undefined;
                  await apiPost(`${base}/comments`, { body: comment, visibility: d.commentModes.includes(mode) ? mode : "ALL", attachment });
                }, () => { setComment(""); setFile(null); })} className="ml-auto rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? "Sending…" : "Add comment"}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ===========================================================================
type AdminDept = { id: string; name: string; isActive: boolean; platformId: string; company: string; members: { id: string; name: string; employeeCode: string | null }[] };
type Person = { id: string; name: string; employeeCode: string | null; status: string; company?: string | null };

function ManageDepartments({ onClose }: { onClose: () => void }) {
  const [reload, setReload] = useState(0);
  const { data, error } = useApi<{ ready: boolean; departments: AdminDept[]; companies: { id: string; name: string }[] }>("/queries/dept/admin/departments", reload);
  const people = useApi<{ users: Person[] }>("/admin/users", 0);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [editing, setEditing] = useState<AdminDept | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [find, setFind] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    if (busy) return;
    setBusy(true); setErr("");
    try { await fn(); after?.(); setReload((n) => n + 1); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const companyId = company || data?.companies[0]?.id || "";
  const pool = (people.data?.users ?? []).filter((u) => u.status === "ACTIVE" && editing && u.company === editing.company && `${u.name} ${u.employeeCode ?? ""}`.toLowerCase().includes(find.trim().toLowerCase()));

  return (
    <Modal title="Manage departments" subtitle="The list employees pick from. Members are the people who do the work for that department." onClose={onClose} width="max-w-2xl">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {data && !data.ready && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Not switched on yet: the database update has not been applied.</p>}
      {data?.ready && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-slate-500">New department<input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="For example: IT Department" className={`mt-1 block w-60 ${input}`} /></label>
            {data.companies.length > 1 && (
              <label className="text-xs text-slate-500">Company
                <select value={companyId} onChange={(e) => setCompany(e.target.value)} className={`mt-1 block ${input}`}>{data.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              </label>
            )}
            <button disabled={busy || name.trim().length < 2} onClick={() => run(() => apiPost("/queries/dept/admin/departments", { name, platformId: companyId }), () => setName(""))} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Add</button>
          </div>
          {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600" role="alert">{err}</p>}
          {data.departments.length === 0 && <p className="text-sm text-slate-500">No departments yet. Add the first one above.</p>}
          <ul className="divide-y divide-indigo-50 rounded-2xl border border-indigo-100">
            {data.departments.map((x) => (
              <li key={x.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-slate-900">{x.name} <span className="text-xs font-normal text-slate-500">· {x.company} · {x.members.length} {x.members.length === 1 ? "member" : "members"}{x.isActive ? "" : " · hidden"}</span></p>
                  <div className="flex gap-2">
                    <button onClick={() => { setEditing(editing?.id === x.id ? null : x); setPicked(new Set(x.members.map((m) => m.id))); setFind(""); }} className="rounded-lg border border-indigo-200 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50">{editing?.id === x.id ? "Close" : "Members"}</button>
                    <button disabled={busy} onClick={() => run(() => apiPost(`/queries/dept/admin/departments/${x.id}`, { isActive: !x.isActive }))} className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">{x.isActive ? "Hide" : "Show"}</button>
                  </div>
                </div>
                {editing?.id === x.id && (
                  <div className="space-y-2 rounded-xl bg-[#F3F7F6] p-3">
                    <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search people of this company…" className={input} />
                    <ul className="max-h-48 space-y-1 overflow-y-auto">
                      {pool.map((u) => (
                        <li key={u.id}><label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={picked.has(u.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(u.id); else n.delete(u.id); return n; })} />{u.name}{u.employeeCode ? ` (${u.employeeCode})` : ""}</label></li>
                      ))}
                      {pool.length === 0 && <li className="text-xs text-slate-500">No matching people.</li>}
                    </ul>
                    <button disabled={busy} onClick={() => run(() => apiPost(`/queries/dept/admin/departments/${x.id}`, { memberIds: [...picked] }), () => setEditing(null))} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Save members ({picked.size})</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
