"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { useMe } from "../layout";
import { useRoleGate } from "../_routing/useRoleGate";
import { Modal } from "../_employees/Modal";

// ---------------------------------------------------------------------------
// COMPANIES (HR and Admin only)
// The companies that exist in Avatar HRMS. Employee numbers are shown only for
// your own company. HR can edit their own company, Admin can edit any. The
// server enforces all of this; this page only hides what you cannot use.
// ---------------------------------------------------------------------------

type Company = {
  id: string;
  name: string;
  slug: string;
  legalName: string | null;
  timezone: string;
  employeeCodePrefix: string | null;
  isActive: boolean;
  isYours: boolean;
  isPinned: boolean;
  employees: number | null;
  canEdit: boolean;
  canSetPrefix?: boolean;
};
type Data = { pinnedTo: { id: string; name: string } | null; canCreate: boolean; companies: Company[] };

function useData(reload: number, enabled: boolean) {
  const [res, setRes] = useState<{ data?: Data; error?: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    apiGet<Data>("/companies")
      .then((data) => live && setRes({ data }))
      .catch((e: Error) => live && setRes((p) => ({ data: p?.data, error: e.message })));
    return () => {
      live = false;
    };
  }, [reload, enabled]);
  return { data: res?.data ?? null, error: res?.error ?? "" };
}

