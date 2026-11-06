"use client";

import { useEffect, useState } from "react";
import { roleLabel } from "@/lib/roles";
import { apiGet } from "@/lib/api";
import { useMe } from "../layout";
import { Modal } from "../_employees/Modal";

// ---------------------------------------------------------------------------
// AUDIT LOG
// A permanent, read-only record of who did what, to which record, and when. HR and
// Admin read their own company's history. Nothing here can edit or delete an entry,
// and the database itself refuses to. Passwords, tokens and file contents are never
// stored, so they can never appear here.
// ---------------------------------------------------------------------------

type Person = { id: string; name: string; employeeCode: string | null; role?: string | null };
type Item = {
  id: string;
  at: string;
  actor: Person | null;
  module: string;
  action: string;
  summary: string;
  recordType: string | null;
  recordId: string | null;
  target: Person | null;
  method: string;
  path: string;
  hasChanges: boolean;
};
type List = { timezone: string; total: number; page: number; pageSize: number; pages: number; items: Item[] };
type Filters = { timezone: string; modules: string[]; actions: string[]; people: { id: string; name: string; employeeCode: string | null }[] };
type Detail = Item & { status: number; before: Record<string, unknown> | null; after: Record<string, unknown> | null; request: unknown; ip: string | null; timezone: string };

const ACTION_LABEL: Record<string, string> = {
  CREATE: "Created", UPDATE: "Updated", DELETE: "Deleted", APPROVE: "Approved", REJECT: "Rejected", SUBMIT: "Submitted",
  CANCEL: "Cancelled", LOGIN: "Signed in", UPLOAD: "Uploaded", PASSWORD: "Password", PERMISSION: "Permission change", CLOCK: "Clock", OTHER: "Other",
};
const ACTION_STYLE: Record<string, string> = {
  CREATE: "bg-emerald-50 text-emerald-700", UPDATE: "bg-indigo-50 text-indigo-700", DELETE: "bg-red-50 text-red-600",
  APPROVE: "bg-emerald-50 text-emerald-700", REJECT: "bg-red-50 text-red-600", SUBMIT: "bg-sky-50 text-sky-700",
  CANCEL: "bg-slate-100 text-slate-600", LOGIN: "bg-slate-100 text-slate-600", UPLOAD: "bg-sky-50 text-sky-700",
  PASSWORD: "bg-amber-50 text-amber-700", PERMISSION: "bg-violet-50 text-violet-700", CLOCK: "bg-slate-100 text-slate-600", OTHER: "bg-slate-100 text-slate-600",
};

const when = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(iso));

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "empty";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
const label = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

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
  return { data: res?.data ?? null, error: res && res.path === path ? (res.error ?? "") : "", loading: path !== null && res?.path !== path };
}

