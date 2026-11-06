import { prisma } from "../../lib/prisma.js";
import { accessFor, scopeWhere } from "../../lib/companyAccess.js";
import { visibleUserIds } from "../tracker/tracker.service.js";
import { isFiltering, NO_FILTERS, type HrFilters } from "./hrFilters.logic.js";

// ---------------------------------------------------------------------------
// HR FILTERS (database side). Filtering is NEVER authorization: first the people this viewer may see are worked out from the existing rules, then
// the filters only narrow that list. A filter naming something outside it simply matches nobody. Nothing is stored or recomputed.
//   HR / Admin -> the companies they act on (company access: own company, assigned companies, or all for top management)
//   Manager    -> the people they manage (reporting line and the teams they run), as everywhere else
// ---------------------------------------------------------------------------

const LIVE = ["ACTIVE", "INVITED"] as const;

export async function authorizedPeople(viewerId: string): Promise<{ role: string; platformId: string; ids: string[] }> {
  const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: { id: true, role: true, platformId: true } });
  if (!viewer) throw new Error("NOT_ALLOWED");
  const role = String(viewer.role);
  if (role === "HR" || role === "ADMIN") {
    const access = await accessFor(viewerId);
    const rows = await prisma.user.findMany({ where: { ...scopeWhere(access), status: { in: [...LIVE] } }, select: { id: true } });
    return { role, platformId: viewer.platformId, ids: rows.map((r) => r.id) };
  }
  if (role === "MANAGER") return { role, platformId: viewer.platformId, ids: await visibleUserIds({ id: viewer.id, role, platformId: viewer.platformId }) };
  throw new Error("NOT_ALLOWED");
}

/** Prisma conditions for the filters (everything except the authorized id list). */
export function personWhere(f: HrFilters) {
  return {
    ...(f.companyIds.length ? { platformId: { in: f.companyIds } } : {}),
    ...(f.managerIds.length ? { reportsToId: { in: f.managerIds } } : {}),
    // A person on several of the chosen projects is still one row: this is a condition on the person, not a join.
    ...(f.projectIds.length ? { teamMemberships: { some: { teamId: { in: f.projectIds }, isActive: true } } } : {}),
    ...(f.designation ? { designation: { equals: f.designation, mode: "insensitive" as const } } : {}),
    ...(f.status ? { status: f.status as never } : {}),
    ...(f.q
      ? { OR: [{ firstName: { contains: f.q, mode: "insensitive" as const } }, { lastName: { contains: f.q, mode: "insensitive" as const } }, { employeeCode: { contains: f.q, mode: "insensitive" as const } }] }
      : {}),
  };
}

/** The unique people the viewer may see who pass the filters, and both totals (organization = everyone the viewer may see). */
export async function resolvePeople(viewerId: string, f: HrFilters) {
  const scope = await authorizedPeople(viewerId);
  const rows = scope.ids.length
    ? await prisma.user.findMany({ where: { id: { in: scope.ids }, ...personWhere(f) }, select: { id: true } })
    : [];
  return { role: scope.role, orgIds: scope.ids, ids: rows.map((r) => r.id), orgTotal: scope.ids.length, filteredTotal: rows.length };
}

/**
 * Narrow a list of people a module has ALREADY decided the viewer may see by the HR filters. It can only remove people, never add; the totals say how
 * many the viewer may see (organization) and how many are left. Used by every report so tables, cards, charts and exports share one list.
 */
export async function narrowIds(ids: string[], f: HrFilters | undefined): Promise<{ ids: string[]; scope: { orgTotal: number; filteredTotal: number } }> {
  if (!f || !isFiltering(f) || ids.length === 0) return { ids, scope: { orgTotal: ids.length, filteredTotal: ids.length } };
  const rows = await prisma.user.findMany({ where: { id: { in: ids }, ...personWhere(f) }, select: { id: true } });
  return { ids: rows.map((r) => r.id), scope: { orgTotal: ids.length, filteredTotal: rows.length } };
}

