import { prisma } from "../../lib/prisma.js";
import { auditNote } from "../../lib/auditContext.js";
import { accessFor, assertCompany, companyAccessReady } from "../../lib/companyAccess.js";

// ---------------------------------------------------------------------------
// COMPANY ADMIN (Phase 1):
//   - the designation lists the dropdown uses (one list per company, no duplicates whatever the capitalisation)
//   - who may act on which companies (company_access grants), changeable only by top management
// Nothing here ever edits a person: a designation list entry never rewrites what someone already has.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/(designations|company_access)/.test(msg) && /does not exist|relation/.test(msg));
};

async function staffAccess(viewerId: string) {
  const a = await accessFor(viewerId);
  if (a.role !== "HR" && a.role !== "ADMIN") throw new Error("NOT_ALLOWED");
  return a;
}

const cleanName = (v: unknown) => String(v ?? "").trim().replace(/\s+/g, " ");

// --- designations --------------------------------------------------------------------------------------------------------

export async function listDesignations(viewerId: string, companyId?: string) {
  const a = await staffAccess(viewerId);
  const platformId = companyId || a.ownPlatformId;
  assertCompany(a, platformId);
  let rows: { id: string; name: string; isActive: boolean }[] = [];
  try {
    rows = await prisma.designation.findMany({ where: { platformId }, select: { id: true, name: true, isActive: true }, orderBy: { name: "asc" } });
  } catch (e) {
    if (!isMissingTable(e)) throw e;
  }
  const people = await prisma.user.groupBy({ by: ["designation"], where: { platformId, designation: { not: null }, status: { not: "EXITED" } }, _count: true });
  const used = new Map(people.map((p) => [String(p.designation).toLowerCase(), p._count]));
  return { companyId: platformId, designations: rows.map((r) => ({ ...r, people: used.get(r.name.toLowerCase()) ?? 0 })) };
}

export async function addDesignation(viewerId: string, body: { companyId?: string; name?: string }) {
  const a = await staffAccess(viewerId);
  const platformId = body.companyId || a.ownPlatformId;
  assertCompany(a, platformId);
  const name = cleanName(body.name);
  if (name.length < 2 || name.length > 80) throw new Error("BAD_NAME");
  const clash = await prisma.designation.findFirst({ where: { platformId, name: { equals: name, mode: "insensitive" } }, select: { id: true, isActive: true } });
  if (clash) throw new Error("DESIGNATION_EXISTS");
  const created = await prisma.designation.create({ data: { platformId, name, createdById: viewerId }, select: { id: true, name: true } });
  auditNote({ module: "Employees", action: "CREATE", platformId, recordType: "Designation", recordId: created.id, summary: `Added the designation "${name}"`, after: { name } });
  return created;
}

export async function updateDesignation(viewerId: string, id: string, body: { name?: string; isActive?: boolean }) {
  const a = await staffAccess(viewerId);
  const row = await prisma.designation.findUnique({ where: { id } });
  if (!row) throw new Error("NOT_FOUND");
  assertCompany(a, row.platformId);
  const data: { name?: string; isActive?: boolean } = {};
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (name.length < 2 || name.length > 80) throw new Error("BAD_NAME");
    const clash = await prisma.designation.findFirst({ where: { platformId: row.platformId, id: { not: id }, name: { equals: name, mode: "insensitive" } }, select: { id: true } });
    if (clash) throw new Error("DESIGNATION_EXISTS");
    data.name = name; // people who already have the old wording keep it; it is only the list that changes
  }
  if (body.isActive !== undefined) data.isActive = body.isActive === true;
  if (Object.keys(data).length === 0) throw new Error("NOTHING_TO_UPDATE");
  await prisma.designation.update({ where: { id }, data });
  auditNote({ module: "Employees", action: "UPDATE", platformId: row.platformId, recordType: "Designation", recordId: id, before: { name: row.name, isActive: row.isActive }, after: data, summary: `Changed the designation "${row.name}"` });
  return { ok: true };
}

// --- who may act on which companies ----------------------------------------------------------------------------------------

type Grants = { all: boolean; companyIds: string[] };

/**
 * Who may hand out company access: top management (everything, including "All companies" and other Admins) and any
 * Admin (specific companies, for HR users only). HR and everyone else: no.
 */
