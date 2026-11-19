import { prisma } from "../../lib/prisma.js";
import { type HrFilters } from "../hr-filters/hrFilters.logic.js";
import { resolvePeople } from "../hr-filters/hrFilters.service.js";

// ---------------------------------------------------------------------------
// PRODUCTIVITY SUPERVISOR — "All Employees". A READ-ONLY directory of every active person in every company, narrowed by the shared HR filters
// (name or ID, company, project, reporting manager, department, designation). It shows who people are and where they sit; productivity,
// attendance and tasks live on their own monitoring pages. Nothing here writes anything, and no contact or pay detail is returned.
// ---------------------------------------------------------------------------

export async function listEmployees(viewerId: string, filters: HrFilters) {
  const resolved = await resolvePeople(viewerId, filters);
  const ids = resolved.ids;
  const scope = { orgTotal: resolved.orgTotal, filteredTotal: resolved.filteredTotal };
  if (ids.length === 0) return { scope, rows: [] as unknown[] };

  const [people, deptRows] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        employeeCode: true,
        designation: true,
        status: true,
        platformId: true,
        platform: { select: { name: true } },
        reportsTo: { select: { firstName: true, lastName: true } },
        teamMemberships: { where: { isActive: true, team: { isActive: true } }, select: { team: { select: { id: true, name: true } } } },
      },
      orderBy: [{ platform: { name: "asc" } }, { firstName: "asc" }, { lastName: "asc" }],
    }),
    // departments: batched, and a missing table simply means none
    prisma.departmentMember.findMany({ where: { userId: { in: ids } }, select: { userId: true, departmentId: true } }).catch(() => []),
  ]);
  const deptNames = new Map<string, string>();
  const deptIds = [...new Set(deptRows.map((d) => d.departmentId))];
  if (deptIds.length) {
    const ds = await prisma.department.findMany({ where: { id: { in: deptIds }, isActive: true }, select: { id: true, name: true } }).catch(() => []);
    for (const d of ds) deptNames.set(d.id, d.name);
  }
  const deptOf = new Map<string, string[]>();
  for (const d of deptRows) {
    const n = deptNames.get(d.departmentId);
    if (n) deptOf.set(d.userId, [...(deptOf.get(d.userId) ?? []), n]);
  }

  return {
    scope,
    rows: people.map((p) => ({
      userId: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      employeeCode: p.employeeCode,
      designation: p.designation,
      status: String(p.status),
      company: p.platform.name,
      companyId: p.platformId,
      reportingManager: p.reportsTo ? `${p.reportsTo.firstName} ${p.reportsTo.lastName}`.trim() : null,
      projects: [...new Set(p.teamMemberships.map((m) => m.team.name))],
      departments: deptOf.get(p.id) ?? [],
    })),
  };
}