export default function CompaniesPage() {
  const me = useMe();
  const { allowed } = useRoleGate(["ADMIN"]); // Admin only; anyone else is sent to their own home
  void me;
  const [reload, setReload] = useState(0);
  const { data, error } = useData(reload, allowed);
  const [editing, setEditing] = useState<Company | "new" | null>(null);
  const [notice, setNotice] = useState("");

  if (me && !allowed) {
    return (
      <div className="p-8">
        <p className="rounded-2xl bg-white p-6 text-sm text-slate-600 shadow-[var(--shadow-card)]">Company management is only available to Admin.</p>
      </div>
    );
  }

  const card = "rounded-2xl bg-white shadow-[var(--shadow-card)]";
  return (
    <div className="page-fluid space-y-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Companies</h1>
          <p className="mt-1 text-sm text-slate-500">
            {data?.pinnedTo ? `This Avatar HRMS is set up for ${data.pinnedTo.name}. Other companies are listed here but their people are not shown.` : "The companies in Avatar HRMS."}
          </p>
        </div>
        <button onClick={() => setEditing("new")} className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">
          Add company
        </button>
      </div>

      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}

      <section className={`${card} p-6`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="text-xs text-slate-400">
                <th className="py-2 font-medium">Company</th>
                <th className="py-2 font-medium">Code prefix</th>
                <th className="py-2 font-medium">Timezone</th>
                <th className="py-2 text-right font-medium">Employees</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-indigo-100">
              {data?.companies.map((c) => (
                <tr key={c.id} className={c.isActive ? "" : "opacity-60"}>
                  <td className="py-3">
                    <p className="font-medium text-slate-900">
                      {c.name}
                      {c.isYours && <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">Your company</span>}
                    </p>
                    {c.legalName && <p className="text-xs text-slate-400">{c.legalName}</p>}
                  </td>
                  <td className="py-3 text-slate-600">{c.employeeCodePrefix ?? "–"}</td>
                  <td className="py-3 text-slate-600">{c.timezone}</td>
                  <td className="py-3 text-right tabular-nums text-slate-600">{c.employees ?? "–"}</td>
                  <td className="py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{c.isActive ? "Active" : "Inactive"}</span>
                  </td>
                  <td className="py-3 text-right">
                    {c.canEdit && (
                      <button onClick={() => setEditing(c)} className="rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {data && <DesignationsPanel companies={data.companies} />}
      <AccessPanel />

      {editing && (
        <CompanyModal
          company={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null);
            setNotice(text);
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// DESIGNATIONS: the job titles offered in each company's dropdowns. Adding or renaming one never changes what a person already has.
// ---------------------------------------------------------------------------
type DesignationRow = { id: string; name: string; isActive: boolean; people: number };

function DesignationsPanel({ companies }: { companies: Company[] }) {
  const mine = companies.filter((c) => c.canEdit && c.isActive);
  const [companyId, setCompanyId] = useState("");
  const [rows, setRows] = useState<DesignationRow[]>([]);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const active = companyId || mine[0]?.id || "";

  useEffect(() => {
    if (!active) return;
    let live = true;
    apiGet<{ designations: DesignationRow[] }>(`/admin/designations?companyId=${active}`)
      .then((d) => live && setRows(d.designations))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [active, reload]);

  async function run(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
      setName("");
      setRenaming(null);
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (mine.length === 0) return null;
  const input = "rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800";
  return (
    <section className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-900">Designations</h2>
          <p className="mt-0.5 text-sm text-slate-500">One list of job titles shared by every company, offered when adding or editing people. Adding, renaming or hiding a title applies to all companies. Changing the list never changes what someone already has.</p>
        </div>
      </div>
      {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Add a designation" className={`${input} w-64`} />
        <button disabled={name.trim().length < 2} onClick={() => run(() => apiPost("/admin/designations", { companyId: active, name }))} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Add</button>
      </div>
      {rows.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">No designations yet. Add one above, or type one when adding or editing a person.</p>}
      <ul className="mt-4 divide-y divide-indigo-100">
        {rows.map((d) => (
          <li key={d.id} className={`flex flex-wrap items-center justify-between gap-2 py-2.5 ${d.isActive ? "" : "opacity-60"}`}>
            {renaming?.id === d.id ? (
              <span className="flex flex-wrap items-center gap-2">
                <input value={renaming.name} maxLength={80} onChange={(e) => setRenaming({ id: d.id, name: e.target.value })} className={`${input} w-64`} />
                <button onClick={() => run(() => apiPatch(`/admin/designations/${d.id}`, { name: renaming.name }))} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white">Save</button>
                <button onClick={() => setRenaming(null)} className="rounded-lg px-3 py-1.5 text-xs text-slate-500">Cancel</button>
              </span>
            ) : (
              <span className="text-sm text-slate-800">{d.name} <span className="text-xs text-slate-400">· {d.people} {d.people === 1 ? "person" : "people"}</span>{!d.isActive && <span className="ml-2 text-xs text-slate-400">(hidden from dropdowns)</span>}</span>
            )}
            {renaming?.id !== d.id && (
              <span className="flex gap-2">
                <button onClick={() => setRenaming({ id: d.id, name: d.name })} className="rounded-lg border border-indigo-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">Rename</button>
                <button onClick={() => run(() => apiPatch(`/admin/designations/${d.id}`, { isActive: !d.isActive }))} className="rounded-lg border border-indigo-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">{d.isActive ? "Hide" : "Show"}</button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// COMPANY ACCESS (Admin or top management): which companies each HR / Admin can act on besides their own.
// ---------------------------------------------------------------------------
type AccessPerson = { id: string; name: string; employeeCode: string | null; role: string; ownCompanyId: string; ownCompany: string; all: boolean; companyIds: string[] };
type AccessData = { ready: boolean; canGrantAll: boolean; companies: { id: string; name: string }[]; people: AccessPerson[] };

function AccessPanel() {
  const [data, setData] = useState<AccessData | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [draft, setDraft] = useState<Record<string, { all: boolean; companyIds: string[] }>>({});
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    apiGet<AccessData>("/admin/company-access")
      .then((d) => {
        if (!live) return;
        setData(d);
        setDraft({});
      })
      .catch(() => live && setAllowed(false)); // not top management: the section simply does not show
    return () => {
      live = false;
    };
  }, [reload]);

  if (!allowed || !data) return null;
  const view = (p: AccessPerson) => draft[p.id] ?? { all: p.all, companyIds: p.companyIds };

  async function save(p: AccessPerson) {
    setError("");
    setMsg("");
    try {
      await apiPost(`/admin/company-access/${p.id}`, view(p));
      setMsg(`Saved for ${p.name}.`);
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
      <h2 className="font-semibold text-slate-900">Company access</h2>
      <p className="mt-0.5 text-sm text-slate-500">HR and Admin always reach their own company. Tick more companies to let them act there too.{data.canGrantAll ? " Use “All companies” for top management." : ""} Changes apply when you press Save.</p>
      {!data.ready && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">Company access is not set up on this server yet (database update pending).</p>}
      {msg && <p className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</p>}
      {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="mt-4 divide-y divide-indigo-100">
        {data.people.map((p) => {
          const v = view(p);
          const dirty = v.all !== p.all || v.companyIds.slice().sort().join() !== p.companyIds.slice().sort().join();
          return (
            <div key={p.id} className="py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-900">{p.name} <span className="font-normal text-slate-400">{p.employeeCode} · {p.role} · {p.ownCompany}</span></p>
                <button disabled={!dirty || !data.ready || (!data.canGrantAll && p.all)} onClick={() => save(p)} className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Save</button>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5">
                {data.canGrantAll && <label className="flex items-center gap-1.5 text-sm font-medium text-slate-800">
                  <input type="checkbox" checked={v.all} onChange={(e) => setDraft((d) => ({ ...d, [p.id]: { ...view(p), all: e.target.checked } }))} /> All companies
                </label>}
                {!data.canGrantAll && p.all && <span className="text-sm text-slate-500">Has access to all companies (set by top management).</span>}
                {!v.all && (data.canGrantAll || !p.all) && data.companies.filter((c) => c.id !== p.ownCompanyId).map((c) => (
                  <label key={c.id} className="flex items-center gap-1.5 text-sm text-slate-600">
                    <input type="checkbox" checked={v.companyIds.includes(c.id)} onChange={(e) => setDraft((d) => ({ ...d, [p.id]: { ...view(p), companyIds: e.target.checked ? [...view(p).companyIds, c.id] : view(p).companyIds.filter((x) => x !== c.id) } }))} /> {c.name}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CompanyModal({ company, onClose, onDone }: { company: Company | null; onClose: () => void; onDone: (text: string) => void }) {
  const [name, setName] = useState(company?.name ?? "");
  const [legalName, setLegalName] = useState(company?.legalName ?? "");
  const [timezone, setTimezone] = useState(company?.timezone ?? "Asia/Kolkata");
  const [prefix, setPrefix] = useState(company?.employeeCodePrefix ?? "");
  const [active, setActive] = useState(company?.isActive ?? true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // The server refuses to deactivate your own or the pinned company; the switch just does not offer it.
  const canToggle = company !== null && !company.isYours && !company.isPinned;

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const body = { name, legalName, timezone, employeeCodePrefix: prefix };
      if (company) {
        await apiPost(`/companies/${company.id}`, { ...body, ...(canToggle ? { isActive: active } : {}) });
        onDone("Company updated.");
      } else {
        await apiPost("/companies", body);
        onDone("Company added. It starts empty; add its HR or Admin from Employees.");
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const input = "mt-1 w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800";
  return (
    <Modal
      title={company ? "Edit company" : "Add company"}
      subtitle={company ? undefined : "Creates the company record only. No people are added."}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Close</button>
          <button disabled={busy || name.trim().length < 2} onClick={save} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <label className="block text-sm text-slate-600">
          Company name
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={input} />
        </label>
        <label className="block text-sm text-slate-600">
          Legal name (optional)
          <input value={legalName} onChange={(e) => setLegalName(e.target.value)} className={input} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-slate-600">
            Employee code prefix
            <input value={prefix} maxLength={8} disabled={company !== null && company.canSetPrefix === false} onChange={(e) => setPrefix(e.target.value.toUpperCase())} placeholder="e.g. AVT" className={`${input} disabled:bg-slate-50`} />
          </label>
          <label className="block text-sm text-slate-600">
            Timezone
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} className={input} />
          </label>
        </div>
        <p className="text-xs text-slate-400">{company && company.canSetPrefix === false ? "Only an Admin or top management can change the prefix. " : ""}The prefix only affects new employee codes; existing IDs never change and two companies cannot share a prefix. The timezone decides what &ldquo;today&rdquo; means for attendance, so change it with care.</p>
        {company && (
          <label className={`flex items-center gap-2 text-sm ${canToggle ? "text-slate-600" : "text-slate-300"}`}>
            <input type="checkbox" checked={active} disabled={!canToggle} onChange={(e) => setActive(e.target.checked)} /> Active (an inactive company is closed to everyone in it)
          </label>
        )}
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}
