// Project names and the reporting manager of a list of people, for the report exports. READ-ONLY and batched (two reads, never one per
// person). It only describes people a report has already decided the viewer may see; it never widens a list.

import { prisma } from "../../lib/prisma.js";

export type PersonDetails = { projects: string[]; reportingManager: string | null };

export async function projectsAndManagers(userIds: string[]): Promise<Map<string, PersonDetails>> {
  const out = new Map<string, PersonDetails>();
  if (userIds.length === 0) return out;
  const [members, people] = await Promise.all([
    prisma.teamMember.findMany({ where: { userId: { in: userIds }, isActive: true, team: { isActive: true } }, select: { userId: true, team: { select: { name: true } } } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, reportsTo: { select: { firstName: true, lastName: true } } } }),
  ]);
  for (const p of people) out.set(p.id, { projects: [], reportingManager: p.reportsTo ? `${p.reportsTo.firstName} ${p.reportsTo.lastName}`.trim() : null });
  for (const m of members) out.get(m.userId)?.projects.push(m.team.name);
  for (const d of out.values()) d.projects.sort((a, b) => a.localeCompare(b));
  return out;
}
