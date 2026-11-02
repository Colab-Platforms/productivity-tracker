"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { apiPost } from "@/lib/api";
import { useMe } from "../layout";
import { Modal } from "../_employees/Modal";
import { MyDocuments, Chip, card, readFile, useApi, viewFile, type Mine, type Summary } from "../_documents/MyDocuments";

// ---------------------------------------------------------------------------
// DOCUMENTS
// Everyone: see which documents are asked of you, upload them, and see whether HR has
//           verified or rejected each one (and why).
// HR/Admin: choose which documents are required (and from whom), see who is missing or
//           waiting for review, and verify or reject submissions.
// Nothing is deleted when a requirement is switched off: submitted files are kept.
// ---------------------------------------------------------------------------

type Row = { id: string; name: string; employeeCode: string | null; designation: string | null; employmentType: string | null; complete: boolean } & Summary;
type Tracking = { totals: { people: number; withMissing: number; withPending: number; withRejected: number; complete: number }; teams: { id: string; name: string }[]; rows: Row[] };
type Checklist = Mine & { employee: { id: string; name: string; employeeCode: string | null; designation: string | null } };
type Requirement = {
  id: string; category: string; label: string; helpText: string | null; isMandatory: boolean; uploadedByEmployee: boolean; isActive: boolean;
  sortOrder: number; appliesTo: string[]; submitted: number; verified: number; rejected: number;
};

