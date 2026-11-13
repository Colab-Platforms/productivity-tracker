"use client";

import { Suspense, useEffect, useState } from "react";
import { roleLabel } from "@/lib/roles";
import { useRouter, useSearchParams } from "next/navigation";
import { API_BASE, apiGet, apiPost, getToken } from "@/lib/api";
import { useMe } from "../layout";
import { Modal } from "../_employees/Modal";
import RequestCorrectionModal from "../_corrections/RequestModal";

// ---------------------------------------------------------------------------
// COMPLAINT CENTRE (employees) / QUERY DESK (HR, Manager, Admin)
// ONE place for everything a person raises or has to answer: HR queries, leave, payroll, documents, technical issues, other, and
// attendance corrections. A correction is only LISTED here: it keeps its own form and its own approval screen (manager first, then HR).
// The server decides who sees what; this page only shows what comes back.
// ---------------------------------------------------------------------------

type Item = {
  kind: "TICKET" | "CORRECTION";
  id: string;
  reference: string | null;
  category: string;
  categoryLabel: string;
  subject: string;
  status: string;
  statusLabel: string;
  subStatus: string | null;
  raisedBy: { id: string; name: string; employeeCode: string | null };
  assignedTo: string | null;
  createdAt: string;
  isOverdue: boolean;
  messageCount: number;
  needsYou: boolean;
  isMine: boolean;
};
type List = { label: string; isStaff: boolean; total: number; summary: { open: number; waitingForEmployee: number; finished: number; needsYou: number }; items: Item[] };
type Cat = { key: string; label: string; opensCorrectionForm: boolean };
type Message = { id: string; body: string; isInternal: boolean; createdAt: string; author: string; authorId: string; authorIsStaff: boolean; attachment: { name: string } | null };
type Ev = { id: string; kind: string; by: string | null; from: string | null; to: string | null; note: string | null; at: string };
type Detail = {
  id: string; reference: string; category: string; categoryLabel: string; status: string; rawStatus: string; statusLabel: string; priority: string;
  subject: string; description: string; resolutionNote: string | null; raisedBy: { id: string; name: string; employeeCode: string | null };
  assignedTo: { id: string; name: string } | null; createdAt: string; dueAt: string | null; awaitingInfoSince: string | null; legacyCorrection: boolean;
  messages: Message[]; events: Ev[]; assignees: { id: string; name: string; role: string }[];
  permissions: { canReply: boolean; canAddInternalNote: boolean; canRequestInfo: boolean; canChangeStatus: boolean; canAssign: boolean; canReopen: boolean };
};

const CHIP: Record<string, string> = {
  OPEN: "bg-amber-50 text-amber-700",
  IN_PROGRESS: "bg-sky-50 text-sky-700",
  WAITING_FOR_EMPLOYEE: "bg-violet-50 text-violet-700",
  RESOLVED: "bg-emerald-50 text-emerald-700",
  CLOSED: "bg-slate-100 text-slate-600",
  REJECTED: "bg-red-50 text-red-600",
};
const STATUS_OPTIONS = [
  ["OPEN", "Open"], ["IN_PROGRESS", "In progress"], ["WAITING_FOR_EMPLOYEE", "Waiting for employee"], ["RESOLVED", "Resolved"], ["CLOSED", "Closed"], ["REJECTED", "Rejected"],
] as const;
const SETTABLE = STATUS_OPTIONS.filter(([k]) => k !== "WAITING_FOR_EMPLOYEE");

const when = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(s));
const dayOnly = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(s));

const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(file);
  });

function useApi<T>(path: string | null, reload: number) {
  const [res, setRes] = useState<{ path: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    apiGet<T>(path)
      .then((data) => live && setRes({ path, data }))
      .catch((e: Error) => live && setRes((prev) => ({ path, data: prev?.data, error: e.message })));
    return () => {
      live = false;
    };
  }, [path, reload]);
  return { data: res?.data ?? null, error: res && res.path === path ? (res.error ?? "") : "" };
}

