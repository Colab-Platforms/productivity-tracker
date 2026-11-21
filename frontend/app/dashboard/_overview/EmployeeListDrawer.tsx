"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiGet } from "@/lib/api";

// ---------------------------------------------------------------------------
// The employee list behind a summary card (Total / Active / Inactive / Not started yet), as a side drawer so the dashboard stays visible. The server
// filters, searches, sorts and pages (GET /admin/users/page, the same people filter the card counts use), so this never loads every employee.
// ---------------------------------------------------------------------------

export type DrawerView = "ALL" | "ACTIVE" | "INACTIVE" | "NOT_STARTED";
type Row = { id: string; name: string; employeeCode: string | null; designation: string | null; status: string; onboardingStatus: string | null; dateOfJoining: string | null; company: string | null; departments: { id: string; name: string }[] };
type Page = { view: DrawerView; viewTotal: number; total: number; page: number; pages: number; pageSize: number; rows: Row[]; counts: { byStatus: Record<string, number> } };

const TITLE: Record<DrawerView, string> = { ALL: "Total employees", ACTIVE: "Active employees", INACTIVE: "Inactive employees", NOT_STARTED: "Not started yet" };
const LABEL: Record<string, string> = { ACTIVE: "Active", EXITED: "Exited", TERMINATED: "Terminated", ABSCONDED: "Absconded", SUSPENDED: "Suspended (older status)", INVITED: "Invited (older status)", CANDIDATE: "Candidate (older status)" };
const CHIP: Record<string, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700", EXITED: "bg-slate-100 text-slate-600", TERMINATED: "bg-rose-50 text-rose-700", ABSCONDED: "bg-orange-50 text-orange-700",
  SUSPENDED: "bg-amber-50 text-amber-700", INVITED: "bg-sky-50 text-sky-700", CANDIDATE: "bg-sky-50 text-sky-700",
};
const SORTS: [string, string, string, string][] = [["name-asc", "Name A to Z", "name", "asc"], ["name-desc", "Name Z to A", "name", "desc"], ["joined-desc", "Joined: newest first", "joined", "desc"], ["joined-asc", "Joined: oldest first", "joined", "asc"]];
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "Not recorded");
const field = "h-10 rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-700";

