// ===========================================================================
// OWNER ACCESS (top management)
//
// "Owner" now means: HR/Admin whose employee code is in OWNER_CODES, or who holds an all-companies grant in company_access
// (see companyAccess.ts, the one place that decides which companies a person may act on). Per-company grants (HR assigned to
// specific companies) are read from companyAccess.ts directly by the modules that support them.
// A deployment pinned to one company switches owner reach off.
// ===========================================================================

import { accessFor } from "./companyAccess.js";

export { ownerCodes } from "./companyAccess.logic.js";

export async function viewerIsOwner(viewerId: string): Promise<boolean> {
  return (await accessFor(viewerId)).all;
}

// ---------------------------------------------------------------------------
// OWNER ADMINS: the company owners. They are ADMIN accounts that hold the all-companies grant in company_access (or whose code is in
// OWNER_CODES). They are identified by database id + role + grant, never by display name. They are not regular employees for the
// document workflow: they owe no personal documents, are never reminded, never counted as "missing documents" and never listed in
// document tracking. Nothing else about their Admin access changes. HR accounts with an all-companies grant are NOT owner admins.
// Independent of a deployment pin (a pin narrows reach, it does not turn an owner into an employee).
// ---------------------------------------------------------------------------
import { prisma } from "./prisma.js";
import { companyAccessReady } from "./companyAccess.js";
import { ownerCodes as ownerCodeList } from "./companyAccess.logic.js";

/** Ids of every ACTIVE-or-not ADMIN user who is an owner (all-companies grant or owner code). Two small reads, no per-person queries. */
export async function ownerAdminIds(): Promise<string[]> {
  const codes = ownerCodeList();
  const granted = (await companyAccessReady()) ? await prisma.companyAccess.findMany({ where: { platformId: null }, select: { userId: true } }) : [];
  const or: object[] = [];
  if (granted.length) or.push({ id: { in: granted.map((g) => g.userId) } });
  if (codes.length) or.push({ employeeCode: { in: codes } });
  if (!or.length) return [];
  const rows = await prisma.user.findMany({ where: { role: "ADMIN", OR: or }, select: { id: true } });
  return rows.map((r) => r.id);
}

export async function isOwnerAdmin(userId: string): Promise<boolean> {
  return (await ownerAdminIds()).includes(userId);
}
