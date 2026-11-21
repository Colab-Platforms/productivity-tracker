import { prisma } from "./prisma.js";
import { NOT_ADMIN } from "./tracked.js";
import { getPinnedCompany } from "./deployment.js";

// ---------------------------------------------------------------------------
// PRODUCTIVITY SUPERVISOR
// A person who stays an ordinary EMPLOYEE for everything personal (clock in, tasks, leave, profile) and, on top of that, may READ every
// employee's productivity data in every company. It is NOT a role in the role list: the account keeps role EMPLOYEE, and one row in
// `productivity_supervisors` (written only by backend/scripts/provision-supervisors.cjs, never by an API route) adds the monitoring view.
//
// This is VIEWING only. Every route that changes something (approve, rate, delete, assign, edit, release...) keeps its own role check, and an
// EMPLOYEE role fails all of them, so the supervisor cannot act on anyone else's records.
// Before the migration the table does not exist: nobody is a supervisor and every screen behaves exactly as before.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/productivity_supervisors/.test(msg) && /does not exist|relation/.test(msg));
};

let readyValue = false;
let readyCheckedAt = 0;
export async function supervisorsReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await prisma.productivitySupervisor.findFirst({ select: { id: true } });
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

/** Read from the database on every call (a removed row stops working at once). Only an ACTIVE person with the EMPLOYEE role can be one. */
export async function isSupervisor(userId: string): Promise<boolean> {
  if (!(await supervisorsReady())) return false;
  let row: { userId: string } | null;
  try {
    row = await prisma.productivitySupervisor.findUnique({ where: { userId }, select: { userId: true } });
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false; // the table went away (a rollback): nobody is a supervisor until it is back
    return false;
  }
  if (!row) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
  // If the person is ever promoted to Manager/HR/Admin, that role's own rules apply and the supervisor row is ignored.
  return !!u && String(u.role) === "EMPLOYEE" && String(u.status) === "ACTIVE";
}

/** Every company the supervisor may monitor: all of them, except that a deployment pinned to one company keeps only that one. */
export async function monitoringWhere(): Promise<{ platformId?: string }> {
  const pinned = await getPinnedCompany();
  return pinned ? { platformId: pinned.id } : {};
}

/** The people the supervisor may see: every active or invited person of every company in scope (the same population HR with all-company access sees). */
export async function monitoringIds(): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { ...(await monitoringWhere()), status: { in: ["ACTIVE", "INVITED"] }, ...NOT_ADMIN },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
