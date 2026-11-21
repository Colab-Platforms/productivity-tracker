import { isSupervisor, monitoringIds } from "../../lib/supervisor.js";
import { inactiveStatuses, statusReady, statusKnownSync } from "../../lib/userStatus.js";
import { NOT_ADMIN } from "../../lib/tracked.js";
import { linkedEmployeesOfManagers } from "../../lib/reportingLinks.js";
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
    const rows = await prisma.user.findMany({ where: { ...scopeWhere(access), status: { in: [...LIVE] }, ...NOT_ADMIN }, select: { id: true } });
    return { role, platformId: viewer.platformId, ids: rows.map((r) => r.id) };
  }
  if (role === "MANAGER") return { role, platformId: viewer.platformId, ids: await visibleUserIds({ id: viewer.id, role, platformId: viewer.platformId }) };
  // A Productivity Supervisor: every active person of every company, read-only (the role stays EMPLOYEE; this only widens what is VISIBLE).
  if (role === "EMPLOYEE" && (await isSupervisor(viewer.id))) return { role: "SUPERVISOR", platformId: viewer.platformId, ids: await monitoringIds() };
  throw new Error("NOT_ALLOWED");
}

/** Prisma conditions for the filters (everything except the authorized id list). */
export function personWhere(f: HrFilters, linkedIds: string[] = []) {
  return {
    ...(f.companyIds.length ? { platformId: { in: f.companyIds } } : {}),
    // main reporting manager, or an ADDITIONAL one (linkedIds = people linked to the chosen managers)
    ...(f.managerIds.length ? { AND: [{ OR: [{ reportsToId: { in: f.managerIds } }, ...(linkedIds.length ? [{ id: { in: linkedIds } }] : [])] }] } : {}),
    // A person on several of the chosen projects is still one row: this is a condition on the person, not a join.
    ...(f.projectIds.length ? { teamMemberships: { some: { teamId: { in: f.projectIds }, isActive: true } } } : {}),
    ...(f.designation ? { designation: { equals: f.designation, mode: "insensitive" as const } } : {}),
    // TERMINATED / ABSCONDED reach the database only once it knows them (see lib/userStatus.ts); before that nobody can hold them, so the filter matches nobody.
    ...(f.status ? (f.status === "TERMINATED" || f.status === "ABSCONDED") && !statusKnownSync() ? { id: "00000000-0000-0000-0000-000000000000" } : { status: f.status as never } : {}),
    ...(f.q
      ? { OR: [{ firstName: { contains: f.q, mode: "insensitive" as const } }, { lastName: { contains: f.q, mode: "insensitive" as const } }, { employeeCode: { contains: f.q, mode: "insensitive" as const } }] }
      : {}),
  };
}

/** The unique people the viewer may see who pass the filters, and both totals (organization = everyone the viewer may see). */
/** The people in the chosen Query Desk departments, or null when no department is chosen. A missing table means nobody is in a department. */
async function departmentMembers(f: HrFilters): Promise<Set<string> | null> {
  if (f.departmentIds.length === 0) return null;
  try {
    const rows = await prisma.departmentMember.findMany({ where: { departmentId: { in: f.departmentIds } }, select: { userId: true } });
    return new Set(rows.map((r) => r.userId));
  } catch {
    return new Set();
  }
}

export async function resolvePeople(viewerId: string, f: HrFilters) {
  await statusReady();
  const scope = await authorizedPeople(viewerId);
  const inDept = await departmentMembers(f);
  const linked = f.managerIds.length ? await linkedEmployeesOfManagers(f.managerIds) : [];
  const rows = scope.ids.length
    ? await prisma.user.findMany({ where: { id: { in: inDept ? scope.ids.filter((id) => inDept.has(id)) : scope.ids }, ...personWhere(f, linked) }, select: { id: true } })
    : [];
  return { role: scope.role, orgIds: scope.ids, ids: rows.map((r) => r.id), orgTotal: scope.ids.length, filteredTotal: rows.length };
}

/**
 * Narrow a list of people a module has ALREADY decided the viewer may see by the HR filters. It can only remove people, never add; the totals say how
 * many the viewer may see (organization) and how many are left. Used by every report so tables, cards, charts and exports share one list.
 */
export async function narrowIds(ids: string[], f: HrFilters | undefined, opts?: { activeOnly?: boolean }): Promise<{ ids: string[]; scope: { orgTotal: number; filteredTotal: number } }> {
  await statusReady();
  const out = await narrowAll(ids, f);
  if (!opts?.activeOnly) return out;
  // For screens that list only people who are not suspended or exited, the "x of y" counts must describe that same list.
  const live = { status: { notIn: await inactiveStatuses() } };
  const [orgTotal, filteredTotal] = await Promise.all([
    ids.length ? prisma.user.count({ where: { id: { in: ids }, ...live } }) : 0,
    out.ids.length ? prisma.user.count({ where: { id: { in: out.ids }, ...live } }) : 0,
  ]);
  return { ids: out.ids, scope: { orgTotal, filteredTotal } };
}

async function narrowAll(ids: string[], f: HrFilters | undefined): Promise<{ ids: string[]; scope: { orgTotal: number; filteredTotal: number } }> {
  await statusReady();
  if (!f || !isFiltering(f) || ids.length === 0) return { ids, scope: { orgTotal: ids.length, filteredTotal: ids.length } };
  const linked = f.managerIds.length ? await linkedEmployeesOfManagers(f.managerIds) : [];
  const inDept = await departmentMembers(f);
  const rows = await prisma.user.findMany({ where: { id: { in: inDept ? ids.filter((id) => inDept.has(id)) : ids }, ...personWhere(f, linked) }, select: { id: true } });
  return { ids: rows.map((r) => r.id), scope: { orgTotal: ids.length, filteredTotal: rows.length } };
}

const nameOf = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

/**
 * The choices for the filter bar, all from real records and narrowed step by step: companies; projects of the chosen companies; managers of the people
 * in the chosen companies and projects; designations of the people left. Only what the viewer may see is ever listed.
 */
export async function options(viewerId: string, f: HrFilters, withDepartments = false) {
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

  // Departments (Query Desk): only when asked for, with how many of the people the viewer may see are in each.
  let departments: { id: string; name: string; companyId: string; company: string; people: number }[] = [];
  if (withDepartments) {
    try {
      const members = await prisma.departmentMember.findMany({
        where: { userId: { in: scope.ids } },
        select: { departmentId: true, userId: true },
      });
      const depts = await prisma.department.findMany({
        where: { isActive: true, id: { in: [...new Set(members.map((m) => m.departmentId))] } },
        select: { id: true, name: true, platformId: true },
      });
      const names = new Map(base.map((p) => [p.platformId, p.platform.name]));
      const count = new Map<string, number>();
      for (const m of members) count.set(m.departmentId, (count.get(m.departmentId) ?? 0) + 1);
      departments = depts
        .filter((d) => !f.companyIds.length || f.companyIds.includes(d.platformId))
        .map((d) => ({ id: d.id, name: d.name, companyId: d.platformId, company: names.get(d.platformId) ?? "", people: count.get(d.id) ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.company.localeCompare(b.company));
    } catch {
      departments = [];
    }
  }

  const filtered = await resolvePeople(viewerId, f);
  return {
    departments,
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
