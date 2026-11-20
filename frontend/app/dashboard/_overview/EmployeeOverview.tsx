"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { todayIso } from "@/lib/time";
import { plural } from "@/lib/plural";
import { roleLabel } from "@/lib/roles";
import { Modal } from "../_employees/Modal";
import Avatar from "../_photos/Avatar";
import FilterBar from "../_filters/FilterBar";
import { filterQuery, useFilterOptions, useHrFilters } from "../_filters/useHrFilters";
import { KpiCard, Panel } from "../_dashboard/widgets";
import { STATUS_VIEW_LABEL, byCompany, byDepartment, byDesignation, byManager, directReports, inView, matchesSearch, parseStatusView, sortPeople, statusCounts, tenure, viewCount, type Bucket, type OverviewPerson, type SortKey, type StatusView } from "./stats";

// ---------------------------------------------------------------------------
// EMPLOYEE OVERVIEW (Admin). A read-only picture of the workforce: how many people, who is active, where they sit (company, team, designation,
// reporting manager) and a searchable directory with a profile view per person. Adding, editing, importing and access changes stay in
// User Management (/dashboard/employees); this page only links there. The numbers are counted in ./stats from the same list /admin/users returns
// for User Management, so the two pages can never disagree about who exists. The shared filter bar narrows everything on the page.
// ---------------------------------------------------------------------------

type Res = { users: OverviewPerson[]; scope?: { orgTotal: number; filteredTotal: number } };

const STATUS_CHIP: Record<string, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700",
  INVITED: "bg-sky-50 text-sky-700",
  CANDIDATE: "bg-sky-50 text-sky-700",
  SUSPENDED: "bg-amber-50 text-amber-700",
  EXITED: "bg-slate-100 text-slate-600",
};
const STATUS_LABEL: Record<string, string> = { ACTIVE: "Active", INVITED: "Invited", CANDIDATE: "Candidate", SUSPENDED: "Suspended", EXITED: "Exited" };
const PAGE_SIZE = 20;

const icon = (d: string) => (
  <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const ICONS = {
  all: icon("M2.6 16c0-2.6 2.2-4.3 4.9-4.3s4.9 1.7 4.9 4.3M7.5 9.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM14.6 11.9c1.6.5 2.8 1.9 2.8 4.1M13.4 5.1a2.4 2.4 0 0 1 0 4.4"),
  active: icon("M4 10.5l4 4 8-9"),
  inactive: icon("M5 5l10 10M15 5L5 15"),
  pending: icon("M10 5v5l3 2M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14z"),
};

function SortTh({ label, k, sort, setSort, setPage, className }: { label: string; k: SortKey; sort: { key: SortKey; dir: "asc" | "desc" }; setSort: (s: { key: SortKey; dir: "asc" | "desc" }) => void; setPage: (n: number) => void; className: string }) {
  const on = sort.key === k;
  return (
    <th className={className} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => { setSort({ key: k, dir: on && sort.dir === "asc" ? "desc" : "asc" }); setPage(1); }} className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-indigo-700" title={`Sort by ${label.toLowerCase()}`}>
        {label}<span aria-hidden="true" className={on ? "text-indigo-600" : "text-slate-300"}>{on ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

function Chip({ status }: { status: string }) {
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CHIP[status] ?? "bg-slate-100 text-slate-600"}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** A ranked list of horizontal bars. Shows the top rows and a toggle for the rest, so a long list never stretches the card. */
function Bars({ rows, total, empty, limit = 8 }: { rows: Bucket[]; total: number; empty: string; limit?: number }) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-slate-400">{empty}</p>;
  const shown = all ? rows : rows.slice(0, limit);
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div>
      <ul className="space-y-2.5">
        {shown.map((r) => (
          <li key={r.key || r.label}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-slate-700" title={r.label}>{r.label}</span>
              <span className="shrink-0 tabular-nums text-slate-500">
                <span className="font-semibold text-slate-900">{r.count}</span>
                {total > 0 && <span className="ml-1 text-xs">({Math.round((r.count / total) * 100)}%)</span>}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--brand-50)]" role="presentation">
              <div className="h-full rounded-full bg-indigo-600" style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-3 text-xs font-medium text-indigo-700 hover:underline">
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null);
const fmtStamp = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : null);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-slate-800 [overflow-wrap:anywhere]">{children ?? <span className="text-slate-400">Not recorded</span>}</dd>
    </div>
  );
}

