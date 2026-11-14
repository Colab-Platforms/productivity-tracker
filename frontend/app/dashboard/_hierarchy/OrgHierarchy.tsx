"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet, apiPatch } from "@/lib/api";
import { plural } from "@/lib/plural";
import { roleLabel } from "@/lib/roles";
import { Modal } from "../_employees/Modal";
import Avatar from "../_photos/Avatar";
import FilterBar from "../_filters/FilterBar";
import { useFilterOptions, useHrFilters } from "../_filters/useHrFilters";
import { KpiCard, Panel } from "../_dashboard/widgets";
import { buildHierarchy, candidatesFor, filtering, passes, visibleIds, type Filters, type Issue, type OrgPerson, type TreeNode } from "./orgTree";

// ---------------------------------------------------------------------------
// ORGANIZATION HIERARCHY (Admin). Who reports to whom, drawn from the real "reports to" on every person's record: the Admins side by side at the top,
// the Managers who report to each, the employees under each Manager, with counts. Search and company / project filters, expand and collapse, a list
// of people whose line is missing or wrong, and a way to change a reporting manager.
// It is NOT the employee-management screen: accounts, roles and access stay in User Management. The only thing saved from here is a person's
// reporting manager, through the same Admin-only, audited call the Edit Employee screen uses (PATCH /admin/users/:id { reportsToId }), so the
// server's rules decide (role order, no loops, active boss) and leave approvals, task approvals and manager views read the new line at once.
// Admins never get a reporting manager here.
// ---------------------------------------------------------------------------

type Res = { users: OrgPerson[]; scope?: { orgTotal: number; filteredTotal: number } };

const ROLE_CHIP: Record<string, string> = {
  ADMIN: "bg-indigo-100 text-indigo-700",
  MANAGER: "bg-violet-50 text-violet-700",
  HR: "bg-sky-50 text-sky-700",
  EMPLOYEE: "bg-slate-100 text-slate-600",
};
const ISSUE_CHIP: Record<Issue["kind"], string> = {
  NO_MANAGER: "bg-rose-50 text-rose-700",
  WRONG_ROLE: "bg-amber-50 text-amber-700",
  BOSS_INACTIVE: "bg-amber-50 text-amber-700",
  BOSS_UNKNOWN: "bg-slate-100 text-slate-600",
};