async function openFile(path: string) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error("Could not open the file");
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Chip({ status, label }: { status: string; label: string }) {
  return <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${CHIP[status] ?? "bg-slate-100 text-slate-600"}`}>{label}</span>;
}

// ===========================================================================
function QueriesInner() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const staff = me?.role !== "EMPLOYEE";
  const title = staff ? "Query Desk" : "Complaint Centre";

  const [reload, setReload] = useState(0);
  const [category, setCategory] = useState(() => params.get("category") ?? "");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [employee, setEmployee] = useState("");
  const [q, setQ] = useState("");
  const [qApplied, setQApplied] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [raising, setRaising] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [notice, setNotice] = useState("");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [closedLink, setClosedLink] = useState<string | null>(null);

  // A link from a notification (?kind=ticket&id=...) opens that query.
  const linked = params.get("kind") === "ticket" ? params.get("id") : null;
  const openId = chosenId ?? (linked && linked !== closedLink ? linked : null);
  const setOpenId = (id: string | null) => {
    setChosenId(id);
    if (id === null) setClosedLink(linked);
  };

  useEffect(() => {
    const t = setTimeout(() => setQApplied(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const qs = new URLSearchParams();
  if (category) qs.set("category", category);
  if (status) qs.set("status", status);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (employee.trim()) qs.set("employee", employee.trim());
  if (qApplied) qs.set("q", qApplied);
  if (mineOnly) qs.set("mine", "1");
  const list = useApi<List>(`/queries?${qs.toString()}`, reload);
  const cats = useApi<{ categories: Cat[] }>("/queries/categories", 0);
  const filtersOn = !!(category || status || from || to || employee.trim() || q.trim() || mineOnly);
  const clear = () => { setCategory(""); setStatus(""); setFrom(""); setTo(""); setEmployee(""); setQ(""); setQApplied(""); setMineOnly(false); };

  function openItem(i: Item) {
    if (i.kind === "CORRECTION") router.push(`/dashboard/corrections?id=${i.id}`); // the correction's own approval screen
    else setOpenId(i.id);
  }

  const d = list.data;
  const tiles: [string, number, string][] = d
    ? [["Needs your action", d.summary.needsYou, d.summary.needsYou > 0 ? "text-rose-600" : "text-slate-900"], ["Open", d.summary.open, "text-slate-900"], ["Waiting for employee", d.summary.waitingForEmployee, "text-slate-900"], ["Resolved / closed", d.summary.finished, "text-slate-900"]]
    : [];
  const field = "rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800";

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {staff ? "Queries and complaints from the people you look after, and attendance corrections waiting for you. Everything in one place." : "Raise a complaint or query, attach proof, and follow the answer. Attendance corrections are here too."}
          </p>
        </div>
        <button onClick={() => setRaising(true)} className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">
          {staff ? "Raise a query" : "Raise a complaint"}
        </button>
      </header>

      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700" role="status">{notice}</p>}
      {list.error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{list.error}</p>}

      {tiles.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map(([label, n, cls]) => (
            <div key={label} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
              <p className="text-xs text-slate-500">{label}</p>
              <p className={`mt-1 text-2xl font-semibold tabular-nums ${cls}`}>{n}</p>
            </div>
          ))}
        </div>
      )}

      <section className="space-y-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] sm:p-5">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Category">
          <button onClick={() => setCategory("")} className={`rounded-full px-3 py-1 text-xs font-medium ${!category ? "bg-indigo-600 text-white" : "bg-[#F3F7F6] text-slate-600 hover:bg-indigo-50"}`}>All categories</button>
          {cats.data?.categories.map((c) => (
            <button key={c.key} onClick={() => setCategory(category === c.key ? "" : c.key)} className={`rounded-full px-3 py-1 text-xs font-medium ${category === c.key ? "bg-indigo-600 text-white" : "bg-[#F3F7F6] text-slate-600 hover:bg-indigo-50"}`}>{c.label}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-500">Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Subject or reference" className={`mt-1 block w-52 ${field}`} /></label>
          {staff && <label className="text-xs text-slate-500">Employee<input value={employee} onChange={(e) => setEmployee(e.target.value)} placeholder="Name or ID" className={`mt-1 block w-44 ${field}`} /></label>}
          <label className="text-xs text-slate-500">Status
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={`mt-1 block ${field}`}>
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`mt-1 block ${field}`} /></label>
          <label className="text-xs text-slate-500">To<input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={`mt-1 block ${field}`} /></label>
          {staff && (
            <label className="flex items-center gap-2 pb-2 text-sm text-slate-600"><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Only mine</label>
          )}
          {filtersOn && <button onClick={clear} className="rounded-xl px-3 py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50">Clear filters</button>}
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        {!d && !list.error && <div className="space-y-2 p-5" aria-busy="true"><div className="skeleton h-14" /><div className="skeleton h-14" /><div className="skeleton h-14" /></div>}
        {d && d.items.length === 0 && (
          <p className="px-6 py-14 text-center text-sm text-slate-500">{filtersOn ? "Nothing matches these filters." : staff ? "Nothing here yet. New queries from your people will show up here." : "You haven't raised anything yet. Use “Raise a complaint” if you need help."}</p>
        )}
        <ul className="divide-y divide-indigo-50">
          {d?.items.map((i) => (
            <li key={`${i.kind}-${i.id}`}>
              <button onClick={() => openItem(i)} className="flex w-full flex-wrap items-start justify-between gap-3 px-4 py-4 text-left hover:bg-indigo-50/40 sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="rounded-full bg-[#F3F7F6] px-2 py-0.5 font-medium text-slate-600">{i.categoryLabel}</span>
                    {i.reference && <span className="tabular-nums">{i.reference}</span>}
                    {i.isOverdue && <span className="rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-600">Overdue</span>}
                    {i.needsYou && <span className="rounded-full bg-rose-500 px-2 py-0.5 font-medium text-white">Needs you</span>}
                  </p>
                  <p className="mt-1 truncate text-sm font-medium text-slate-900">{i.subject}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {staff && !i.isMine ? `${i.raisedBy.name}${i.raisedBy.employeeCode ? ` (${i.raisedBy.employeeCode})` : ""} · ` : ""}
                    {dayOnly(i.createdAt)}{i.assignedTo ? ` · ${i.kind === "CORRECTION" ? "decided by" : "assigned to"} ${i.assignedTo}` : ""}{i.messageCount > 0 ? ` · ${i.messageCount} ${i.messageCount === 1 ? "message" : "messages"}` : ""}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Chip status={i.status} label={i.statusLabel} />
                  {i.subStatus && <span className="text-xs text-slate-500">{i.subStatus}</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {raising && (
        <RaiseModal
          categories={cats.data?.categories ?? []}
          staff={staff}
          onClose={() => setRaising(false)}
          onCorrection={() => { setRaising(false); setCorrecting(true); }}
          onDone={(ref) => { setRaising(false); setNotice(`Sent${ref ? ` as ${ref}` : ""}. You will be told when someone answers.`); setReload((n) => n + 1); }}
        />
      )}
      {correcting && (
        <RequestCorrectionModal
          onClose={() => setCorrecting(false)}
          onDone={() => { setCorrecting(false); setNotice("Correction requested. Your manager answers first, then HR decides."); setReload((n) => n + 1); }}
        />
      )}
      {openId && <DetailModal id={openId} onClose={() => setOpenId(null)} onChanged={() => setReload((n) => n + 1)} />}
    </div>
  );
}

// ===========================================================================
function RaiseModal({ categories, staff, onClose, onCorrection, onDone }: { categories: Cat[]; staff: boolean; onClose: () => void; onCorrection: () => void; onDone: (ref: string | null) => void }) {
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const picked = categories.find((c) => c.key === category);

  async function submit() {
    if (busy) return;
    if (!category) return setError("Choose a category.");
    if (picked?.opensCorrectionForm) return onCorrection();
    setBusy(true);
    setError("");
    try {
      const attachment = file ? { fileName: file.name, data: await readFile(file), mimeType: file.type } : undefined;
      const r = await apiPost<{ reference: string }>("/queries", { category, subject, description, attachment });
      onDone(r.reference);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const input = "mt-1 w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800";
  return (
    <Modal
      title={staff ? "Raise a query" : "Raise a complaint"}
      subtitle="Pick what it is about. Add a screenshot or document if it helps."
      onClose={onClose}
      width="max-w-xl"
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Close</button>
          <button disabled={busy || !category} onClick={submit} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "Sending…" : picked?.opensCorrectionForm ? "Continue" : "Send"}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <label className="block text-sm text-slate-600">Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={input}>
            <option value="">Choose a category…</option>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        {picked?.opensCorrectionForm ? (
          <p className="rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-900">An attendance correction has its own form (the day and the times you should have had). It goes to your manager first, then HR decides. Press Continue.</p>
        ) : (
          <>
            <label className="block text-sm text-slate-600">Subject<input value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} placeholder="A few words" className={input} /></label>
            <label className="block text-sm text-slate-600">Details<textarea value={description} maxLength={4000} rows={5} onChange={(e) => setDescription(e.target.value)} placeholder="What happened? Dates, amounts, names: anything that helps." className={input} /></label>
            <label className="block text-sm text-slate-600">Attachment (optional)
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm text-slate-600" />
              <span className="text-xs text-slate-400">PDF, image or Word file, up to 10 MB.</span>
            </label>
          </>
        )}
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

// ===========================================================================
function DetailModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [reload, setReload] = useState(0);
  const { data: d, error } = useApi<Detail>(`/queries/${id}`, reload);
  const [text, setText] = useState("");
  const [internal, setInternal] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [newStatus, setNewStatus] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [asking, setAsking] = useState(false);
  const [infoText, setInfoText] = useState("");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function act(fn: () => Promise<unknown>, after?: () => void) {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await fn();
      after?.();
      setReload((n) => n + 1);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const p = d?.permissions;
  const input = "w-full rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800";
  const eventText = (e: Ev) =>
    e.kind === "CREATED" ? "Raised" : e.kind === "ASSIGNED" ? `Assigned to ${e.note ?? "someone"}` : e.kind === "STATUS" ? `Status changed from ${e.from ?? "?"} to ${e.to ?? "?"}` : e.kind === "INFO_REQUESTED" ? "More information requested" : "Information received";

  return (
    <Modal title={d ? d.subject : "Query"} subtitle={d ? `${d.reference} · ${d.categoryLabel}` : undefined} onClose={onClose} width="max-w-3xl">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {d && p && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Chip status={d.status} label={d.statusLabel} />
            <span className="text-xs text-slate-500">Raised by {d.raisedBy.name}{d.raisedBy.employeeCode ? ` (${d.raisedBy.employeeCode})` : ""} · {when(d.createdAt)}</span>
            <span className="text-xs text-slate-500">· {d.assignedTo ? `Assigned to ${d.assignedTo.name}` : "Not assigned"}</span>
          </div>
          {d.legacyCorrection && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">This is an older attendance-correction request made as a ticket. New corrections are made from “Attendance correction” in the Raise menu so they get the full approval.</p>}
          {d.awaitingInfoSince && <p className="rounded-xl bg-violet-50 px-4 py-3 text-sm text-violet-800">More information was requested on {when(d.awaitingInfoSince)}. Reply below to answer.</p>}

          <div className="rounded-2xl bg-[#F3F7F6] p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">What was raised</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{d.description}</p>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Conversation</p>
            <div className="mt-2 space-y-3">
              {d.messages.length === 0 && <p className="text-sm text-slate-500">No replies yet.</p>}
              {d.messages.map((m) => (
                <div key={m.id} className={`rounded-2xl border p-3 text-sm ${m.isInternal ? "border-amber-200 bg-amber-50" : m.authorIsStaff ? "border-indigo-100 bg-white" : "border-indigo-50 bg-[#F3F7F6]"}`}>
                  <p className="text-xs text-slate-500">
                    <b className="text-slate-700">{m.author}</b> · {when(m.createdAt)}{m.isInternal && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">Internal note (staff only)</span>}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-slate-800">{m.body}</p>
                  {m.attachment && (
                    <button onClick={() => openFile(`/queries/${d.id}/messages/${m.id}/attachment`).catch((e: Error) => setErr(e.message))} className="mt-2 rounded-lg border border-indigo-100 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
                      Open attachment: {m.attachment.name}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {p.canReply && (
            <div className="space-y-2">
              <textarea value={text} maxLength={4000} rows={3} onChange={(e) => setText(e.target.value)} placeholder={internal ? "Internal note: only staff can read this" : "Write a reply"} className={input} />
              <div className="flex flex-wrap items-center gap-3">
                <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm text-slate-600" />
                {p.canAddInternalNote && <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal remark (hidden from the employee)</label>}
                <button
                  disabled={busy || text.trim().length < 1}
                  onClick={() => act(async () => {
                    const attachment = file ? { fileName: file.name, data: await readFile(file), mimeType: file.type } : undefined;
                    await apiPost(`/queries/${d.id}/messages`, { body: text, internal, attachment });
                  }, () => { setText(""); setFile(null); setInternal(false); })}
                  className="ml-auto rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {busy ? "Sending…" : internal ? "Save note" : "Send reply"}
                </button>
              </div>
            </div>
          )}

          {(p.canRequestInfo || p.canChangeStatus || p.canAssign) && (
            <div className="space-y-4 rounded-2xl border border-indigo-100 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Handle this query</p>
              {p.canRequestInfo && (
                <div>
                  {!asking ? (
                    <button onClick={() => setAsking(true)} className="rounded-xl border border-violet-200 px-4 py-2 text-sm font-medium text-violet-700 hover:bg-violet-50">Request more information</button>
                  ) : (
                    <div className="space-y-2">
                      <textarea value={infoText} rows={2} maxLength={4000} onChange={(e) => setInfoText(e.target.value)} placeholder="What do you need from them?" className={input} />
                      <div className="flex gap-2">
                        <button disabled={busy || infoText.trim().length < 3} onClick={() => act(() => apiPost(`/queries/${d.id}/request-info`, { message: infoText }), () => { setAsking(false); setInfoText(""); })} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Send request</button>
                        <button onClick={() => setAsking(false)} className="rounded-xl px-3 py-2 text-sm text-slate-500">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {p.canChangeStatus && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <select value={newStatus} onChange={(e) => setNewStatus(e.target.value)} className={`${input} max-w-[14rem]`} aria-label="New status">
                      <option value="">Change status…</option>
                      {SETTABLE.filter(([k]) => k !== d.rawStatus).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                    <input value={statusNote} onChange={(e) => setStatusNote(e.target.value)} maxLength={1000} placeholder={newStatus === "RESOLVED" || newStatus === "REJECTED" ? "Why (required: the person will read it)" : "Note (optional)"} className={`${input} min-w-[14rem] flex-1`} />
                    <button disabled={busy || !newStatus} onClick={() => act(() => apiPost(`/queries/${d.id}/status`, { status: newStatus, note: statusNote }), () => { setNewStatus(""); setStatusNote(""); })} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Update</button>
                  </div>
                </div>
              )}
              {p.canAssign && (
                <div className="flex flex-wrap gap-2">
                  <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={`${input} max-w-[18rem]`} aria-label="Assign to">
                    <option value="">Assign to…</option>
                    {d.assignees.filter((a) => a.id !== d.assignedTo?.id).map((a) => <option key={a.id} value={a.id}>{a.name} ({roleLabel(a.role)})</option>)}
                  </select>
                  <button disabled={busy || !assignee} onClick={() => act(() => apiPost(`/queries/${d.id}/assign`, { assigneeId: assignee }), () => setAssignee(""))} className="rounded-xl border border-indigo-200 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">Assign</button>
                </div>
              )}
            </div>
          )}

          {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">History</p>
            <ol className="mt-2 space-y-1.5 border-l-2 border-indigo-100 pl-4">
              <li className="text-sm text-slate-700">Raised <span className="text-xs text-slate-400">· {when(d.createdAt)}</span></li>
              {d.events.filter((e) => e.kind !== "CREATED").map((e) => (
                <li key={e.id} className="text-sm text-slate-700">{eventText(e)}{e.by ? ` by ${e.by}` : ""}{e.kind === "INFO_REQUESTED" && e.note ? `: “${e.note}”` : e.kind === "STATUS" && e.note ? `: “${e.note}”` : ""} <span className="text-xs text-slate-400">· {when(e.at)}</span></li>
              ))}
              {d.resolutionNote && <li className="text-sm text-slate-700">Resolution note: “{d.resolutionNote}”</li>}
            </ol>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function QueriesPage() {
  return (
    <Suspense fallback={null}>
      <QueriesInner />
    </Suspense>
  );
}