function Profile({ p, everyone, onClose, onOpen }: { p: OverviewPerson; everyone: OverviewPerson[]; onClose: () => void; onOpen: (id: string) => void }) {
  const reports = directReports(everyone, p.id);
  const stay = tenure(p.dateOfJoining, todayIso());
  return (
    <Modal
      title="Employee profile"
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <>
          <button type="button" onClick={onClose} className="h-10 rounded-xl border border-indigo-100 px-4 text-sm font-medium text-slate-700 hover:bg-[var(--brand-50)]">Close</button>
          <Link href={`/dashboard/employees?q=${encodeURIComponent(p.employeeCode ?? p.name)}`} className="inline-flex h-10 items-center rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700">
            Manage in User Management
          </Link>
        </>
      }
    >
      <div className="flex items-center gap-4">
        <Avatar userId={p.id} name={p.name} photoAt={p.photoAt} size={64} />
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold text-slate-900">{p.name}</p>
          <p className="truncate text-sm text-slate-500">{p.designation?.trim() || "Designation not assigned"}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Chip status={p.status} />
            <span className="rounded-full bg-[var(--brand-50)] px-2 py-0.5 text-[11px] font-medium text-indigo-700">{roleLabel(p.role)}</span>
          </div>
        </div>
      </div>

      <dl className="mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <Field label="Employee ID">{p.employeeCode}</Field>
        <Field label="Company">{p.company}</Field>
        <Field label="Work email">{p.email}</Field>
        <Field label="Phone">{p.phone}</Field>
        <Field label="Department / teams">{p.teams.length ? p.teams.map((t) => t.name).join(", ") : null}</Field>
        <Field label="Shift">{p.shift?.name}</Field>
        <Field label="Reports to">{p.reportsTo?.name}</Field>
        <Field label="Joined">{p.dateOfJoining ? `${fmtDate(p.dateOfJoining)}${stay ? ` · ${stay}` : ""}` : null}</Field>
        <Field label="Tracker access">{p.trackerAccessEnabled ? "Enabled" : "Not enabled"}</Field>
        <Field label="Last sign-in">{fmtStamp(p.lastLoginAt)}</Field>
      </dl>

      <div className="mt-5 border-t border-indigo-50 pt-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Direct reports ({reports.length})</p>
        {reports.length === 0 ? (
          <p className="mt-1.5 text-sm text-slate-400">Nobody reports to {p.name.split(" ")[0]} in the people you can see.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {reports.slice(0, 24).map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => onOpen(r.id)} className="rounded-full border border-indigo-100 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-[var(--brand-50)]">
                  {r.name}
                </button>
              </li>
            ))}
            {reports.length > 24 && <li className="px-1 py-1 text-xs text-slate-400">+{reports.length - 24} more</li>}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// The status chips under the cards. Cards pick a group (Total, Active, Inactive, Not started); these also split the groups, so Suspended and Exited (and
// Invited and Candidates) can be told apart. Every number is viewCount(), which is exactly the length of the list that chip shows.
const CHIP_ORDER: { key: StatusView; label: string; sub?: boolean }[] = [
  { key: "ALL", label: "All" },
  { key: "ACTIVE", label: "Active" },
  { key: "INACTIVE", label: "Inactive" },
  { key: "SUSPENDED", label: "Suspended", sub: true },
  { key: "EXITED", label: "Exited", sub: true },
  { key: "NOT_STARTED", label: "Not started yet" },
  { key: "INVITED", label: "Invited", sub: true },
  { key: "CANDIDATE", label: "Candidates", sub: true },
];
const DEFAULT_VIEW: StatusView = "ACTIVE";