const TYPES: [string, string][] = [["PERMANENT", "Permanent"], ["PROBATION", "Probation"], ["CONTRACT", "Contract"], ["INTERN", "Intern"]];
const typeLabel = (t: string | null) => TYPES.find(([k]) => k === t)?.[1] ?? "Not set";
const CATEGORIES: [string, string][] = [["IDENTITY", "Identity"], ["EDUCATION", "Education"], ["EMPLOYMENT", "Employment history"], ["BANKING", "Banking"], ["PHOTO", "Photo"], ["RESUME", "Resume"], ["CONTRACT", "Contract"], ["OTHER", "Other"]];
function DocumentsInner() {
  const me = useMe();
  const isHr = me?.role === "HR" || me?.role === "ADMIN";
  const [tab, setTab] = useState<"mine" | "tracking" | "requirements">("mine");
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const tabs: ["mine" | "tracking" | "requirements", string][] = isHr ? [["mine", "My documents"], ["tracking", "Employee tracking"], ["requirements", "Requirements"]] : [["mine", "My documents"]];

  return (
    <div className="page-fluid space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Documents</h1>
        <p className="mt-1 text-sm text-slate-500">{isHr ? "Choose which documents are required, and follow who has submitted what." : "The documents your company asks for, and where each one stands."}</p>
      </div>

      {tabs.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {tabs.map(([k, label]) => (
            <button key={k} onClick={() => { setTab(k); setNotice(""); setError(""); }} className={`rounded-xl px-4 py-2 text-sm font-medium ${tab === k ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-indigo-50"}`}>{label}</button>
          ))}
        </div>
      )}
      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}


      {tab === "mine" && <MyDocuments />}

      {tab === "tracking" && isHr && <TrackingTab reload={reload} bump={() => setReload((n) => n + 1)} />}
      {tab === "requirements" && isHr && <RequirementsTab reload={reload} bump={() => setReload((n) => n + 1)} setNotice={setNotice} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function TrackingTab({ reload, bump }: { reload: number; bump: () => void }) {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [teamId, setTeamId] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const qs = new URLSearchParams();
  if (dq) qs.set("q", dq);
  if (status) qs.set("status", status);
  if (type) qs.set("employmentType", type);
  if (teamId) qs.set("teamId", teamId);
  const t = useApi<Tracking>(`/documents/tracking?${qs.toString()}`, reload);
  const tot = t.data?.totals;
  const filters: [string, string, number | undefined, string][] = [["", "Everyone", tot?.people, "bg-indigo-50 text-indigo-700"], ["missing", "Missing documents", tot?.withMissing, "bg-red-50 text-red-600"], ["pending", "Waiting for review", tot?.withPending, "bg-amber-50 text-amber-700"], ["rejected", "Has rejected", tot?.withRejected, "bg-red-50 text-red-600"], ["complete", "Complete", tot?.complete, "bg-emerald-50 text-emerald-700"]];

  return (
    <section className={`${card} p-6`}>
      <div className="flex flex-wrap gap-2">
        {filters.map(([k, l, n, c]) => (
          <button key={k} onClick={() => setStatus(k)} className={`rounded-xl px-3.5 py-2 text-sm font-medium ${status === k ? "bg-indigo-600 text-white" : c}`}>{l}{n !== undefined ? ` · ${n}` : ""}</button>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-500">Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or employee ID" className="mt-1 block w-52 rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-800" /></label>
        <label className="text-xs text-slate-500">Employment type
          <select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 block rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800">
            <option value="">All</option>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}<option value="UNSPECIFIED">Not set</option>
          </select>
        </label>
        <label className="text-xs text-slate-500">Team
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="mt-1 block rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800">
            <option value="">All teams</option>{t.data?.teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      </div>
      {t.error && <p className="mt-3 text-sm text-red-600">{t.error}</p>}
      {!t.data && !t.error && <div className="mt-4 space-y-2" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-12" />)}</div>}
      {t.data && t.data.rows.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">No one matches.</p>}
      {t.data && t.data.rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead><tr className="text-xs text-slate-400"><th className="py-2 font-medium">Employee</th><th className="py-2 font-medium">Type</th><th className="py-2 text-right font-medium">Required</th><th className="py-2 text-right font-medium">Verified</th><th className="py-2 text-right font-medium">Waiting</th><th className="py-2 text-right font-medium">Rejected</th><th className="py-2 text-right font-medium">Missing</th><th className="py-2" /></tr></thead>
            <tbody className="divide-y divide-indigo-100">
              {t.data.rows.map((r) => (
                <tr key={r.id} onClick={() => setOpenId(r.id)} className="cursor-pointer hover:bg-indigo-50/40">
                  <td className="py-3"><p className="font-medium text-slate-900">{r.name}</p><p className="text-xs text-slate-400">{r.employeeCode}</p></td>
                  <td className="py-3 text-slate-600">{typeLabel(r.employmentType)}</td>
                  <td className="py-3 text-right tabular-nums text-slate-600">{r.required}</td>
                  <td className="py-3 text-right tabular-nums text-emerald-700">{r.verified}</td>
                  <td className="py-3 text-right tabular-nums text-amber-700">{r.submitted}</td>
                  <td className="py-3 text-right tabular-nums text-red-600">{r.rejected}</td>
                  <td className="py-3 text-right tabular-nums font-semibold text-red-600">{r.missing}</td>
                  <td className="py-3 text-right text-xs text-indigo-600">Open</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId && <ChecklistModal userId={openId} onClose={() => setOpenId(null)} onChanged={bump} />}
    </section>
  );
}

function ChecklistModal({ userId, onClose, onChanged }: { userId: string; onClose: () => void; onChanged: () => void }) {
  const [reload, setReload] = useState(0);
  const { data: d, error } = useApi<Checklist>(`/documents/employees/${userId}`, reload);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);

  const done = () => { setReload((n) => n + 1); onChanged(); };
  // HR uploads on the employee's behalf. The server marks an HR upload as verified (nobody else reviews it).
  async function upload(file: File | undefined) {
    const id = uploadFor;
    setUploadFor(null);
    if (!file || !id || busy) return;
    setBusy(true);
    setErr("");
    try {
      await apiPost(`/onboarding/candidates/${userId}/documents`, { requirementId: id, fileName: file.name, data: await readFile(file), mimeType: file.type });
      done();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function review(documentId: string, approve: boolean) {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await apiPost(`/onboarding/documents/${documentId}/review`, { approve, rejectionReason: approve ? undefined : reason });
      setRejecting(null);
      setReason("");
      done();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function setType(v: string) {
    setErr("");
    try {
      await apiPost(`/documents/employees/${userId}/employment-type`, { employmentType: v || null });
      done();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <Modal title={d?.employee.name ?? "Documents"} subtitle={d ? `${d.employee.employeeCode ?? ""}${d.employee.designation ? ` · ${d.employee.designation}` : ""}` : undefined} onClose={onClose} width="max-w-3xl">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!d && !error && <div className="skeleton h-40" aria-busy="true" />}
      {d && (
        <div className="space-y-4">
          <label className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
            Employment type
            <select value={d.employmentType ?? ""} onChange={(e) => setType(e.target.value)} className="rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm">
              <option value="">Not set (sees every requirement)</option>
              {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <input ref={picker} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
          {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}
          <div className="divide-y divide-indigo-100 rounded-2xl border border-indigo-100">
            {d.items.map((i) => (
              <div key={i.requirementId} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-slate-900">{i.name} <span className="ml-1 text-xs font-normal text-slate-400">{i.isMandatory ? "Required" : "Optional"}{i.uploadedByEmployee ? "" : " · HR uploads"}</span></p>
                  <div className="flex items-center gap-2">
                    <Chip s={i.status} label={i.status === "SUBMITTED" ? "Waiting for review" : i.statusLabel} />
                    <button disabled={busy} onClick={() => { setUploadFor(i.requirementId); picker.current?.click(); }} className="rounded-lg border border-indigo-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{i.documentId ? "Replace" : "Upload"}</button>
                    {i.documentId && i.fileName && <button onClick={() => viewFile(i.documentId as string).catch((e: Error) => setErr(e.message))} className="rounded-lg border border-indigo-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">View</button>}
                    {i.documentId && i.status === "SUBMITTED" && (
                      <>
                        <button disabled={busy} onClick={() => review(i.documentId as string, true)} className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Verify</button>
                        <button disabled={busy} onClick={() => { setRejecting(rejecting === i.documentId ? null : (i.documentId as string)); setReason(""); }} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Reject</button>
                      </>
                    )}
                  </div>
                </div>
                {i.status === "REJECTED" && i.rejectionReason && <p className="mt-1 text-xs text-red-600">Rejected: {i.rejectionReason}</p>}
                {rejecting === i.documentId && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Why is it being rejected? (required)" className="min-w-[14rem] flex-1 rounded-xl border border-indigo-100 px-3 py-2 text-sm" />
                    <button disabled={busy || reason.trim().length < 3} onClick={() => review(i.documentId as string, false)} className="rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">Confirm reject</button>
                  </div>
                )}
              </div>
            ))}
            {d.items.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-500">No documents apply to this person.</p>}
          </div>
          {d.archived.length > 0 && <p className="text-xs text-slate-400">{d.archived.length} older file(s) are kept for requirements that are no longer asked for.</p>}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
function RequirementsTab({ reload, bump, setNotice }: { reload: number; bump: () => void; setNotice: (s: string) => void }) {
  const r = useApi<{ requirements: Requirement[] }>("/onboarding/requirements", reload);
  const [editing, setEditing] = useState<Requirement | "new" | null>(null);
  return (
    <section className={`${card} p-6`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-slate-500">You decide which documents are asked for, from whom, and whether they are required. Switching a requirement off never deletes files that were already submitted.</p>
        <button onClick={() => setEditing("new")} className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">Add requirement</button>
      </div>
      {r.error && <p className="mt-3 text-sm text-red-600">{r.error}</p>}
      {!r.data && !r.error && <div className="mt-4 space-y-2" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-12" />)}</div>}
      {r.data && r.data.requirements.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">No requirements yet. Add the first one.</p>}
      {r.data && r.data.requirements.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead><tr className="text-xs text-slate-400"><th className="py-2 font-medium">Document</th><th className="py-2 font-medium">Type</th><th className="py-2 font-medium">Required</th><th className="py-2 font-medium">Uploaded by</th><th className="py-2 font-medium">Applies to</th><th className="py-2 font-medium">Status</th><th className="py-2 text-right font-medium">Waiting / verified</th><th className="py-2" /></tr></thead>
            <tbody className="divide-y divide-indigo-100">
              {r.data.requirements.map((q) => (
                <tr key={q.id} className={q.isActive ? "" : "opacity-60"}>
                  <td className="py-3"><p className="font-medium text-slate-900">{q.label}</p>{q.helpText && <p className="text-xs text-slate-400">{q.helpText}</p>}</td>
                  <td className="py-3 text-slate-600">{CATEGORIES.find(([k]) => k === q.category)?.[1] ?? q.category}</td>
                  <td className="py-3 text-slate-600">{q.isMandatory ? "Required" : "Optional"}</td>
                  <td className="py-3 text-slate-600">{q.uploadedByEmployee ? "Employee" : "HR"}</td>
                  <td className="py-3 text-slate-600">{q.appliesTo.length ? q.appliesTo.map(typeLabel).join(", ") : "Everyone"}</td>
                  <td className="py-3"><span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${q.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{q.isActive ? "Active" : "Off"}</span></td>
                  <td className="py-3 text-right tabular-nums text-slate-600">{q.submitted} / {q.verified}</td>
                  <td className="py-3 text-right"><button onClick={() => setEditing(q)} className="rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <RequirementModal item={editing === "new" ? null : editing} onClose={() => setEditing(null)} onDone={(text) => { setEditing(null); setNotice(text); bump(); }} />}
    </section>
  );
}

function RequirementModal({ item, onClose, onDone }: { item: Requirement | null; onClose: () => void; onDone: (t: string) => void }) {
  const [label, setLabel] = useState(item?.label ?? "");
  const [help, setHelp] = useState(item?.helpText ?? "");
  const [category, setCategory] = useState(item?.category ?? "OTHER");
  const [mandatory, setMandatory] = useState(item?.isMandatory ?? true);
  const [byEmployee, setByEmployee] = useState(item?.uploadedByEmployee ?? true);
  const [types, setTypes] = useState<string[]>(item?.appliesTo ?? []);
  const [active, setActive] = useState(item?.isActive ?? true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiPost("/onboarding/requirements", { id: item?.id, label, helpText: help, category, isMandatory: mandatory, uploadedByEmployee: byEmployee, appliesTo: types, ...(item ? { isActive: active } : {}) });
      onDone(item ? "Requirement updated." : "Requirement added.");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const input = "mt-1 w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800";
  return (
    <Modal title={item ? "Edit requirement" : "Add requirement"} subtitle="You choose what is asked for. Nothing is forced." onClose={onClose} width="max-w-lg"
      footer={<div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Close</button><button disabled={busy || label.trim().length < 2} onClick={save} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? "Saving…" : "Save"}</button></div>}>
      <div className="space-y-4">
        <label className="block text-sm text-slate-600">Document name<input value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} className={input} /></label>
        <label className="block text-sm text-slate-600">Description (optional)<input value={help} maxLength={300} onChange={(e) => setHelp(e.target.value)} placeholder="Shown to the employee" className={input} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-slate-600">Document type<select value={category} onChange={(e) => setCategory(e.target.value)} className={input}>{CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="block text-sm text-slate-600">Uploaded by<select value={byEmployee ? "E" : "H"} onChange={(e) => setByEmployee(e.target.value === "E")} className={input}><option value="E">The employee</option><option value="H">HR</option></select></label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} /> Required (otherwise optional)</label>
        <fieldset className="text-sm text-slate-600">
          <legend>Applies to</legend>
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
            {TYPES.map(([k, l]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={types.includes(k)} onChange={(e) => setTypes(e.target.checked ? [...types, k] : types.filter((x) => x !== k))} /> {l}</label>)}
          </div>
          <p className="mt-1 text-xs text-slate-400">Leave all unticked to ask everyone. People whose employment type is not set are asked for every document.</p>
        </fieldset>
        {item && <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active. Switching it off hides it but keeps every file already submitted.</label>}
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense fallback={null}>
      <DocumentsInner />
    </Suspense>
  );
}
