import { prisma } from "./prisma.js";
import { getPinnedCompany } from "./deployment.js";
import { canAccess, ownerCodes, resolveAccess, type Access } from "./companyAccess.logic.js";

// ---------------------------------------------------------------------------
// COMPANY ACCESS (database side). One place that answers "which companies may this person act on?" so Leave, Corrections, Policies,
// Admin and the employee screens all agree. Before the migration (no company_access table) it behaves exactly like the old
// owner-code rule: owners see everything, everyone else only their own company.
// ---------------------------------------------------------------------------

export type { Access };

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/company_access/.test(msg) && /does not exist|relation/.test(msg));
};

let readyValue = false;
let readyCheckedAt = 0;
export async function companyAccessReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await prisma.companyAccess.findFirst({ select: { id: true } });
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

async function grantsOf(userId: string): Promise<{ platformId: string | null }[]> {
  if (!(await companyAccessReady())) return [];
  return prisma.companyAccess.findMany({ where: { userId }, select: { platformId: true } });
}

/** The companies this person may act on, read from the database on every call (a removed grant stops working at once). */
export async function accessFor(viewerId: string): Promise<Access & { role: string; ownPlatformId: string }> {
  const u = await prisma.user.findUnique({ where: { id: viewerId }, select: { role: true, platformId: true, employeeCode: true } });
  if (!u) throw new Error("NOT_FOUND");
  const pinned = await getPinnedCompany();
  const a = resolveAccess({
    role: String(u.role),
    ownPlatformId: u.platformId,
    grants: await grantsOf(viewerId),
    isOwnerCode: ownerCodes().includes(String(u.employeeCode ?? "").toUpperCase()),
    pinnedPlatformId: pinned?.id ?? null,
  });
  return { ...a, role: String(u.role), ownPlatformId: u.platformId };
}

/** A Prisma `where` fragment limiting a query to the companies this person may see. */
export const scopeWhere = (a: Access): { platformId?: { in: string[] } } => (a.all ? {} : { platformId: { in: a.ids } });

/** Throws NOT_FOUND (never "forbidden", so ids from other companies are not even confirmed to exist). */
export function assertCompany(a: Access, platformId: string | null | undefined) {
  if (!platformId || !canAccess(a, platformId)) throw new Error("NOT_FOUND");
}

/** HR/Admin who decide requests of a company: its own HR/Admin, people granted that company (or all), and owner codes.
 *  A deployment pinned to another company never reaches here (the pinned company is the only one that exists for it). */
export async function deciderIdsForCompany(platformId: string, exceptUserId?: string): Promise<string[]> {
  const pinned = await getPinnedCompany();
  const owners = pinned ? [] : ownerCodes();
  const granted = (await companyAccessReady()) && !pinned
    ? await prisma.companyAccess.findMany({ where: { OR: [{ platformId }, { platformId: null }] }, select: { userId: true } })
    : [];
  const rows = await prisma.user.findMany({
    where: {
      role: { in: ["HR", "ADMIN"] },
      status: "ACTIVE",
      ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
      OR: [
        { platformId },
        ...(granted.length ? [{ id: { in: granted.map((g) => g.userId) } }] : []),
        ...(owners.length ? [{ employeeCode: { in: owners } }] : []),
      ],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
