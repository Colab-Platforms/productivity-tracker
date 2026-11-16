import { prisma } from "../../lib/prisma.js";
import { accessFor } from "../../lib/companyAccess.js";
import { canAccess } from "../../lib/companyAccess.logic.js";
import { auditNote } from "../../lib/auditContext.js";
import { DEFAULT_ALLOWED_DAYS, MAX_BACKDATE_DAYS, parseAllowedDays } from "./tasks.late.logic.js";

// ---------------------------------------------------------------------------
// LATE SUBMISSIONS (database side). Before migration 20261116110000_task_late_submissions the tables do not exist: lateReady() is false,
// every read returns nothing, the policy is the default, and a request for a previous date is refused (never silently accepted).
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/task_late_/.test(msg) && /does not exist|relation/.test(msg));
};

let readyValue = false;
let readyCheckedAt = 0;
export async function lateReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await prisma.taskLateDetail.findFirst({ select: { id: true } });
    await prisma.taskLatePolicy.findFirst({ select: { id: true } });
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

/** How many previous days this company allows without a reason (the default until an Admin saves one). */
export async function allowedDaysFor(platformId: string): Promise<number> {
  if (!(await lateReady())) return DEFAULT_ALLOWED_DAYS;
  const row = await prisma.taskLatePolicy.findUnique({ where: { platformId }, select: { allowedDays: true } });
  return row ? row.allowedDays : DEFAULT_ALLOWED_DAYS;
}

export type LateView = { lateByDays: number; outsideWindow: boolean; allowedDays: number; reason: string | null; submittedAt: string };

/** The late-submission details of these tasks (a task not in the map is a normal, on-the-day submission). */
export async function lateDetailsFor(taskIds: string[]): Promise<Map<string, LateView>> {
  const out = new Map<string, LateView>();
  if (taskIds.length === 0 || !(await lateReady())) return out;
  const rows = await prisma.taskLateDetail.findMany({ where: { taskId: { in: taskIds } } });
  for (const r of rows) out.set(r.taskId, { lateByDays: r.lateByDays, outsideWindow: r.outsideWindow, allowedDays: r.allowedDays, reason: r.reason, submittedAt: r.createdAt.toISOString() });
  return out;
}

/** What the screen needs to decide which dates to offer. */
export async function policyFor(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { platformId: true } });
  if (!u) throw new Error("USER_NOT_FOUND");
  return { ready: await lateReady(), allowedDays: await allowedDaysFor(u.platformId), maxDays: MAX_BACKDATE_DAYS };
}

/** Admin: the setting for every company they act on. */
export async function listPolicies(adminId: string) {
  const access = await accessFor(adminId);
  const companies = await prisma.platform.findMany({ where: access.all ? {} : { id: { in: access.ids } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const ready = await lateReady();
  const rows = ready ? await prisma.taskLatePolicy.findMany({ where: { platformId: { in: companies.map((c) => c.id) } } }) : [];
  const byCompany = new Map(rows.map((r) => [r.platformId, r.allowedDays]));
  return { ready, maxDays: MAX_BACKDATE_DAYS, defaultDays: DEFAULT_ALLOWED_DAYS, companies: companies.map((c) => ({ id: c.id, name: c.name, allowedDays: byCompany.get(c.id) ?? DEFAULT_ALLOWED_DAYS })) };
}

/** Admin: set the number of previous days (0 to 14) for one company they act on. */
export async function setPolicy(adminId: string, companyId: unknown, days: unknown) {
  if (!(await lateReady())) throw new Error("FEATURES_NOT_READY");
  const n = parseAllowedDays(days);
  if (n === "BAD") throw new Error("BAD_ALLOWED_DAYS");
  const access = await accessFor(adminId);
  const platformId = typeof companyId === "string" && companyId ? companyId : access.ownPlatformId;
  if (!canAccess(access, platformId)) throw new Error("NOT_FOUND");
  const company = await prisma.platform.findUnique({ where: { id: platformId }, select: { id: true, name: true } });
  if (!company) throw new Error("NOT_FOUND");
  const before = await allowedDaysFor(platformId);
  await prisma.taskLatePolicy.upsert({ where: { platformId }, create: { platformId, allowedDays: n, updatedById: adminId }, update: { allowedDays: n, updatedById: adminId } });
  auditNote({ summary: `Changed the previous-day task window for ${company.name} from ${before} to ${n} day${n === 1 ? "" : "s"}` });
  return listPolicies(adminId);
}