async function grantor(viewerId: string) {
  const [a, me] = await Promise.all([accessFor(viewerId), prisma.user.findUnique({ where: { id: viewerId }, select: { role: true } })]);
  const top = a.all;
  if (!top && me?.role !== "ADMIN") throw new Error("ACCESS_NOT_ALLOWED");
  return { top };
}

/** People with the companies assigned to each. Top management sees HR and Admin; an Admin sees HR users. */
export async function listAccess(viewerId: string) {
  const { top } = await grantor(viewerId);
  const [people, companies] = await Promise.all([
    prisma.user.findMany({ where: { role: { in: top ? ["HR", "ADMIN"] : ["HR"] }, status: { not: "EXITED" } }, select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true, platformId: true, platform: { select: { name: true } } }, orderBy: [{ firstName: "asc" }] }),
    prisma.platform.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  let grants: { userId: string; platformId: string | null }[] = [];
  const ready = await companyAccessReady();
  if (ready) grants = await prisma.companyAccess.findMany({ select: { userId: true, platformId: true } });
  return {
    ready,
    canGrantAll: top,
    companies,
    people: people.map((p) => ({
      id: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      employeeCode: p.employeeCode,
      role: p.role,
      ownCompanyId: p.platformId,
      ownCompany: p.platform.name,
      all: grants.some((g) => g.userId === p.id && g.platformId === null),
      companyIds: grants.filter((g) => g.userId === p.id && g.platformId !== null).map((g) => g.platformId as string),
    })),
  };
}

export async function setAccess(viewerId: string, userId: string, body: Partial<Grants>) {
  const { top } = await grantor(viewerId);
  if (!(await companyAccessReady())) throw new Error("FEATURES_NOT_READY");
  if (userId === viewerId) throw new Error("ACCESS_NOT_ALLOWED"); // nobody widens their own access
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true, firstName: true, lastName: true, platformId: true } });
  if (!target || target.status === "EXITED") throw new Error("NOT_FOUND");
  if (target.role !== "HR" && target.role !== "ADMIN") throw new Error("ACCESS_ONLY_HR_ADMIN");
  // An Admin who is not top management hands out specific companies to HR users only: no "All companies", no changing
  // other Admins, and never overwriting an "All companies" grant someone else made.
  if (!top) {
    if (target.role !== "HR" || body.all === true) throw new Error("ACCESS_NOT_ALLOWED");
    const existingAll = await prisma.companyAccess.findFirst({ where: { userId, platformId: null }, select: { id: true } });
    if (existingAll) throw new Error("ACCESS_NOT_ALLOWED");
  }

  const all = body.all === true;
  const ids = [...new Set((Array.isArray(body.companyIds) ? body.companyIds : []).map(String))].filter((id) => id !== target.platformId);
  if (!all && ids.length) {
    const found = await prisma.platform.count({ where: { id: { in: ids }, isActive: true } });
    if (found !== ids.length) throw new Error("NOT_FOUND");
  }
  const before = await prisma.companyAccess.findMany({ where: { userId }, select: { platformId: true } });
  await prisma.$transaction(async (tx) => {
    await tx.companyAccess.deleteMany({ where: { userId } });
    if (all) await tx.companyAccess.create({ data: { userId, platformId: null, grantedById: viewerId } });
    else if (ids.length) await tx.companyAccess.createMany({ data: ids.map((platformId) => ({ userId, platformId, grantedById: viewerId })) });
  });
  const names = new Map((await prisma.platform.findMany({ select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  const label = (rows: { platformId: string | null }[]) => (rows.some((r) => r.platformId === null) ? "All companies" : rows.map((r) => names.get(r.platformId as string) ?? "?").join(", ") || "Own company only");
  auditNote({
    module: "Employees",
    action: "PERMISSION",
    recordType: "User",
    recordId: userId,
    targetUserId: userId,
    before: { companyAccess: label(before) },
    after: { companyAccess: all ? "All companies" : ids.map((i) => names.get(i) ?? "?").join(", ") || "Own company only" },
    summary: `Changed which companies ${target.firstName} ${target.lastName} can act on`,
  });
  return { ok: true };
}
