"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Filters, Options } from "./useHrFilters";

// ---------------------------------------------------------------------------
// FILTER BAR (shared). Company · Project (several can be chosen) · Reporting manager · optional designation, status and name/ID search, plus a slot
// for the page's own filters (attendance status, leave type, dates ...). Shows what is active, with a remove button on each, a Clear all button, and
// "Showing x of y": the filtered people next to everyone the person may see, so a filtered total is never mistaken for the organization total.
// All choices are passed in from real records; nothing here is a fixed list.
// ---------------------------------------------------------------------------

const label = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400";
const control = "h-9 w-full rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-800 outline-none focus:border-indigo-400";

export type Show = { search?: boolean; company?: boolean; project?: boolean; manager?: boolean; designation?: boolean; status?: boolean };

export default function FilterBar({
  filters,
  update,
  clear,
  options,
  show,
  counts,
  noun = "employees",
  searchPlaceholder = "Search name or employee ID",
  statusLabel = "Employment status",
  extra,
  extraActive = 0,
}: {
  filters: Filters;
  update: (p: Partial<Filters>) => void;
  clear: () => void;
  options: Options | null;
  show: Show;
  counts: { filtered: number; total: number } | null;
  noun?: string;
  searchPlaceholder?: string;
  statusLabel?: string;
  extra?: ReactNode;
  /** how many of the page's own filters (in `extra`) are active, so Clear all and the "filtered" note know */
  extraActive?: number;
}) {
  const companyName = options?.companies.find((c) => c.id === filters.company)?.name;
  const managerName = options?.managers.find((m) => m.id === filters.manager)?.name;
  const projectNames = filters.project.map((id) => options?.projects.find((p) => p.id === id)?.name ?? "Project");

  const chips: { key: string; text: string; remove: () => void }[] = [];
  if (show.company && filters.company) chips.push({ key: "company", text: `Company: ${companyName ?? "…"}`, remove: () => update({ company: "" }) });
  if (show.project) filters.project.forEach((id, i) => chips.push({ key: `p-${id}`, text: `Project: ${projectNames[i]}`, remove: () => update({ project: filters.project.filter((x) => x !== id) }) }));
  if (show.manager && filters.manager) chips.push({ key: "manager", text: `Manager: ${managerName ?? "…"}`, remove: () => update({ manager: "" }) });
  if (show.designation && filters.designation) chips.push({ key: "designation", text: `Designation: ${filters.designation}`, remove: () => update({ designation: "" }) });
  if (show.status && filters.status) chips.push({ key: "status", text: `${statusLabel}: ${titleCase(filters.status)}`, remove: () => update({ status: "" }) });
  if (show.search && filters.q) chips.push({ key: "q", text: `Search: “${filters.q}”`, remove: () => update({ q: "" }) });
  const filtering = chips.length > 0 || extraActive > 0;

  return (
    <section className="rounded-2xl bg-white p-3 shadow-[var(--shadow-card)] sm:p-4" aria-label="Filters">
      <div className="flex flex-wrap items-end gap-2.5">
        {show.search && (
          <div className="min-w-[14rem] flex-1">
            <label className={label} htmlFor="hf-q">Search</label>
            <input id="hf-q" type="search" value={filters.q} onChange={(e) => update({ q: e.target.value })} placeholder={searchPlaceholder} className={control} />
          </div>
        )}
        {show.company && (
          <div className="w-44">
            <label className={label} htmlFor="hf-company">Company</label>
            <select id="hf-company" value={filters.company} onChange={(e) => update({ company: e.target.value, project: [], manager: "" })} className={control}>
              <option value="">All Companies</option>
              {options?.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        {show.project && (
          <div className="w-48">
            <span className={label} id="hf-project-label">Project</span>
            <ProjectPicker options={options?.projects ?? []} value={filters.project} onChange={(project) => update({ project })} />
          </div>
        )}
        {show.manager && (
          <div className="w-48">
            <label className={label} htmlFor="hf-manager">Reporting Manager</label>
            <select id="hf-manager" value={filters.manager} onChange={(e) => update({ manager: e.target.value })} className={control}>
              <option value="">All Managers</option>
              {options?.managers.map((m) => <option key={m.id} value={m.id}>{m.name}{m.employeeCode ? ` (${m.employeeCode})` : ""} · {m.reports}</option>)}
            </select>
          </div>
        )}
        {show.designation && (
          <div className="w-44">
            <label className={label} htmlFor="hf-designation">Designation</label>
            <select id="hf-designation" value={filters.designation} onChange={(e) => update({ designation: e.target.value })} className={control}>
              <option value="">All Designations</option>
              {options?.designations.map((d) => <option key={d.name} value={d.name}>{d.name} · {d.people}</option>)}
            </select>
          </div>
        )}
        {show.status && (
          <div className="w-44">
            <label className={label} htmlFor="hf-status">{statusLabel}</label>
            <select id="hf-status" value={filters.status} onChange={(e) => update({ status: e.target.value })} className={control}>
              <option value="">All</option>
              {options?.statuses.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </select>
          </div>
        )}
        {extra}
        {filtering && (
          <button type="button" onClick={clear} className="h-9 rounded-xl px-3 text-sm font-medium text-indigo-600 hover:bg-indigo-50">
            Clear all filters
          </button>
        )}
      </div>

      {(chips.length > 0 || counts) && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-indigo-50 pt-3">
          {counts && (
            <p className="text-sm text-slate-600" aria-live="polite">
              {filtering ? (
                <>Showing <span className="font-semibold text-slate-900">{counts.filtered}</span> of {counts.total} {noun}</>
              ) : (
                <>All <span className="font-semibold text-slate-900">{counts.total}</span> {noun}</>
              )}
              {filtering && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Filtered</span>}
            </p>
          )}
          {chips.map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-indigo-700">
              {c.text}
              <button type="button" onClick={c.remove} aria-label={`Remove ${c.text}`} className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-indigo-100">×</button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

// Several projects can be chosen: a small list with a tick per project. A person on two chosen projects is still one person (the server counts people).
function ProjectPicker({ options, value, onChange }: { options: Options["projects"]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const t = text.trim().toLowerCase();
    return t ? options.filter((o) => o.name.toLowerCase().includes(t)) : options;
  }, [options, text]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const summary = value.length === 0 ? "All Projects" : value.length === 1 ? options.find((o) => o.id === value[0])?.name ?? "1 project" : `${value.length} projects`;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div ref={box} className="relative" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby="hf-project-label"
        onClick={() => setOpen((v) => !v)}
        className={`${control} flex items-center justify-between text-left`}
      >
        <span className="truncate">{summary}</span>
        <svg viewBox="0 0 20 20" className={`ml-2 h-4 w-4 shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 8 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="absolute z-30 mt-1.5 w-64 overflow-hidden rounded-2xl border border-indigo-100 bg-white shadow-[var(--shadow-lift)]">
          <div className="border-b border-indigo-50 p-2">
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Search projects…" aria-label="Search projects" className="h-8 w-full rounded-lg border border-indigo-100 px-2.5 text-sm outline-none focus:border-indigo-400" />
          </div>
          <ul role="listbox" aria-multiselectable="true" aria-labelledby="hf-project-label" className="max-h-64 overflow-y-auto py-1">
            {shown.map((o) => {
              const on = value.includes(o.id);
              return (
                <li key={o.id} role="option" aria-selected={on}>
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-indigo-50">
                    <input type="checkbox" checked={on} onChange={() => toggle(o.id)} className="rounded border-indigo-200" />
                    <span className="min-w-0 flex-1 truncate text-slate-800">{o.name}</span>
                    <span className="text-xs tabular-nums text-slate-400">{o.people}</span>
                  </label>
                </li>
              );
            })}
            {shown.length === 0 && <li className="px-3 py-4 text-center text-sm text-slate-400">{options.length === 0 ? "No projects yet." : "No project matches."}</li>}
          </ul>
          {value.length > 0 && (
            <div className="border-t border-indigo-50 p-2">
              <button type="button" onClick={() => onChange([])} className="text-xs font-medium text-indigo-600 hover:underline">Clear projects</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