export default function EmployeeListDrawer({ view, qs, departments, onClose, onProfile, suspended }: {
  view: DrawerView;
  /** the dashboard's own filters (company, project, manager, designation), already in query-string form */
  qs: string;
  departments: { id: string; name: string }[];
  onClose: () => void;
  onProfile: (id: string) => void;
  /** true while a profile dialog is open on top: Escape then belongs to that dialog */
  suspended?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const suspendedRef = useRef(!!suspended);
  useEffect(() => { closeRef.current = onClose; suspendedRef.current = !!suspended; });

  const [search, setSearch] = useState("");
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState("");
  const [dept, setDept] = useState("");
  const [sort, setSort] = useState("name-asc");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  // Escape closes (unless a profile dialog is open above); the page behind stops scrolling; focus moves in once and returns to the card on close.
  useEffect(() => {
    const previous = document.body.style.overflow;
    const opener = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !suspendedRef.current) closeRef.current(); };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = previous; opener?.focus?.(); };
  }, []);

  // search is sent after a short pause so typing does not fire a request per letter
  useEffect(() => { const t = setTimeout(() => { setSearch(typed.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [typed]);

  const [, , sk, sd] = SORTS.find((s) => s[0] === sort) ?? SORTS[0];
  const query = `employeesOnly=1&view=${view}${status ? `&status=${status}` : ""}${dept ? `&departmentId=${dept}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}&sort=${sk}&dir=${sd}&page=${page}&pageSize=20${qs ? `&${qs}` : ""}`;
  useEffect(() => {
    let live = true;
    apiGet<Page>(`/admin/users/page?${query}`)
      .then((r) => { if (live) { setData(r); setError(""); } })
      .catch((e: Error) => { if (live) setError(e.message || "Could not load the employees."); });
    return () => { live = false; };
  }, [query, tick]);

  const reset = useCallback((fn: () => void) => { fn(); setPage(1); }, []);
  const by = data?.counts.byStatus ?? {};
  const statusOptions = view === "ALL" ? ["ACTIVE", "EXITED", "TERMINATED", "ABSCONDED", "SUSPENDED", "INVITED", "CANDIDATE"].filter((s) => ["ACTIVE", "EXITED", "TERMINATED", "ABSCONDED"].includes(s) || (by[s] ?? 0) > 0) : [];
  const inactiveChips = ["EXITED", "TERMINATED", "ABSCONDED", ...((by.SUSPENDED ?? 0) > 0 ? ["SUSPENDED"] : [])];
  const first = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.page * data.pageSize, data.total) : 0;
  const loading = !data && !error;

  const profile = (r: Row) => (
    <button type="button" onClick={() => onProfile(r.id)} className="inline-flex h-8 items-center rounded-lg border border-indigo-100 px-3 text-xs font-medium text-indigo-700 hover:bg-[var(--brand-50)]" aria-label={`View profile of ${r.name}`}>View Profile</button>
  );

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/40" onClick={() => closeRef.current()} aria-hidden="true" data-testid="drawer-backdrop" />
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="emp-drawer-title" data-testid="employee-drawer" className="relative flex h-full w-full max-w-4xl flex-col bg-white shadow-xl outline-none">
        <div className="flex items-start justify-between gap-3 border-b border-indigo-100 px-5 py-4">
          <div>
            <h2 id="emp-drawer-title" className="text-lg font-semibold text-slate-900">{TITLE[view]}</h2>
            <p className="text-sm text-slate-500" data-testid="drawer-count" aria-live="polite">{data ? `${data.viewTotal} ${data.viewTotal === 1 ? "employee" : "employees"} in this group` : "Loading…"}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 hover:bg-[var(--brand-50)]">
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
          </button>
        </div>

        <div className="space-y-3 border-b border-indigo-100 px-5 py-3">
          {view === "INACTIVE" && (
            <div role="group" aria-label="Inactive category" className="flex flex-wrap gap-1.5" data-testid="inactive-filters">
              {[["", "All inactive", data?.viewTotal], ...inactiveChips.map((s) => [s, LABEL[s].replace(" (older status)", " (older)"), by[s] ?? 0])].map(([v, l, n]) => (
                <button key={String(v)} type="button" aria-pressed={status === v} data-testid={`inactive-${String(v || "all").toLowerCase()}`} onClick={() => reset(() => setStatus(String(v)))}
                  className={`h-8 rounded-full border px-3 text-xs font-medium ${status === v ? "border-indigo-600 bg-indigo-600 text-white" : "border-indigo-100 bg-white text-slate-600 hover:bg-[var(--brand-50)]"}`}>
                  {l}<span className={`ml-1.5 tabular-nums ${status === v ? "text-white/80" : "text-slate-400"}`}>{n ?? "…"}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <input aria-label="Search by name or employee ID" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search name or employee ID" className={`${field} min-w-[12rem] flex-1`} />
            {departments.length > 0 && (
              <select aria-label="Department" value={dept} onChange={(e) => reset(() => setDept(e.target.value))} className={`${field} max-w-[12rem]`}>
                <option value="">All departments</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}
            {statusOptions.length > 0 && (
              <select aria-label="Employment status" value={status} onChange={(e) => reset(() => setStatus(e.target.value))} className={field}>
                <option value="">All statuses</option>
                {statusOptions.map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
              </select>
            )}
            <select aria-label="Sort by" value={sort} onChange={(e) => reset(() => setSort(e.target.value))} className={field}>
              {SORTS.map((s) => <option key={s[0]} value={s[0]}>{s[1]}</option>)}
            </select>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3" data-testid="drawer-body">
          {error && (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {error}
              <button type="button" onClick={() => { setError(""); setTick((n) => n + 1); }} className="rounded-lg bg-white px-3 py-1 text-xs font-medium ring-1 ring-rose-200">Retry</button>
            </div>
          )}
          {loading && <div className="space-y-2" aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12" />)}</div>}
          {data && data.rows.length === 0 && <p className="py-12 text-center text-sm text-slate-500" data-testid="drawer-empty">No employees match.</p>}
          {data && data.rows.length > 0 && (
            <>
              <table className="hidden w-full text-left text-sm sm:table" data-testid="drawer-table">
                <thead className="text-xs uppercase tracking-wide text-slate-400">
                  <tr><th className="py-2 pr-3 font-medium">Employee</th><th className="py-2 pr-3 font-medium">ID</th><th className="py-2 pr-3 font-medium">Department</th><th className="py-2 pr-3 font-medium">Designation</th><th className="py-2 pr-3 font-medium">Status</th><th className="py-2 pr-3 font-medium">Joined</th><th className="py-2 font-medium"><span className="sr-only">Actions</span></th></tr>
                </thead>
                <tbody className="divide-y divide-indigo-50">
                  {data.rows.map((r) => (
                    <tr key={r.id} data-testid="drawer-row">
                      <td className="py-2.5 pr-3"><button type="button" onClick={() => onProfile(r.id)} className="text-left font-medium text-slate-900 hover:text-indigo-700 hover:underline">{r.name}</button></td>
                      <td className="py-2.5 pr-3 text-slate-600">{r.employeeCode ?? "—"}</td>
                      <td className="py-2.5 pr-3 text-slate-600">{r.departments.map((d) => d.name).join(", ") || "—"}</td>
                      <td className="py-2.5 pr-3 text-slate-600">{r.designation?.trim() || <span className="text-slate-400">Not assigned</span>}</td>
                      <td className="py-2.5 pr-3"><span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP[r.status] ?? "bg-slate-100 text-slate-600"}`}>{LABEL[r.status]?.replace(" (older status)", " (older)") ?? r.status}</span></td>
                      <td className="py-2.5 pr-3 text-slate-600">{fmt(r.dateOfJoining)}</td>
                      <td className="py-2.5 text-right">{profile(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="space-y-2 sm:hidden" data-testid="drawer-cards">
                {data.rows.map((r) => (
                  <li key={r.id} className="rounded-xl border border-indigo-100 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <button type="button" onClick={() => onProfile(r.id)} className="min-w-0 text-left font-medium text-slate-900">{r.name}</button>
                      <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${CHIP[r.status] ?? "bg-slate-100 text-slate-600"}`}>{LABEL[r.status]?.replace(" (older status)", " (older)") ?? r.status}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">{r.employeeCode ?? "—"} · {r.designation?.trim() || "Designation not assigned"}</p>
                    <p className="text-xs text-slate-500">{r.departments.map((d) => d.name).join(", ") || "No department"} · Joined {fmt(r.dateOfJoining)}</p>
                    <div className="mt-2">{profile(r)}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-indigo-100 px-5 py-3 text-sm text-slate-600">
          <span data-testid="drawer-range">{data && data.total > 0 ? `Showing ${first}–${last} of ${data.total}` : data ? "0 results" : ""}</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={!data || data.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="h-9 rounded-xl border border-indigo-100 px-3 text-sm hover:bg-[var(--brand-50)] disabled:opacity-40">Previous</button>
            <span className="tabular-nums">Page {data?.page ?? 1} of {data?.pages ?? 1}</span>
            <button type="button" disabled={!data || data.page >= data.pages} onClick={() => setPage((p) => p + 1)} className="h-9 rounded-xl border border-indigo-100 px-3 text-sm hover:bg-[var(--brand-50)] disabled:opacity-40">Next</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