export default function EmployeeOverview() {
  const { filters, update, clear, ready } = useHrFilters();
  const { options } = useFilterOptions(filters, update, ready);
  const [res, setRes] = useState<Res | null>(null);
  const [error, setError] = useState("");
  // The chosen status lives in the address (?show=inactive), so Back, refresh and a shared link all give the same list. Read when the page first renders.
  const [view, setViewState] = useState<StatusView>(() => (typeof window === "undefined" ? DEFAULT_VIEW : parseStatusView(new URLSearchParams(window.location.search).get("show")) ?? DEFAULT_VIEW));
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const directoryRef = useRef<HTMLDivElement>(null);
  const choose = useCallback((v: StatusView) => {
    setViewState(v);
    setPage(1);
    const url = new URL(window.location.href);
    if (v === DEFAULT_VIEW) url.searchParams.delete("show");
    else url.searchParams.set("show", v.toLowerCase());
    window.history.pushState(null, "", url.pathname + url.search);
    requestAnimationFrame(() => directoryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);
  useEffect(() => {
    const back = () => { setViewState(parseStatusView(new URLSearchParams(window.location.search).get("show")) ?? DEFAULT_VIEW); setPage(1); };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  // Same list and same filter names as User Management. The status view is applied here, not on the server, so the four tiles always show the
  // whole split for the chosen company / project / manager.
  const qs = filterQuery({ ...filters, status: "", q: "" }, { company: "companyId" });
  useEffect(() => {
    if (!ready) return;
    let live = true;
    apiGet<Res>(`/admin/users${qs ? `?${qs}` : ""}`)
      .then((r) => {
        if (!live) return;
        setRes(r);
        setError("");
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [qs, ready]);

  const everyone = useMemo(() => res?.users ?? [], [res]);
  const counts = useMemo(() => statusCounts(everyone), [everyone]);
  const scoped = useMemo(() => inView(everyone, view), [everyone, view]);
  const companies = useMemo(() => byCompany(scoped), [scoped]);
  const departments = useMemo(() => byDepartment(scoped), [scoped]);
  const designations = useMemo(() => byDesignation(scoped), [scoped]);
  const managers = useMemo(() => byManager(scoped), [scoped]);
  const directory = useMemo(() => sortPeople(scoped.filter((p) => matchesSearch(p, q)), sort.key, sort.dir), [scoped, q, sort]);
  const showWhen = view !== "ACTIVE" && view !== "ALL"; // inactive / not-started lists also show when they joined and last signed in
  const pages = Math.max(1, Math.ceil(directory.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = directory.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const opened = openId ? everyone.find((p) => p.id === openId) ?? null : null;
  const loading = res === null && !error;
  const viewWord = view === "ALL" ? "" : STATUS_VIEW_LABEL[view].replace(/ \(.*\)$/, "").toLowerCase();

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">
        A read-only picture of your workforce. To add, edit, import or change access, use{" "}
        <Link href="/dashboard/employees" className="font-medium text-indigo-700 hover:underline">User Management</Link>.
      </p>

      {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}

      <FilterBar
        filters={filters}
        update={update}
        clear={clear}
        options={options}
        show={{ company: true, project: true, manager: true, designation: true }}
        counts={res?.scope ? { filtered: res.scope.filteredTotal, total: res.scope.orgTotal } : null}
      />

      <section aria-label="Headcount" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div data-testid="kpi-total"><KpiCard label="Total employees" value={String(counts.total)} sub="all records in view" tone="green" icon={ICONS.all} loading={loading} onClick={() => choose("ALL")} selected={view === "ALL"} hint="Show all employees" /></div>
        <div data-testid="kpi-active"><KpiCard label="Active" value={String(counts.active)} sub={counts.total ? `${Math.round((counts.active / counts.total) * 100)}% of total` : "working now"} tone="sky" icon={ICONS.active} loading={loading} onClick={() => choose("ACTIVE")} selected={view === "ACTIVE"} hint="Show the active employees" /></div>
        <div data-testid="kpi-inactive"><KpiCard label="Inactive" value={String(counts.inactive)} sub={`${counts.suspended} suspended · ${counts.exited} exited`} tone="rose" icon={ICONS.inactive} loading={loading} onClick={() => choose("INACTIVE")} selected={view === "INACTIVE" || view === "SUSPENDED" || view === "EXITED"} hint="Show the suspended and exited employees" /></div>
        <div data-testid="kpi-not-started"><KpiCard label="Not started yet" value={String(counts.notStarted)} sub={`${counts.invited} invited · ${counts.candidate} candidates`} tone="amber" icon={ICONS.pending} loading={loading} onClick={() => choose("NOT_STARTED")} selected={view === "NOT_STARTED" || view === "INVITED" || view === "CANDIDATE"} hint="Show the invited employees and candidates" /></div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Where people sit</h2>
        <div role="group" aria-label="Which employees to show below" data-testid="status-chips" className="flex flex-wrap items-center gap-1.5">
          {CHIP_ORDER.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={view === c.key}
              data-testid={`chip-${c.key.toLowerCase()}`}
              onClick={() => choose(c.key)}
              className={`h-8 rounded-full border px-3 text-xs font-medium ${c.sub ? "ml-0.5" : ""} ${view === c.key ? "border-indigo-600 bg-indigo-600 text-white" : "border-indigo-100 bg-white text-slate-600 hover:bg-[var(--brand-50)]"}`}
            >
              {c.label}
              <span className={`ml-1.5 tabular-nums ${view === c.key ? "text-white/80" : "text-slate-400"}`}>{viewCount(counts, c.key)}</span>
            </button>
          ))}
        </div>
      </div>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-label="Distribution">
        <Panel title="By company" sub={`${plural(scoped.length, "employee")}${viewWord ? `, ${viewWord}` : ""}`}>
          <Bars rows={companies} total={scoped.length} empty="No employees to show." />
        </Panel>
        <Panel title="By department" sub={departments.inSeveral ? `Departments are teams. ${plural(departments.inSeveral, "person", "people")} in more than one team count in each.` : "Departments are teams."}>
          <Bars rows={departments.buckets} total={scoped.length} empty="No employees to show." />
        </Panel>
        <Panel title="By designation">
          <Bars rows={designations} total={scoped.length} empty="No employees to show." />
        </Panel>
        <Panel title="By reporting manager" sub="People who report to each manager (main reporting line)">
          <Bars rows={managers} total={scoped.length} empty="No employees to show." />
        </Panel>
      </section>

      <div ref={directoryRef} id="employee-directory" className="scroll-mt-20" />
      <Panel
        title="Employee directory"
        sub={`${directory.length} of ${scoped.length} ${viewWord ? `${viewWord} ` : ""}${scoped.length === 1 ? "employee" : "employees"}`}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
          {view !== "ALL" && (
            <button type="button" data-testid="clear-status" onClick={() => choose("ALL")} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--brand-50)] px-3 text-xs font-medium text-indigo-700 hover:bg-indigo-100" title="Remove the status filter and show every employee">
              {STATUS_VIEW_LABEL[view].replace(/ \(.*\)$/, "")} <span aria-hidden="true">✕</span><span className="sr-only">Clear the status filter</span>
            </button>
          )}
          <input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Search name, ID, email, team, manager"
            aria-label="Search the directory"
            className="h-9 w-56 max-w-full rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-800 outline-none focus:border-indigo-400 sm:w-72"
          />
          </div>
        }
      >
        <div className="-mx-5 overflow-x-auto">
          <table data-testid="directory-table" className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-y border-indigo-50 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                <SortTh label="Employee" k="name" sort={sort} setSort={setSort} setPage={setPage} className="px-5 py-2.5" />
                <SortTh label="Company" k="company" sort={sort} setSort={setSort} setPage={setPage} className="px-3 py-2.5" />
                <SortTh label="Designation" k="designation" sort={sort} setSort={setSort} setPage={setPage} className="px-3 py-2.5" />
                <th className="px-3 py-2.5">Department</th>
                <th className="px-3 py-2.5">Reports to</th>
                {showWhen && <SortTh label="Joined" k="joined" sort={sort} setSort={setSort} setPage={setPage} className="px-3 py-2.5" />}
                {showWhen && <th className="px-3 py-2.5">Last sign-in</th>}
                <SortTh label="Status" k="status" sort={sort} setSort={setSort} setPage={setPage} className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-indigo-50">
              {loading && (
                <tr>
                  <td colSpan={showWhen ? 8 : 6} className="px-5 py-8 text-center text-slate-400">Loading employees…</td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={showWhen ? 8 : 6} className="px-5 py-8 text-center text-slate-400">{q ? "No employee matches that search." : view === "ALL" ? "No employees to show for these filters." : `No ${viewWord} employees for these filters.`}</td>
                </tr>
              )}
              {rows.map((p) => (
                <tr key={p.id} className="cursor-pointer hover:bg-[var(--brand-50)]" onClick={() => setOpenId(p.id)}>
                  <td className="px-5 py-2.5">
                    <button type="button" onClick={(e) => { e.stopPropagation(); setOpenId(p.id); }} className="flex items-center gap-3 text-left" aria-label={`Open profile of ${p.name}`}>
                      <Avatar userId={p.id} name={p.name} photoAt={p.photoAt} size={32} />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-slate-900">{p.name}</span>
                        <span className="block truncate text-xs text-slate-400">{p.employeeCode ?? "No ID"}</span>
                      </span>
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-slate-600">{p.company ?? "—"}</td>
                  <td className="px-3 py-2.5 text-slate-600">{p.designation?.trim() || <span className="text-slate-400">Not assigned</span>}</td>
                  <td className="max-w-[14rem] truncate px-3 py-2.5 text-slate-600" title={p.teams.map((t) => t.name).join(", ")}>{p.teams.length ? p.teams.map((t) => t.name).join(", ") : <span className="text-slate-400">No team</span>}</td>
                  <td className="px-3 py-2.5 text-slate-600">{p.reportsTo?.name ?? <span className="text-slate-400">—</span>}</td>
                  {showWhen && <td className="px-3 py-2.5 text-slate-600">{fmtDate(p.dateOfJoining) ?? <span className="text-slate-400">—</span>}</td>}
                  {showWhen && <td className="px-3 py-2.5 text-slate-600">{fmtStamp(p.lastLoginAt) ?? <span className="text-slate-400">Never</span>}</td>}
                  <td className="px-5 py-2.5"><Chip status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-between gap-3 text-sm text-slate-500">
            <span>Page {current} of {pages}</span>
            <div className="flex gap-2">
              <button type="button" disabled={current <= 1} onClick={() => setPage(current - 1)} className="h-9 rounded-xl border border-indigo-100 px-3 font-medium text-slate-700 hover:bg-[var(--brand-50)] disabled:opacity-40">Previous</button>
              <button type="button" disabled={current >= pages} onClick={() => setPage(current + 1)} className="h-9 rounded-xl border border-indigo-100 px-3 font-medium text-slate-700 hover:bg-[var(--brand-50)] disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </Panel>

      {opened && <Profile p={opened} everyone={everyone} onClose={() => setOpenId(null)} onOpen={setOpenId} />}
    </div>
  );
}
