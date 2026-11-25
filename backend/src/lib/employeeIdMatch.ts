import { prisma } from "./prisma.js";

// Typing slips people really make when entering an employee ID ("AWL -03", "AWL- 03", "Avance07", "ssb0004").
// The comparison key ignores case, spaces, hyphens and underscores. A key is only ever used when it points at EXACTLY ONE person:
// two or more candidates means no match at all (never a guess). The password is still required wherever this is used.
export const looseKey = (id: string) => id.toLowerCase().replace(/[\s_-]+/g, "");

/** The id of the one person whose employee ID equals this once spaces, hyphens and underscores are ignored; null when none or ambiguous. */
export async function findLooseUserId(typed: string): Promise<string | null> {
  const key = looseKey(typed);
  if (key.length < 3) return null;
  const hit = await prisma.$queryRaw<{ id: string }[]>`select id from users where lower(regexp_replace("employeeCode", '[[:space:]_-]+', '', 'g')) = ${key} limit 2`;
  return hit.length === 1 ? hit[0].id : null;
}
