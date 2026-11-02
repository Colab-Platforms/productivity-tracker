import { prisma } from "../../lib/prisma.js";
import { getPinnedCompany } from "../../lib/deployment.js";
import { auditNote, changedFields } from "../../lib/auditContext.js";
import { accessFor } from "../../lib/companyAccess.js";
import { canAccess } from "../../lib/companyAccess.logic.js";

// ---------------------------------------------------------------------------
// COMPANY MANAGEMENT (HR and Admin only; the routes enforce the role)
//
// A company is a row in `platforms`. This only manages the company record
// itself (name, legal name, timezone, employee-code prefix, active or not).
//   - Everyone with HR/Admin can see the list of company names.
//   - Employee numbers and details are only shown for the viewer's OWN company.
//   - Someone can edit only the companies they may act on: their own, the ones assigned to them (company_access), or all (top management).
//   - The employee-ID prefix is set by an Admin or top management only; two companies can never share one, whatever the capitalisation.
//   - Nobody can deactivate their own company, or the one this deployment is
//     pinned to, because that would lock them out.
// ---------------------------------------------------------------------------

async function who(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, platformId: true } });
  if (!u) throw new Error("USER_NOT_FOUND");
  const role = String(u.role);
  if (role !== "HR" && role !== "ADMIN") throw new Error("NOT_ALLOWED");
  return { id: u.id, role, platformId: u.platformId };
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

function checkTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new Error("BAD_TIMEZONE");
  }
}

function cleanPrefix(v: unknown) {
  const s = String(v ?? "").trim().toUpperCase();
  if (!s) return null;
  if (!/^[A-Z0-9]{2,8}$/.test(s)) throw new Error("BAD_PREFIX");
  return s;
}

export async function listCompanies(viewerId: string) {
  const v = await who(viewerId);
  const access = await accessFor(viewerId);
  const [rows, pinned, counts] = await Promise.all([
    prisma.platform.findMany({ orderBy: { name: "asc" } }),
    getPinnedCompany(),
    prisma.user.groupBy({ by: ["platformId"], where: { status: { not: "EXITED" } }, _count: true }),
  ]);
  const headcount = new Map(counts.map((c) => [c.platformId, c._count]));
  return {
    pinnedTo: pinned ? { id: pinned.id, name: pinned.name } : null,
    canCreate: true,
    companies: rows.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      legalName: c.legalName,
      timezone: c.timezone,
      employeeCodePrefix: c.employeeCodePrefix,
      isActive: c.isActive,
      isYours: c.id === v.platformId,
      isPinned: pinned?.id === c.id,
      // Employee numbers only for the companies this person may act on.
      employees: canAccess(access, c.id) ? headcount.get(c.id) ?? 0 : null,
      canEdit: canAccess(access, c.id),
      canSetPrefix: canAccess(access, c.id) && (v.role === "ADMIN" || access.all),
    })),
  };
}

type Body = { name?: string; legalName?: string | null; timezone?: string; employeeCodePrefix?: string | null; isActive?: boolean };

export async function createCompany(viewerId: string, body: Body) {
  await who(viewerId);
  const name = String(body.name ?? "").trim();
  if (name.length < 2) throw new Error("NAME_REQUIRED");
  if (name.length > 80) throw new Error("NAME_TOO_LONG");

  const slug = slugify(name);
  if (!slug) throw new Error("NAME_REQUIRED");
  const clash = await prisma.platform.findFirst({ where: { OR: [{ slug }, { name: { equals: name, mode: "insensitive" } }] }, select: { id: true } });
  if (clash) throw new Error("COMPANY_EXISTS");

  const newPrefix = cleanPrefix(body.employeeCodePrefix);
  if (newPrefix) {
    const taken = await prisma.platform.findFirst({ where: { employeeCodePrefix: { equals: newPrefix, mode: "insensitive" } }, select: { id: true } });
    if (taken) throw new Error("PREFIX_TAKEN");
  }
  const created = await prisma.platform.create({
    data: {
      name,
      slug,
      legalName: String(body.legalName ?? "").trim() || null,
      timezone: checkTimezone(String(body.timezone ?? "Asia/Kolkata")),
      employeeCodePrefix: cleanPrefix(body.employeeCodePrefix),
    },
  });
  return { id: created.id, slug: created.slug };
}

export async function updateCompany(viewerId: string, id: string, body: Body) {
  const v = await who(viewerId);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("NOT_FOUND");
  const company = await prisma.platform.findUnique({ where: { id } });
  if (!company) throw new Error("NOT_FOUND");
  // Only a company this person may act on (own, assigned, or all for top management).
  const access = await accessFor(viewerId);
  if (!canAccess(access, company.id)) throw new Error("NOT_YOUR_COMPANY");

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length < 2) throw new Error("NAME_REQUIRED");
    if (name.length > 80) throw new Error("NAME_TOO_LONG");
    const clash = await prisma.platform.findFirst({ where: { id: { not: id }, name: { equals: name, mode: "insensitive" } }, select: { id: true } });
    if (clash) throw new Error("COMPANY_EXISTS");
    data.name = name; // the slug stays fixed: it is how a deployment is pinned
  }
  if (body.legalName !== undefined) data.legalName = String(body.legalName ?? "").trim() || null;
  if (body.timezone !== undefined) data.timezone = checkTimezone(String(body.timezone));
  let prefixChanged = false;
  if (body.employeeCodePrefix !== undefined) {
    const next = cleanPrefix(body.employeeCodePrefix);
    if (next !== (company.employeeCodePrefix ?? null)) {
      // Setting the prefix decides how every future ID of the company looks: Admin or top management only.
      if (v.role !== "ADMIN" && !access.all) throw new Error("PREFIX_NOT_ALLOWED");
      if (next) {
        const taken = await prisma.platform.findFirst({ where: { id: { not: id }, employeeCodePrefix: { equals: next, mode: "insensitive" } }, select: { id: true } });
        if (taken) throw new Error("PREFIX_TAKEN");
      }
      data.employeeCodePrefix = next;
      prefixChanged = true;
    }
  }
  if (body.isActive !== undefined) {
    const pinned = await getPinnedCompany();
    if (body.isActive === false && (company.id === v.platformId || pinned?.id === company.id)) throw new Error("CANNOT_DEACTIVATE");
    data.isActive = body.isActive === true;
  }
  if (Object.keys(data).length === 0) throw new Error("NOTHING_TO_UPDATE");

  await prisma.platform.update({ where: { id }, data });
  // A new prefix starts its own count above the highest number it already has. Existing IDs are never touched.
  if (prefixChanged) await prisma.employeeCodeSequence.deleteMany({ where: { platformId: id } }).catch(() => undefined);
  const diff = changedFields(company as never, { ...company, ...data } as never, ["name", "legalName", "timezone", "employeeCodePrefix", "isActive"]);
  auditNote({ platformId: company.id, recordType: "Platform", recordId: company.id, before: diff.before, after: diff.after, summary: `Edited company ${company.name}: ${Object.keys(diff.after as Record<string, unknown>).join(", ") || "no changes"}` });
  return { ok: true };
}
