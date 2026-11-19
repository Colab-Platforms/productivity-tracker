"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { useSupervisorGate } from "../../_routing/useRoleGate";
import FilterBar from "../../_filters/FilterBar";
import { filterQuery, useFilterOptions, useHrFilters } from "../../_filters/useHrFilters";

// ---------------------------------------------------------------------------
// ALL EMPLOYEES (Productivity Supervisor). A read-only directory of every active person in every company, narrowed by the shared filters: name or
// ID, company, project, reporting manager, department, designation. It shows who people are and where they sit; productivity, attendance and tasks
// are on the monitoring pages. No edit, add, deactivate or reporting-line control exists here, and the server refuses them anyway.
// ---------------------------------------------------------------------------

type Row = { userId: string; name: string; employeeCode: string | null; designation: string | null; status: string; company: string; companyId: string; reportingManager: string | null; projects: string[]; departments: string[] };
type Payload = { scope: { orgTotal: number; filteredTotal: number }; rows: Row[] };

const PAGE = 50;
const cell = "px-3 py-2.5 align-top text-sm";

export default function AllEmployeesPage() {
  const { allowed } = useSupervisorGate();
  const { filters, update, clear, ready } = useHrFilters();
  const { options } = useFilterOptions(filters, update, ready && allowed, true);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);

  const query = useMemo(() => filterQuery(filters), [filters]);
  useEffect(() => {
    if (!ready || !allowed) return;
    let live = true;
    const t = setTimeout(() => {
      apiGet<Payload>(`/supervisor/employees${query ? `?${query}` : ""}`)
        .then((d) => { if (live) { setData(d); setError(""); setPage(0); } })
        .catch((e: Error) => live && setError(e.message));
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [query, ready, allowed]);

  if (!allowed) return null;
  const rows = data?.rows ?? [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const multi = (options?.companies.length ?? 0) > 1;

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">Everyone in every company you monitor. View only: this list cannot change anyone&apos;s details, manager or status.</p>
      <FilterBar
        filters={filters}
        update={update}
        clear={clear}
        options={options}
        show={{ search: true, company: true, project: true, manager: true, department: true, designation: true }}
        counts={data ? { filtered: data.scope.filteredTotal, total: data.scope.orgTotal } : null}
        searchPlaceholder="Search name or employee ID"
      />

      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {!data && !error && <div className="skeleton h-64" aria-busy="true" />}

      {data && (
        <section className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]" aria-label="Employees">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left">
              <thead className="bg-[#F3F7F6] text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">Employee</th>
                  <th className="px-3 py-2 font-medium">ID</th>
                  {multi && <th className="px-3 py-2 font-medium">Company</th>}
                  <th className="px-3 py-2 font-medium">Designation</th>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Department</th>
                  <th className="px-3 py-2 font-medium">Reporting manager</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-indigo-50">
                {shown.length === 0 && (
                  <tr><td colSpan={multi ? 8 : 7} className="px-3 py-8 text-center text-sm text-slate-400">No employees match these filters.</td></tr>
                )}
                {shown.map((r) => (
                  <tr key={r.userId} data-testid="employee-row">
                    <td className={`${cell} font-medium text-slate-900`}>{r.name}</td>
                    <td className={`${cell} tabular-nums text-slate-600`}>{r.employeeCode ?? "—"}</td>
                    {multi && <td className={`${cell} text-slate-700`}>{r.company}</td>}
                    <td className={`${cell} text-slate-700`}>{r.designation ?? "—"}</td>
                    <td className={`${cell} text-slate-700`}>{r.projects.length ? r.projects.join(", ") : "—"}</td>
                    <td className={`${cell} text-slate-700`}>{r.departments.length ? r.departments.join(", ") : "—"}</td>
                    <td className={`${cell} text-slate-700`}>{r.reportingManager ?? "—"}</td>
                    <td className={cell}>
                      <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${r.status === "ACTIVE" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{r.status === "ACTIVE" ? "Active" : "Invited"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > PAGE && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-indigo-50 px-3 py-2 text-sm text-slate-600">
              <span>Showing {page * PAGE + 1}–{Math.min(rows.length, page * PAGE + PAGE)} of {rows.length}</span>
              <span className="flex gap-2">
                <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-indigo-100 px-3 py-1 disabled:opacity-40">Previous</button>
                <button type="button" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-indigo-100 px-3 py-1 disabled:opacity-40">Next</button>
              </span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
