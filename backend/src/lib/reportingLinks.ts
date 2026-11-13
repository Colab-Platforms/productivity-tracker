import { prisma } from "./prisma.js";

// ADDITIONAL REPORTING MANAGERS (table `reporting_manager_links`, see prisma/schema/reportingLinks.prisma).
// The main reporting manager is still `users.reportsToId`. These helpers add the extra managers on top. Before the migration is applied the table does
// not exist: every function then answers "no extra managers" and never throws, so nothing changes for anyone.

let known: boolean | null = null;
let checkedAt = 0;

export async function linksReady(): Promise<boolean> {
  if (known === true) return true;
  if (known === false && Date.now() - checkedAt < 30_000) return false; // look again soon: the migration may be applied while the server runs
  try {
    await prisma.reportingManagerLink.count({ take: 1 });
    known = true;
  } catch {
    known = false;
  }
  checkedAt = Date.now();
  return known;
}

/** The people this manager is an ADDITIONAL reporting manager of (employee ids). */
export async function linkedReportIds(managerId: string): Promise<string[]> {
  if (!(await linksReady())) return [];
  try {
    return (await prisma.reportingManagerLink.findMany({ where: { managerId }, select: { userId: true } })).map((r) => r.userId);
  } catch {
    return [];
  }
}

/** For each of these people, the ids of their additional managers. */
export async function linkedManagerIdsOf(userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (userIds.length === 0 || !(await linksReady())) return out;
  try {
    const rows = await prisma.reportingManagerLink.findMany({ where: { userId: { in: userIds } }, select: { userId: true, managerId: true } });
    for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r.managerId]);
  } catch {
    /* table missing: no extra managers */
  }
  return out;
}

/** Employees who have any of these managers as an additional manager (used by the "Reporting manager" filter). */
export async function linkedEmployeesOfManagers(managerIds: string[]): Promise<string[]> {
  if (managerIds.length === 0 || !(await linksReady())) return [];
  try {
    return [...new Set((await prisma.reportingManagerLink.findMany({ where: { managerId: { in: managerIds } }, select: { userId: true } })).map((r) => r.userId))];
  } catch {
    return [];
  }
}

/** Is this manager an additional manager of this person? */
export async function isLinkedManager(managerId: string, userId: string): Promise<boolean> {
  if (!(await linksReady())) return false;
  try {
    return (await prisma.reportingManagerLink.count({ where: { managerId, userId } })) > 0;
  } catch {
    return false;
  }
}

/** Distinct manager ids that have at least one linked report (they are "someone's reporting manager" for the task-tag list). */
export async function allLinkedManagerIds(): Promise<string[]> {
  if (!(await linksReady())) return [];
  try {
    return (await prisma.reportingManagerLink.findMany({ select: { managerId: true }, distinct: ["managerId"] })).map((r) => r.managerId);
  } catch {
    return [];
  }
}