const nameOf = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

/**
 * The choices for the filter bar, all from real records and narrowed step by step: companies; projects of the chosen companies; managers of the people
 * in the chosen companies and projects; designations of the people left. Only what the viewer may see is ever listed.
 */
export async function options(viewerId: string, f: HrFilters) {
  const scope = await authorizedPeople(viewerId);
  const base = scope.ids.length
    ? await prisma.user.findMany({
        where: { id: { in: scope.ids } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeCode: true,
          designation: true,
          status: true,
          platformId: true,
          platform: { select: { name: true } },
          reportsToId: true,
          teamMemberships: { where: { isActive: true, team: { isActive: true } }, select: { team: { select: { id: true, name: true, platformId: true } } } },
        },
      })
    : [];

  const inCompany = (p: (typeof base)[number]) => !f.companyIds.length || f.companyIds.includes(p.platformId);
  const inProject = (p: (typeof base)[number]) => !f.projectIds.length || p.teamMemberships.some((m) => f.projectIds.includes(m.team.id));
  const inManager = (p: (typeof base)[number]) => !f.managerIds.length || (!!p.reportsToId && f.managerIds.includes(p.reportsToId));

  // companies: every company that has someone the viewer may see
  const companyMap = new Map<string, { id: string; name: string; people: number }>();
  for (const p of base) {
    const c = companyMap.get(p.platformId) ?? { id: p.platformId, name: p.platform.name, people: 0 };
    c.people += 1;
    companyMap.set(p.platformId, c);
  }

  // projects: of the chosen companies, with the number of (unique) people the viewer may see on each
  const projectMap = new Map<string, { id: string; name: string; companyId: string; people: number }>();
  for (const p of base.filter(inCompany)) {
    for (const m of p.teamMemberships) {
      const pr = projectMap.get(m.team.id) ?? { id: m.team.id, name: m.team.name, companyId: m.team.platformId, people: 0 };
      pr.people += 1;
      projectMap.set(m.team.id, pr);
    }
  }

  // managers: of the people in the chosen companies and projects
  const byId = new Map(base.map((p) => [p.id, p]));
  const reportsByManager = new Map<string, number>();
  for (const p of base.filter((x) => inCompany(x) && inProject(x))) if (p.reportsToId) reportsByManager.set(p.reportsToId, (reportsByManager.get(p.reportsToId) ?? 0) + 1);
  const managerIds = [...reportsByManager.keys()];
  // a manager may sit outside the viewer's own list (another company): look the names up directly
  const known = managerIds.filter((id) => byId.has(id));
  const extra = managerIds.filter((id) => !byId.has(id));
  const extras = extra.length ? await prisma.user.findMany({ where: { id: { in: extra } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } }) : [];
  const managers = [
    ...known.map((id) => ({ id, name: nameOf(byId.get(id)!), employeeCode: byId.get(id)!.employeeCode, reports: reportsByManager.get(id) ?? 0 })),
    ...extras.map((u) => ({ id: u.id, name: nameOf(u), employeeCode: u.employeeCode, reports: reportsByManager.get(u.id) ?? 0 })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  // designations: of the people left after company, project and manager
  const desigCount = new Map<string, number>();
  for (const p of base.filter((x) => inCompany(x) && inProject(x) && inManager(x))) if (p.designation) desigCount.set(p.designation, (desigCount.get(p.designation) ?? 0) + 1);

  const filtered = await resolvePeople(viewerId, f);
  return {
    companies: [...companyMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    projects: [...projectMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
    managers,
    designations: [...desigCount.entries()].map(([name, people]) => ({ name, people })).sort((a, b) => a.name.localeCompare(b.name)),
    statuses: [...new Set(base.map((p) => String(p.status)))].sort(),
    counts: { orgTotal: filtered.orgTotal, filteredTotal: filtered.filteredTotal },
    applied: f,
  };
}

export { NO_FILTERS };
