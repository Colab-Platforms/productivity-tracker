// The shared HR filters, as pure rules (no database): reading them from a request and describing them. Used by every module that filters people.
//
//   company   one or more companies        (platform ids)
//   project   one or more projects         (a project is a Team; a person can be on several, and is counted once)
//   manager   one or more reporting managers (the person a user "reports to")
//   designation, status, q (name or employee ID search)
//
// There is no department filter: the system holds no real department field (teams stand in for departments), so none is invented.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HrFilters = {
  companyIds: string[];
  projectIds: string[];
  managerIds: string[];
  designation: string | null;
  status: string | null;
  q: string | null;
};

export const NO_FILTERS: HrFilters = { companyIds: [], projectIds: [], managerIds: [], designation: null, status: null, q: null };

const STATUSES = ["ACTIVE", "INVITED", "SUSPENDED", "EXITED", "CANDIDATE"];

/** A comma-separated (or repeated) list of ids from a query value. Anything that is not a valid id is dropped, never passed to the database. */
export function idList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.flatMap((x) => String(x).split(",")) : typeof v === "string" ? v.split(",") : [];
  const out: string[] = [];
  for (const part of raw) {
    const id = part.trim();
    if (UUID.test(id) && !out.includes(id.toLowerCase())) out.push(id.toLowerCase());
  }
  return out.slice(0, 50);
}

const text = (v: unknown, max: number): string | null => {
  const s = typeof v === "string" ? v.trim().slice(0, max) : "";
  return s || null;
};

/** The filters in a request's query string. Accepts the old names too (teamId = project, companyId, managerId) so earlier links keep working. */
export function parseFilters(query: Record<string, unknown>): HrFilters {
  const status = text(query.employmentStatus ?? query.userStatus, 20)?.toUpperCase() ?? null;
  return {
    companyIds: idList(query.companyId ?? query.company),
    projectIds: idList(query.projectId ?? query.project ?? query.teamId),
    managerIds: idList(query.managerId ?? query.manager),
    designation: text(query.designation, 80),
    status: status && STATUSES.includes(status) ? status : null,
    q: text(query.q ?? query.search, 80),
  };
}

export const isFiltering = (f: HrFilters) => f.companyIds.length + f.projectIds.length + f.managerIds.length > 0 || !!f.designation || !!f.status || !!f.q;

/** The same filters as query-string pairs (for links that carry them to a related page). Only company, project and manager travel between pages. */
export function carried(f: Pick<HrFilters, "companyIds" | "projectIds" | "managerIds">): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.companyIds.length) out.company = f.companyIds.join(",");
  if (f.projectIds.length) out.project = f.projectIds.join(",");
  if (f.managerIds.length) out.manager = f.managerIds.join(",");
  return out;
}

/**
 * The one matching rule, written out (the database query implements exactly this): a person matches when they pass EVERY filter that is set, and
 * for the multi-valued ones (company, project, manager) when they match ANY of the chosen values. A person on three of the chosen projects is still ONE person.
 */
export function matches(
  person: { id: string; platformId: string; reportsToId: string | null; projectIds: string[]; designation: string | null; status: string; name: string; employeeCode: string | null },
  f: HrFilters
): boolean {
  if (f.companyIds.length && !f.companyIds.includes(person.platformId)) return false;
  if (f.projectIds.length && !person.projectIds.some((p) => f.projectIds.includes(p))) return false;
  if (f.managerIds.length && !(person.reportsToId && f.managerIds.includes(person.reportsToId))) return false;
  if (f.designation && (person.designation ?? "").toLowerCase() !== f.designation.toLowerCase()) return false;
  if (f.status && person.status !== f.status) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!`${person.name} ${person.employeeCode ?? ""}`.toLowerCase().includes(q)) return false;
  }
  return true;
}
