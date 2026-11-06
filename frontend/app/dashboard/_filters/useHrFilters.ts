"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "@/lib/api";

// ---------------------------------------------------------------------------
// HR FILTERS (state + choices), shared by every page that has the filter bar.
//  * The selection lives in the address bar (company, project, manager, and the page's own q / designation / status), so it survives a refresh and
//    can be carried to a related page. It is read ONCE when the page opens; the dates and other page settings are never touched.
//  * The choices come from /hr-filters/options: real companies, projects, managers and designations, limited to the people the signed-in person
//    may see, and narrowed step by step (company -> projects -> managers -> designations).
//  * Filtering is never authorization: the server narrows only what the person may already see.
// ---------------------------------------------------------------------------

export type Filters = { company: string; project: string[]; manager: string; q: string; designation: string; status: string };
export const NO_FILTERS: Filters = { company: "", project: [], manager: "", q: "", designation: "", status: "" };

export type Options = {
  companies: { id: string; name: string; people: number }[];
  projects: { id: string; name: string; companyId: string; people: number }[];
  managers: { id: string; name: string; employeeCode: string | null; reports: number }[];
  designations: { name: string; people: number }[];
  statuses: string[];
};

/** Filters that travel between related HR pages (the rest belong to one page). */
export const CARRIED = ["company", "project", "manager"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readUrl(): Filters {
  const qs = new URLSearchParams(window.location.search);
  const one = (k: string) => (qs.get(k) ?? "").trim();
  const company = one("company");
  const manager = one("manager");
  return {
    company: UUID.test(company) ? company : "",
    project: one("project").split(",").map((x) => x.trim()).filter((x) => UUID.test(x)),
    manager: UUID.test(manager) ? manager : "",
    q: one("q").slice(0, 80),
    designation: one("designation").slice(0, 80),
    status: one("status").slice(0, 20),
  };
}

function writeUrl(f: Filters) {
  const qs = new URLSearchParams(window.location.search);
  const set = (k: string, v: string) => (v ? qs.set(k, v) : qs.delete(k));
  set("company", f.company);
  set("project", f.project.join(","));
  set("manager", f.manager);
  set("q", f.q);
  set("designation", f.designation);
  set("status", f.status);
  const next = `${window.location.pathname}${qs.toString() ? `?${qs.toString()}` : ""}`;
  window.history.replaceState(null, "", next);
}

export function useHrFilters() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setFilters(readUrl());
    setReady(true);
  }, []);

  const update = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      writeUrl(next);
      return next;
    });
  }, []);
  const clear = useCallback(() => update({ ...NO_FILTERS }), [update]);

  const active = useMemo(
    () => (filters.company ? 1 : 0) + (filters.project.length ? 1 : 0) + (filters.manager ? 1 : 0) + (filters.q ? 1 : 0) + (filters.designation ? 1 : 0) + (filters.status ? 1 : 0),
    [filters]
  );
  return { filters, update, clear, ready, active };
}

/** The choices for the bar. Narrowed by the company, project and manager already chosen; stale selections are dropped once the choices load. */
export function useFilterOptions(filters: Filters, update: (p: Partial<Filters>) => void, enabled: boolean) {
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState("");
  const key = `${filters.company}|${filters.project.join(",")}|${filters.manager}`;
  const latest = useRef(filters);
  useEffect(() => {
    latest.current = filters;
  });

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const qs = new URLSearchParams();
    if (filters.company) qs.set("company", filters.company);
    if (filters.project.length) qs.set("project", filters.project.join(","));
    if (filters.manager) qs.set("manager", filters.manager);
    const t = setTimeout(() => {
      apiGet<Options>(`/hr-filters/options${qs.toString() ? `?${qs.toString()}` : ""}`)
        .then((o) => {
          if (!live) return;
          setOptions(o);
          setError("");
          // a choice that is no longer on offer (for example a project of another company) is removed, so the bar never lies
          const f = latest.current;
          const ids = new Set(o.projects.map((p) => p.id));
          const keep = f.project.filter((p) => ids.has(p));
          const patch: Partial<Filters> = {};
          if (keep.length !== f.project.length) patch.project = keep;
          if (f.manager && !o.managers.some((m) => m.id === f.manager)) patch.manager = "";
          if (f.company && !o.companies.some((c) => c.id === f.company)) patch.company = "";
          if (Object.keys(patch).length) update(patch);
        })
        .catch((e: Error) => live && setError(e.message));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // the key covers company, project and manager; update is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return { options, error };
}

/** The filters as an API query string, using the names the server reads. `names` lets a page rename the ones it calls differently. */
export function filterQuery(f: Filters, names: Partial<Record<keyof Filters, string>> = {}): string {
  const qs = new URLSearchParams();
  const n = (k: keyof Filters, d: string) => names[k] ?? d;
  if (f.company) qs.set(n("company", "company"), f.company);
  if (f.project.length) qs.set(n("project", "project"), f.project.join(","));
  if (f.manager) qs.set(n("manager", "manager"), f.manager);
  if (f.q) qs.set(n("q", "q"), f.q);
  if (f.designation) qs.set(n("designation", "designation"), f.designation);
  if (f.status) qs.set(n("status", "status"), f.status);
  return qs.toString();
}

/** A link to a related HR page that keeps the chosen company, project and manager. */
export function withCarried(href: string, f: Filters): string {
  const carry = new URLSearchParams();
  if (f.company) carry.set("company", f.company);
  if (f.project.length) carry.set("project", f.project.join(","));
  if (f.manager) carry.set("manager", f.manager);
  const extra = carry.toString();
  if (!extra) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${extra}`;
}
