import { prisma } from "../../lib/prisma.js";
import { accessFor } from "../../lib/companyAccess.js";
import { canAccess } from "../../lib/companyAccess.logic.js";
import { auditNote } from "../../lib/auditContext.js";
import { platformToday } from "../../lib/dates.js";
import { checkPersonal, compare, LABEL, PERSONAL_FIELDS, SENSITIVE, type PersonalField, type PersonalValues } from "./personal.logic.js";

// ---------------------------------------------------------------------------
// EMPLOYEE PERSONAL DETAILS (table employee_personal_details, new, one row per person).
//   read   : the person themselves, and HR / Admin for the companies they act on (company access rule). Managers and colleagues: never.
//   change : HR / Admin for the companies they act on, never anyone else (not even the person). Someone who may not see a record is told it does not exist.
// Before the migration (no table) nothing can be saved and every read says "not ready"; nothing else in the profile is affected.
// The audit log records WHICH fields changed, never the sensitive values (date of birth, address, phone, gender, marital status).
// ---------------------------------------------------------------------------

// "Not ready" = the table is missing (P2021) OR it exists without one of today's columns (P2022, e.g. it was created from an earlier version of the migration).
const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || code === "P2022" || (/employee_personal_details/.test(msg) && /does not exist|relation|column/.test(msg)) || /column .* does not exist/.test(msg);
};
let readyValue = false;
let readyAt = 0;
let checking: Promise<boolean> | null = null;
export async function personalReady(): Promise<boolean> {
  if (readyValue) return true;
  if (checking) return checking;
  if (Date.now() - readyAt < 15_000) return false;
  checking = (async () => {
    try {
      await prisma.employeePersonalDetails.findFirst(); // all columns on purpose: a missing column must read as "not ready", never crash a screen
      readyValue = true;
    } catch (e) {
      if (!isMissingTable(e)) throw e;
      readyValue = false;
    }
    readyAt = Date.now();
    return readyValue;
  })().finally(() => { checking = null; });
  return checking;
}

type Row = Record<PersonalField, string | null>;
function toValues(r: { [k: string]: unknown } | null): PersonalValues {
  const out: PersonalValues = {};
  if (!r) return out;
  for (const f of PERSONAL_FIELDS) {
    const v = r[f];
    out[f] = v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? null : String(v);
  }
  return out;
}

async function viewerOf(id: string) {
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, platformId: true } });
  if (!u) throw new Error("NOT_FOUND");
  const a = await accessFor(id);
  return { id: u.id, role: String(u.role), platformId: u.platformId, access: { all: a.all, ids: a.ids } };
}
const isStaff = (role: string) => role === "HR" || role === "ADMIN";
const mayReach = (v: Awaited<ReturnType<typeof viewerOf>>, platformId: string) => isStaff(v.role) && canAccess({ all: v.access.all, ids: v.access.ids }, platformId);

/** Read the details of ONE person. The person themselves, or HR/Admin who act on their company. */
export async function getDetails(viewerId: string, targetId: string) {
  const v = await viewerOf(viewerId);
  const t = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, platformId: true, employeeCode: true, firstName: true, lastName: true } });
  if (!t || (t.id !== v.id && !mayReach(v, t.platformId))) throw new Error("NOT_FOUND");
  const ready = await personalReady();
  const row = ready ? await prisma.employeePersonalDetails.findUnique({ where: { userId: targetId } }) : null;
  return { ready, canEdit: mayReach(v, t.platformId) && ready, employeeCode: t.employeeCode, values: toValues(row as never), entered: !!row };
}

/** Save the fields the caller sends (HR/Admin only). Blank or missing = left as it is; null = cleared on purpose. Returns what changed. */
export async function saveDetails(viewerId: string, targetId: string, input: Record<string, unknown>) {
  const v = await viewerOf(viewerId);
  const t = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, platformId: true, firstName: true, lastName: true, platform: { select: { timezone: true } } } });
  if (!t || !mayReach(v, t.platformId)) throw new Error("NOT_FOUND");
  if (!(await personalReady())) throw new Error("FEATURES_NOT_READY");
  const today = platformToday(t.platform?.timezone ?? "Asia/Kolkata").toISOString().slice(0, 10);
  const checked = checkPersonal(input ?? {}, today);
  if (checked.errors.length) throw Object.assign(new Error("INVALID_DETAILS"), { details: checked.errors });
  const proposed = checked.values;
  if (Object.keys(proposed).length === 0) throw new Error("NOTHING_TO_SAVE");

  const current = toValues((await prisma.employeePersonalDetails.findUnique({ where: { userId: targetId } })) as never);
  const changes = compare(current, proposed).filter((c) => c.kind !== "same");
  if (changes.length === 0) return { changed: [] as string[], unchanged: true };
  const data: Record<string, unknown> = {};
  for (const c of changes) {
    const val = proposed[c.field] ?? null;
    data[c.field] = c.field === "dateOfBirth" && val ? new Date(`${val}T00:00:00.000Z`) : val;
  }
  await prisma.employeePersonalDetails.upsert({
    where: { userId: targetId },
    create: { userId: targetId, platformId: t.platformId, updatedById: viewerId, ...data } as never,
    update: { updatedById: viewerId, ...data } as never,
  });
  const names = changes.map((c) => LABEL[c.field]);
  const open = changes.filter((c) => !SENSITIVE.includes(c.field));
  // which fields changed is recorded; the sensitive values themselves never are
  auditNote({
    module: "Employees", action: "UPDATE", recordType: "User", recordId: targetId, targetUserId: targetId, platformId: t.platformId,
    summary: `Updated personal details of ${t.firstName} ${t.lastName}: ${names.join(", ")}`,
    before: Object.fromEntries(open.map((c) => [LABEL[c.field], c.current])),
    after: Object.fromEntries(open.map((c) => [LABEL[c.field], c.proposed])),
  });
  return { changed: names, unchanged: false, kinds: Object.fromEntries(changes.map((c) => [c.field, c.kind])) };
}

/** For the Update Employees preview and commit: the stored values of many people at once (one batched read; empty before the migration). */
export async function currentFor(userIds: string[]): Promise<Map<string, PersonalValues>> {
  const out = new Map<string, PersonalValues>();
  if (userIds.length === 0 || !(await personalReady())) return out;
  const rows = await prisma.employeePersonalDetails.findMany({ where: { userId: { in: userIds } } });
  for (const r of rows) out.set(r.userId, toValues(r as never));
  return out;
}
export type { Row };
