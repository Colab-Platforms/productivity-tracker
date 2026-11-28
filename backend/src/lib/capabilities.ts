// PER-PERSON CAPABILITIES: a named extra permission held by one account, separate from the person's role. A capability never changes the role (the person
// stays an Employee) and is never decided by a name or an e-mail address: it is a row in `user_capabilities` for that person's immutable user id.
//
//   TASK_APPROVE_COMPANY may be TAGGED as the approving manager of employees' daily tasks and decide (approve, reject, rate...) ONLY the tasks tagged to them.
//                        Nothing else: no queue of other people's tasks, no role change.
//   TASK_ASSIGN_COMPANY  may assign tasks to ACTIVE employees of their OWN company through the existing assigned-task workflow, and follow what they assigned.
//                        It does NOT include approving or rating tasks, confirming a finished assigned task, or any other manager/Admin right.
//
// Read from the database on every call (a removed row stops working at once). Rows are written only by scripts/provision-capabilities.cjs.
// Before the migration (20261124100000_user_capabilities) the table does not exist: nobody holds a capability and the rest of the app is unaffected.
import { prisma } from "./prisma.js";

export const CAP_TASK_ASSIGN_COMPANY = "TASK_ASSIGN_COMPANY" as const;
export const CAP_TASK_APPROVE_COMPANY = "TASK_APPROVE_COMPANY" as const;
export type Capability = typeof CAP_TASK_ASSIGN_COMPANY | typeof CAP_TASK_APPROVE_COMPANY;

let ready: boolean | null = null;
let checkedAt = 0;
let checking: Promise<boolean> | null = null;
export async function capabilitiesReady(): Promise<boolean> {
  if (ready === true) return true;
  if (checking) return checking; // a check already running: share its answer (never tell a second caller "not ready" while the first check is in flight)
  if (ready === false && Date.now() - checkedAt < 15_000) return false;
  checking = (async () => {
    try {
      const r = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from pg_class where relname = 'user_capabilities' and relkind = 'r'`;
      ready = (r[0]?.n ?? 0) === 1;
    } catch { ready = false; }
    checkedAt = Date.now();
    return ready;
  })().finally(() => { checking = null; });
  return checking;
}

/**
 * Does this ACTIVE person hold the capability? A capability is honoured only for the Employee role (the supervisors keep their Employee role): someone
 * later promoted to Manager, HR or Admin follows the rules of that role instead, never a leftover capability row.
 */
export async function hasCapability(userId: string, capability: Capability): Promise<boolean> {
  if (!(await capabilitiesReady())) return false;
  try {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      select count(*)::int n
      from user_capabilities c join users u on u.id = c."userId"
      where c."userId" = ${userId}::uuid and c.capability = ${capability}
        and u.status::text = 'ACTIVE' and u.role::text = 'EMPLOYEE'`;
    return (rows[0]?.n ?? 0) > 0;
  } catch {
    // the table vanished (a rolled-back migration): nobody holds a capability, and the next call re-checks
    ready = false;
    checkedAt = Date.now();
    return false;
  }
}

/** Active Employee accounts that hold a capability (for the "Tag Reporting Manager" list). Empty before the migration. */
export async function holdersOf(capability: Capability): Promise<{ id: string; firstName: string; lastName: string; employeeCode: string | null; platformId: string }[]> {
  if (!(await capabilitiesReady())) return [];
  try {
    return await prisma.$queryRaw<{ id: string; firstName: string; lastName: string; employeeCode: string | null; platformId: string }[]>`
      select u.id, u."firstName", u."lastName", u."employeeCode", u."platformId"
      from user_capabilities c join users u on u.id = c."userId"
      where c.capability = ${capability} and u.status::text = 'ACTIVE' and u.role::text = 'EMPLOYEE'`;
  } catch {
    ready = false;
    checkedAt = Date.now();
    return [];
  }
}