const icon = (d: string) => (
  <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 4l6 6-6 6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// change a reporting manager: choose, then review and confirm, then save
// ---------------------------------------------------------------------------
function ChangeManager({ person, everyone, onClose, onSaved }: { person: OrgPerson; everyone: OrgPerson[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string | "none" | null>(null);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const candidates = useMemo(() => candidatesFor(person, everyone), [person, everyone]);
  const shown = candidates.filter((c) => !q.trim() || [c.name, c.employeeCode, c.designation, c.company].filter(Boolean).join(" ").toLowerCase().includes(q.trim().toLowerCase()));
  const reports = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of everyone) if (p.reportsTo && (p.status === "ACTIVE" || p.status === "INVITED")) m.set(p.reportsTo.id, (m.get(p.reportsTo.id) ?? 0) + 1);
    return m;
  }, [everyone]);
  const chosen = pick && pick !== "none" ? candidates.find((c) => c.id === pick) ?? null : null;
  const needWord = person.role === "EMPLOYEE" ? "Manager" : person.role === "MANAGER" ? "Admin" : "Manager or Admin";
  const sameAsNow = (pick === "none" && !person.reportsTo) || (chosen && person.reportsTo?.id === chosen.id);

  async function save() {
    if (busy || !pick) return;
    setBusy(true);
    setError("");
    try {
      await apiPatch(`/admin/users/${person.id}`, { reportsToId: pick === "none" ? null : pick });
      onSaved(pick === "none" ? `${person.name} no longer has a reporting manager.` : `${person.name} now reports to ${chosen?.name}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not save.");
      setReview(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={review ? "Confirm the change" : "Change reporting manager"}
      subtitle={`${person.name}${person.employeeCode ? ` · ${person.employeeCode}` : ""}`}
      onClose={onClose}
      width="max-w-xl"
      footer={
        review ? (
          <>
            <button type="button" disabled={busy} onClick={() => setReview(false)} className="h-10 rounded-xl border border-indigo-100 px-4 text-sm font-medium text-slate-700 hover:bg-[var(--brand-50)] disabled:opacity-40">Back</button>
            <button type="button" disabled={busy} onClick={() => void save()} className="h-10 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">{busy ? "Saving…" : "Confirm and save"}</button>
          </>
        ) : (
          <>
            <button type="button" onClick={onClose} className="h-10 rounded-xl border border-indigo-100 px-4 text-sm font-medium text-slate-700 hover:bg-[var(--brand-50)]">Cancel</button>
            <button type="button" disabled={!pick || !!sameAsNow} onClick={() => setReview(true)} className="h-10 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Review change</button>
          </>
        )
      }
    >
      {error && <div role="alert" className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
      {!review ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Currently reports to <strong className="text-slate-900">{person.reportsTo?.name ?? "nobody"}</strong>. {person.role === "EMPLOYEE" ? "An employee reports to a Manager." : person.role === "MANAGER" ? "A Manager reports to an Admin." : "Pick a Manager or an Admin."} Any company.
          </p>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${needWord}s by name, ID or company`} aria-label="Search people to choose from" className="h-10 w-full rounded-xl border border-indigo-100 bg-white px-3 text-sm outline-none focus:border-indigo-400" />
          <ul className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-indigo-50 p-1" role="listbox" aria-label={`${needWord}s`}>
            {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-400">{candidates.length === 0 ? `There is no active ${needWord} to choose.` : "Nobody matches that search."}</li>}
            {shown.map((c) => (
              <li key={c.id}>
                <button type="button" role="option" aria-selected={pick === c.id} onClick={() => setPick(c.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${pick === c.id ? "bg-indigo-50 ring-1 ring-indigo-300" : "hover:bg-[var(--brand-50)]"}`}>
                  <Avatar userId={c.id} name={c.name} photoAt={c.photoAt} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-slate-900">{c.name}{person.reportsTo?.id === c.id && <span className="ml-2 text-xs font-normal text-slate-400">current</span>}</span>
                    <span className="block truncate text-xs text-slate-500">{c.employeeCode ?? "No ID"} · {c.designation?.trim() || "No designation"} · {c.company ?? "No company"}</span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{plural(reports.get(c.id) ?? 0, "report")}</span>
                </button>
              </li>
            ))}
          </ul>
          {person.reportsTo && (
            <button type="button" onClick={() => setPick("none")} aria-pressed={pick === "none"} className={`w-full rounded-xl border px-3 py-2 text-left text-sm ${pick === "none" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-indigo-100 text-slate-600 hover:bg-[var(--brand-50)]"}`}>
              Remove the reporting manager (they will show under “Needs attention”)
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4 text-sm text-slate-700">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl bg-[#F3F7F6] px-4 py-3">
            <dt className="text-slate-400">Person</dt><dd className="font-medium text-slate-900">{person.name} ({roleLabel(person.role)})</dd>
            <dt className="text-slate-400">From</dt><dd>{person.reportsTo?.name ?? "No reporting manager"}</dd>
            <dt className="text-slate-400">To</dt><dd className="font-medium text-slate-900">{chosen ? `${chosen.name} (${roleLabel(chosen.role)}${chosen.company ? `, ${chosen.company}` : ""})` : "No reporting manager"}</dd>
          </dl>
          <p>
            Their reporting manager is who they report to for approvals and who sees their team. From now on, leave requests start with the new manager by default, and the new manager sees their attendance, reports and tasks.
            Requests and approvals already sent keep the approver they went to. This is recorded in the audit log.
          </p>
          {person.role === "MANAGER" && <p className="rounded-xl bg-amber-50 px-3 py-2 text-amber-800">This person&apos;s own team stays with them; only who they report to changes.</p>}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// one person in the tree
// ---------------------------------------------------------------------------
function Row({ n, open, onToggle, onChange, dim }: { n: TreeNode; open: boolean; onToggle: () => void; onChange: (p: OrgPerson) => void; dim: boolean }) {
  const p = n.person;
  const canChange = p.role !== "ADMIN";
  return (
    <div data-person={p.id} className={`flex flex-wrap items-center gap-3 rounded-xl px-3 py-2 ${dim ? "opacity-60" : ""} ${n.issue ? "bg-amber-50/50" : "hover:bg-[var(--brand-50)]"}`}>
      {n.children.length > 0 ? (
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${p.name}'s team`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-indigo-100 text-slate-500 hover:bg-white">
          <Chevron open={open} />
        </button>
      ) : (
        <span className="h-7 w-7 shrink-0" aria-hidden="true" />
      )}
      <Avatar userId={p.id} name={p.name} photoAt={p.photoAt} size={36} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900">
          {p.name} <span className="font-normal text-slate-400">{p.employeeCode}</span>
        </p>
        <p className="truncate text-xs text-slate-500">{p.designation?.trim() || "No designation"}{p.company ? ` · ${p.company}` : ""}</p>
      </div>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${ROLE_CHIP[p.role] ?? ROLE_CHIP.EMPLOYEE}`}>{roleLabel(p.role)}</span>
      {n.issue && <span title={n.issue.text} className={`max-w-[18rem] shrink-0 truncate rounded-full px-2 py-0.5 text-[11px] font-medium ${ISSUE_CHIP[n.issue.kind]}`}>{n.issue.text}</span>}
      {n.direct > 0 && (
        <span className="shrink-0 text-xs text-slate-500" title={`${n.direct} report directly, ${n.team} in the whole team`}>
          <strong className="text-slate-900">{n.direct}</strong> direct{n.team !== n.direct ? ` · ${n.team} in team` : ""}
        </span>
      )}
      {canChange ? (
        <button type="button" onClick={() => onChange(p)} className="shrink-0 rounded-lg border border-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-white">Change manager</button>
      ) : (
        <span className="shrink-0 rounded-lg bg-[#F3F7F6] px-2.5 py-1 text-xs text-slate-500" title="Admins are the top level and report to nobody">Top level</span>
      )}
    </div>
  );
}

function Branch({ n, depth, open, toggle, show, match, forced, onChange }: { n: TreeNode; depth: number; open: Set<string>; toggle: (id: string) => void; show: Set<string> | null; match: Set<string> | null; forced: boolean; onChange: (p: OrgPerson) => void }) {
  if (show && !show.has(n.person.id)) return null;
  const isOpen = forced || open.has(n.person.id);
  return (
    <li>
      <Row n={n} open={isOpen} onToggle={() => toggle(n.person.id)} onChange={onChange} dim={!!match && !match.has(n.person.id)} />
      {n.children.length > 0 && isOpen && (
        <ul className="ml-6 border-l border-indigo-100 pl-3">
          {n.children.map((c) => (
            <Branch key={c.person.id} n={c} depth={depth + 1} open={open} toggle={toggle} show={show} match={match} forced={forced} onChange={onChange} />
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
export default function OrgHierarchy() {
  const { filters, update, clear, ready } = useHrFilters();
  const { options } = useFilterOptions(filters, update, ready);
  const [res, setRes] = useState<Res | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState<Set<string> | null>(null); // null = not touched yet: the Admins are open, everything else closed
  const [editing, setEditing] = useState<OrgPerson | null>(null);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    apiGet<Res>("/admin/users")
      .then((r) => {
        if (!live) return;
        setRes(r);
        setError("");
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [ready, reload]);

  const everyone = useMemo(() => res?.users ?? [], [res]);
  const h = useMemo(() => buildHierarchy(everyone), [everyone]);
  const f: Filters = useMemo(() => ({ q: filters.q, companyId: filters.company, projectIds: filters.project }), [filters.q, filters.company, filters.project]);
  const active = filtering(f);
  const vis = useMemo(() => (active ? visibleIds(h.admins, f) : null), [active, h, f]);
  const openSet = useMemo(() => open ?? new Set(h.admins.map((a) => a.person.id)), [open, h]);
  const toggle = useCallback((id: string) => setOpen((prev) => { const next = new Set(prev ?? openSet); if (next.has(id)) next.delete(id); else next.add(id); return next; }), [openSet]);
  const allIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (n: TreeNode) => { if (n.children.length) ids.push(n.person.id); n.children.forEach(walk); };
    h.admins.forEach(walk);
    return ids;
  }, [h]);
  const attention = useMemo(() => (active ? h.needsAttention.filter((x) => visibleMatch(x.person, f)) : h.needsAttention), [active, h, f]);
  const loading = res === null && !error;

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">
        Who reports to whom, from each person&apos;s own record. To add, edit or give access to people, use{" "}
        <Link href="/dashboard/employees" className="font-medium text-indigo-700 hover:underline">User Management</Link>. Only the reporting manager can be changed here.
      </p>

      {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
      {notice && <div role="status" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

      <FilterBar
        filters={filters}
        update={update}
        clear={clear}
        options={options}
        show={{ search: true, company: true, project: true }}
        searchPlaceholder="Search name, ID, designation or team"
        counts={res?.scope ? { filtered: active ? countMatches(h, f) : res.scope.orgTotal, total: res.scope.orgTotal } : null}
      />

      <section aria-label="Summary" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Admins" value={String(h.counts.admins)} sub="top level, peers" tone="violet" icon={icon("M10 2.8l6 2.4v4.4c0 3.6-2.5 6.1-6 7.6-3.5-1.5-6-4-6-7.6V5.2l6-2.4z")} loading={loading} />
        <KpiCard label="Managers" value={String(h.counts.managers)} sub="report to an Admin" tone="sky" icon={icon("M10 9.6a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6zM4.5 16c0-3 2.5-4.7 5.5-4.7s5.5 1.7 5.5 4.7")} loading={loading} />
        <KpiCard label="Employees" value={String(h.counts.employees)} sub="report to a Manager" tone="green" icon={icon("M2.6 16c0-2.6 2.2-4.3 4.9-4.3s4.9 1.7 4.9 4.3M7.5 9.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM14.6 11.9c1.6.5 2.8 1.9 2.8 4.1")} loading={loading} />
        <KpiCard label="Needs attention" value={String(h.counts.needsAttention)} sub="missing or wrong line" tone={h.counts.needsAttention ? "amber" : "green"} icon={icon("M10 6.5v4M10 13.5h.01M3.5 16h13L10 4.5 3.5 16z")} loading={loading} />
      </section>

      <Panel
        title="Organization"
        sub={`The ${plural(h.counts.admins, "Admin")} at the top ${h.counts.admins === 1 ? "has" : "have"} the same authority and report to nobody.`}
        action={
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(new Set(allIds))} className="h-8 rounded-lg border border-indigo-100 px-3 text-xs font-medium text-slate-700 hover:bg-[var(--brand-50)]">Expand all</button>
            <button type="button" onClick={() => setOpen(new Set())} className="h-8 rounded-lg border border-indigo-100 px-3 text-xs font-medium text-slate-700 hover:bg-[var(--brand-50)]">Collapse all</button>
          </div>
        }
      >
        {h.admins.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-[#F3F7F6] px-3 py-2.5" aria-label="Top-level authority">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Top-level authority</span>
            {h.admins.map((a) => (
              <span key={a.person.id} className="inline-flex items-center gap-2 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-800 shadow-sm">
                <Avatar userId={a.person.id} name={a.person.name} photoAt={a.person.photoAt} size={20} />
                {a.person.name}
              </span>
            ))}
          </div>
        )}
        {loading && <p className="py-8 text-center text-sm text-slate-400">Loading the organization…</p>}
        {!loading && h.admins.length === 0 && <p className="py-8 text-center text-sm text-slate-400">No active Admin is in your view.</p>}
        {active && vis && vis.show.size === 0 && <p className="py-8 text-center text-sm text-slate-400">Nobody in the reporting tree matches these filters.</p>}
        <ul className="space-y-1">
          {h.admins.map((a) => (
            <Branch key={a.person.id} n={a} depth={0} open={openSet} toggle={toggle} show={vis ? vis.show : null} match={vis ? vis.match : null} forced={active} onChange={setEditing} />
          ))}
        </ul>
      </Panel>

      <Panel id="needs-attention" title="Needs attention" sub="People whose reporting line is missing or does not fit the order Admin, Manager, Employee">
        {attention.length === 0 ? (
          <p className="py-4 text-center text-sm text-slate-400">{h.needsAttention.length === 0 ? "Every reporting line fits. Nothing is missing." : "Nobody here matches these filters."}</p>
        ) : (
          <ul className="divide-y divide-indigo-50">
            {attention.map(({ person, issue }) => (
              <li key={person.id} data-attention={person.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <Avatar userId={person.id} name={person.name} photoAt={person.photoAt} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">{person.name} <span className="font-normal text-slate-400">{person.employeeCode}</span></p>
                  <p className="truncate text-xs text-slate-500">{roleLabel(person.role)} · {person.designation?.trim() || "No designation"}{person.company ? ` · ${person.company}` : ""}</p>
                </div>
                <span className={`max-w-[22rem] truncate rounded-full px-2 py-0.5 text-[11px] font-medium ${ISSUE_CHIP[issue.kind]}`} title={issue.text}>{issue.text}</span>
                <button type="button" onClick={() => setEditing(person)} className="shrink-0 rounded-lg border border-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-[var(--brand-50)]">Assign manager</button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {h.outsideTree.length > 0 && (!active || h.outsideTree.some((p) => visibleMatch(p, f))) && (
        <Panel title="Not part of the reporting tree" sub="HR and similar roles need no reporting line">
          <ul className="flex flex-wrap gap-2">
            {h.outsideTree.filter((p) => !active || visibleMatch(p, f)).map((p) => (
              <li key={p.id} className="inline-flex items-center gap-2 rounded-full border border-indigo-100 px-3 py-1 text-xs text-slate-700">
                <Avatar userId={p.id} name={p.name} photoAt={p.photoAt} size={20} />
                {p.name} · {roleLabel(p.role)}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {editing && (
        <ChangeManager
          person={editing}
          everyone={everyone}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setNotice(msg);
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

const visibleMatch = (p: OrgPerson, f: Filters) => passes(p, f);
function countMatches(h: ReturnType<typeof buildHierarchy>, f: Filters): number {
  const ids = new Set<string>();
  const walk = (n: TreeNode) => { if (passes(n.person, f)) ids.add(n.person.id); n.children.forEach(walk); };
  h.admins.forEach(walk);
  for (const x of h.needsAttention) if (passes(x.person, f)) ids.add(x.person.id);
  for (const p of h.outsideTree) if (passes(p, f)) ids.add(p.id);
  return ids.size;
}