export default function AuditLogsPage() {
  const me = useMe();
  const allowed = me?.role === "HR" || me?.role === "ADMIN";

  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [module, setModule] = useState("");
  const [action, setAction] = useState("");
  const [actorId, setActorId] = useState("");
  const [targetUserId, setTargetUserId] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [reload, setReload] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  // Search waits for a pause in typing instead of querying on every key.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (debounced) qs.set("q", debounced);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (module) qs.set("module", module);
  if (action) qs.set("action", action);
  if (actorId) qs.set("actorId", actorId);
  if (targetUserId) qs.set("targetUserId", targetUserId);

  const filters = useApi<Filters>(allowed ? "/audit-logs/filters" : null, 0);
  const list = useApi<List>(allowed ? `/audit-logs?${qs.toString()}` : null, reload);
  const tz = list.data?.timezone ?? filters.data?.timezone ?? "Asia/Kolkata";

  const changed = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPage(1);
  };
  const anyFilter = q || from || to || module || action || actorId || targetUserId;

  if (me && !allowed) {
    return (
      <div className="p-8">
        <p className="rounded-2xl bg-white p-6 text-sm text-slate-600 shadow-[var(--shadow-card)]">The audit log is only available to HR and Admin.</p>
      </div>
    );
  }

  const card = "rounded-2xl bg-white shadow-[var(--shadow-card)]";
  const sel = "mt-1 block w-full rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800";
  const d = list.data;
  const firstRow = d && d.total > 0 ? (d.page - 1) * d.pageSize + 1 : 0;
  const lastRow = d ? Math.min(d.total, d.page * d.pageSize) : 0;

  return (
    <div className="page-fluid space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Audit log</h1>
        <p className="mt-1 text-sm text-slate-500">
          A permanent record of who did what, to which record, and when. Entries cannot be edited or deleted. Passwords and file contents are never recorded.
        </p>
      </div>

      <section className={`${card} p-5`}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs text-slate-500 lg:col-span-2">
            Search
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Person, employee ID, or what happened" className={sel} />
          </label>
          <label className="text-xs text-slate-500">
            From
            <input type="date" value={from} onChange={(e) => changed(setFrom)(e.target.value)} className={sel} />
          </label>
          <label className="text-xs text-slate-500">
            To
            <input type="date" value={to} min={from || undefined} onChange={(e) => changed(setTo)(e.target.value)} className={sel} />
          </label>
          <label className="text-xs text-slate-500">
            Module
            <select value={module} onChange={(e) => changed(setModule)(e.target.value)} className={sel}>
              <option value="">All modules</option>
              {filters.data?.modules.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500">
            Action type
            <select value={action} onChange={(e) => changed(setAction)(e.target.value)} className={sel}>
              <option value="">All actions</option>
              {filters.data?.actions.map((a) => <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500">
            Done by
            <select value={actorId} onChange={(e) => changed(setActorId)(e.target.value)} className={sel}>
              <option value="">Anyone</option>
              {filters.data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.employeeCode ? ` (${p.employeeCode})` : ""}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500">
            About employee
            <select value={targetUserId} onChange={(e) => changed(setTargetUserId)(e.target.value)} className={sel}>
              <option value="">Any employee</option>
              {filters.data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.employeeCode ? ` (${p.employeeCode})` : ""}</option>)}
            </select>
          </label>
        </div>
        {anyFilter && (
          <button
            onClick={() => { setQ(""); setDebounced(""); setFrom(""); setTo(""); setModule(""); setAction(""); setActorId(""); setTargetUserId(""); setPage(1); }}
            className="mt-3 rounded-xl px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
          >
            Clear filters
          </button>
        )}
      </section>

      <section className={`${card} p-5`}>
        {list.error && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>Couldn&apos;t load the audit log: {list.error}</span>
            <button onClick={() => setReload((n) => n + 1)} className="shrink-0 rounded-lg bg-white px-3 py-1 text-xs font-medium ring-1 ring-red-200 hover:bg-red-100">Retry</button>
          </div>
        )}

        {!d && !list.error && (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-12" />)}
          </div>
        )}

        {d && d.items.length === 0 && (
          <p className="rounded-xl bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
            {anyFilter ? "No entries match these filters." : "Nothing has been recorded yet."}
          </p>
        )}

        {d && d.items.length > 0 && (
          <>
            <div className={`overflow-x-auto ${list.loading ? "opacity-60" : ""}`}>
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead>
                  <tr className="text-xs text-slate-400">
                    <th className="py-2 font-medium">When</th>
                    <th className="py-2 font-medium">Who</th>
                    <th className="py-2 font-medium">Action</th>
                    <th className="py-2 font-medium">Module</th>
                    <th className="py-2 font-medium">What happened</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-indigo-100">
                  {d.items.map((i) => (
                    <tr key={i.id} onClick={() => setOpenId(i.id)} className="cursor-pointer align-top hover:bg-indigo-50/40">
                      <td className="whitespace-nowrap py-3 pr-3 text-slate-600">{when(i.at, tz)}</td>
                      <td className="py-3 pr-3">
                        <p className="font-medium text-slate-900">{i.actor?.name ?? "System"}</p>
                        {i.actor?.employeeCode && <p className="text-xs text-slate-400">{i.actor.employeeCode}</p>}
                      </td>
                      <td className="py-3 pr-3">
                        <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${ACTION_STYLE[i.action] ?? ACTION_STYLE.OTHER}`}>{ACTION_LABEL[i.action] ?? i.action}</span>
                      </td>
                      <td className="py-3 pr-3 text-slate-700">{i.module}</td>
                      <td className="py-3 pr-3 text-slate-700">
                        {i.summary}
                        {i.target && i.target.id !== i.actor?.id && <span className="text-slate-400"> · {i.target.name}</span>}
                        {i.hasChanges && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">before/after</span>}
                      </td>
                      <td className="py-3 text-right text-xs text-indigo-600">Details</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
              <p>Showing {firstRow}–{lastRow} of {d.total}</p>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-xs">
                  Per page
                  <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className="rounded-lg border border-indigo-100 bg-white px-2 py-1 text-sm">
                    {[25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <button disabled={d.page <= 1} onClick={() => setPage(d.page - 1)} className="rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40">Previous</button>
                <span className="text-xs">Page {d.page} of {d.pages}</span>
                <button disabled={d.page >= d.pages} onClick={() => setPage(d.page + 1)} className="rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40">Next</button>
              </div>
            </div>
          </>
        )}
      </section>

      {openId && <DetailModal id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function DetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [reload, setReload] = useState(0);
  const { data: d, error } = useApi<Detail>(`/audit-logs/${id}`, reload);
  const tz = d?.timezone ?? "Asia/Kolkata";
  const keys = d ? [...new Set([...Object.keys(d.before ?? {}), ...Object.keys(d.after ?? {})])] : [];
  const meta: [string, string | null][] = d
    ? [
        ["When", when(d.at, tz)],
        ["Done by", d.actor ? `${d.actor.name}${d.actor.employeeCode ? ` (${d.actor.employeeCode})` : ""}${d.actor.role ? ` · ${roleLabel(d.actor.role)}` : ""}` : "System"],
        ["Module", d.module],
        ["Action", ACTION_LABEL[d.action] ?? d.action],
        ["About employee", d.target ? `${d.target.name}${d.target.employeeCode ? ` (${d.target.employeeCode})` : ""}` : null],
        ["Record", d.recordType ? `${d.recordType}${d.recordId ? ` · ${d.recordId}` : ""}` : null],
        ["Request", `${d.method} ${d.path} → ${d.status}`],
        ["IP address", d.ip],
      ]
    : [];

  return (
    <Modal title={d?.summary ?? "Audit entry"} subtitle={d ? `${d.module} · ${ACTION_LABEL[d.action] ?? d.action}` : undefined} onClose={onClose} width="max-w-2xl">
      {error && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error} <button onClick={() => setReload((n) => n + 1)} className="ml-2 font-medium underline">Retry</button>
        </p>
      )}
      {!d && !error && <div className="skeleton h-40" aria-busy="true" />}
      {d && (
        <div className="space-y-5">
          <dl className="divide-y divide-indigo-100 rounded-2xl border border-indigo-100 text-sm">
            {meta.filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-4 px-4 py-2.5">
                <dt className="text-slate-500">{k}</dt>
                <dd className="break-all text-right font-medium text-slate-900">{v}</dd>
              </div>
            ))}
          </dl>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">What changed</p>
            {keys.length === 0 ? (
              <p className="mt-1 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">
                No original/new values were captured for this entry (it may predate this feature, or the action doesn&apos;t change a stored value). The request details below show what was sent.
              </p>
            ) : (
              <div className="mt-2 overflow-hidden rounded-2xl border border-indigo-100">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-400">
                    <tr>
                      <th className="px-4 py-2 font-medium">Field</th>
                      <th className="px-4 py-2 font-medium">Original</th>
                      <th className="px-4 py-2 font-medium">New</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-indigo-100">
                    {keys.map((k) => (
                      <tr key={k}>
                        <td className="px-4 py-2 text-slate-500">{label(k)}</td>
                        <td className="break-all px-4 py-2 text-red-600">{show(d.before?.[k])}</td>
                        <td className="break-all px-4 py-2 font-medium text-emerald-700">{show(d.after?.[k])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {d.request != null && Object.keys(d.request as object).length > 0 && (
            <details className="rounded-2xl border border-indigo-100 px-4 py-3 text-sm">
              <summary className="cursor-pointer text-slate-600">Request details (as sent, with secrets removed)</summary>
              <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-slate-50 p-3 text-xs text-slate-700">{JSON.stringify(d.request, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </Modal>
  );
}
