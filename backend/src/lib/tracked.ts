// ---------------------------------------------------------------------------
// WHO IS TRACKED. Admin accounts (owners / top management) are NOT employees for attendance, productivity, headcount, the employee sheets, alerts
// or reports: they are never counted as present, absent, late or unproductive, and no attendance is recorded for them (owner decision 2026-11-21).
// Their accounts stay active, they keep every Admin permission and they still SEE everyone they are allowed to see; they are only left out of the
// people being measured. One condition, used by every list of measured people, so no report can disagree with another about it.
// ---------------------------------------------------------------------------
import { prisma } from "./prisma.js";

/** Add to any Prisma `where` on users that lists people to MEASURE (attendance, productivity, headcount, alerts). */
export const NOT_ADMIN = { role: { not: "ADMIN" as const } };

/** Drop Admin accounts from a list of user ids (one query). */
export async function withoutAdmins(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return ids;
  const admins = new Set((await prisma.user.findMany({ where: { id: { in: ids }, role: "ADMIN" as never }, select: { id: true } })).map((u) => u.id));
  return admins.size ? ids.filter((id) => !admins.has(id)) : ids;
}
