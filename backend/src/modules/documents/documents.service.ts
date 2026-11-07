import { prisma } from "../../lib/prisma.js";
import { isOwnerAdmin, ownerAdminIds } from "../../lib/owner.js";
import { auditNote } from "../../lib/auditContext.js";
import { isApplicable, scopeMap, typesOf } from "../onboarding/onboarding.service.js";

// ---------------------------------------------------------------------------
// DOCUMENTS: the employee's own checklist, and HR's tracking of who has what.
//
// The requirement list itself is configured by HR/Admin (see onboarding.service
// upsertRequirement), and the upload and review actions are the existing ones.
// This module only READS and assembles them, plus sets an employee's employment type.
//
//  - A requirement applies to everyone unless HR limited it to employment types.
//  - A person with no employment type set sees every requirement (as before types existed).
//  - Deactivating a requirement never deletes anyone's file: their documents stay and are
//    listed under "no longer required".
// ---------------------------------------------------------------------------

export const EMPLOYMENT_TYPES = ["PERMANENT", "PROBATION", "CONTRACT", "INTERN"] as const;
const STAFF = ["HR", "ADMIN"];

export const STATUS_LABEL = { NOT_SUBMITTED: "Not submitted", SUBMITTED: "Submitted", VERIFIED: "Verified", REJECTED: "Rejected" } as const;
type Status = keyof typeof STATUS_LABEL;

// The existing workflow has REQUESTED/SUBMITTED/APPROVED/REJECTED; people see the four plain words.
export function statusOf(doc: { status: unknown; storageKey?: string | null } | null | undefined): Status {
  if (!doc) return "NOT_SUBMITTED";
  switch (String(doc.status)) {
    case "SUBMITTED": return "SUBMITTED";
    case "APPROVED": return "VERIFIED";
    case "REJECTED": return "REJECTED";
    default: return "NOT_SUBMITTED";
  }
}

async function who(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, platformId: true, firstName: true, lastName: true, employeeCode: true, designation: true, status: true } });
  if (!u) throw new Error("USER_NOT_FOUND");
  return { ...u, role: String(u.role) };
}
async function staff(userId: string) {
  const v = await who(userId);
  if (!STAFF.includes(v.role)) throw new Error("NOT_ALLOWED");
  return v;
}

const name = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

type Doc = {
  id: string; requirementId: string | null; status: unknown; fileName: string | null; uploadedAt: Date | null;
  reviewedAt: Date | null; rejectionReason: string | null; reviewedBy?: { firstName: string; lastName: string } | null; category: unknown;
};

function checklist(
  requirements: { id: string; label: string; helpText: string | null; category: unknown; isMandatory: boolean; uploadedByEmployee: boolean; isActive: boolean; sortOrder: number }[],
  docs: Doc[],
  scopeBy: Map<string, string[]>,
  type: string | null
) {
  const byReq = new Map(docs.filter((d) => d.requirementId).map((d) => [d.requirementId as string, d]));
  const applicable = requirements.filter((r) => r.isActive && isApplicable(scopeBy.get(r.id), type));
  const items = applicable.map((r) => {
    const d = byReq.get(r.id);
    const status = statusOf(d);
    return {
      requirementId: r.id,
      name: r.label,
      description: r.helpText,
      category: String(r.category),
      isMandatory: r.isMandatory,
      uploadedByEmployee: r.uploadedByEmployee,
      status,
      statusLabel: STATUS_LABEL[status],
      documentId: d?.id ?? null,
      fileName: d?.fileName ?? null,
      uploadedAt: d?.uploadedAt ?? null,
      reviewedAt: d?.reviewedAt ?? null,
      reviewedBy: d?.reviewedBy ? name(d.reviewedBy) : null,
      rejectionReason: d?.rejectionReason ?? null,
    };
  });
  // Files that exist but whose requirement was deactivated, or no longer applies: kept, never deleted.
  const shown = new Set(applicable.map((r) => r.id));
  const reqById = new Map(requirements.map((r) => [r.id, r]));
  const archived = docs
    .filter((d) => d.requirementId && !shown.has(d.requirementId) && (d.fileName || String(d.status) !== "REQUESTED"))
    .map((d) => {
      const r = reqById.get(d.requirementId as string);
      const status = statusOf(d);
      return { documentId: d.id, name: r?.label ?? "Document", fileName: d.fileName, uploadedAt: d.uploadedAt, status, statusLabel: STATUS_LABEL[status], reason: r && !r.isActive ? "No longer required" : "Does not apply to this employment type" };
    });
  const required = items.filter((i) => i.isMandatory && i.uploadedByEmployee);
  const count = (s: Status, list = items) => list.filter((i) => i.status === s).length;
  return {
    items,
    archived,
    summary: {
      required: required.length,
      verified: count("VERIFIED", required),
      submitted: count("SUBMITTED", items),
      rejected: count("REJECTED", items),
      missing: required.filter((i) => i.status === "NOT_SUBMITTED").length,
    },
  };
}

// --- the employee's own view -------------------------------------------------------------------

export async function listMine(userId: string) {
  const me = await who(userId);
  // Company owners (Admin with the all-companies grant) owe no personal documents: an empty checklist, flagged, never "missing".
  if (await isOwnerAdmin(userId)) {
    return { exempt: true, employmentType: null, items: [], archived: [], summary: { required: 0, verified: 0, submitted: 0, rejected: 0, missing: 0 } };
  }
  const [requirements, docs, types, scopeBy] = await Promise.all([
    prisma.documentRequirement.findMany({ where: { platformId: me.platformId }, orderBy: [{ sortOrder: "asc" }, { label: "asc" }] }),
    prisma.employeeDocument.findMany({ where: { userId }, include: { reviewedBy: { select: { firstName: true, lastName: true } } } }),
    typesOf([userId]),
    scopeMap(me.platformId),
  ]);
  const type = types.get(userId) ?? null;
  return { employmentType: type, ...checklist(requirements, docs as unknown as Doc[], scopeBy, type) };
}

// --- HR / Admin --------------------------------------------------------------------------------

export async function tracking(
  viewerId: string,
  f: { q?: unknown; status?: unknown; employmentType?: unknown; teamId?: unknown }
) {
  const v = await staff(viewerId);
  const q = String(f.q ?? "").trim().slice(0, 80);
  const wantStatus = (["missing", "pending", "rejected", "complete"] as const).find((s) => s === f.status);
  const wantType = String(f.employmentType ?? "");
  if (wantType && wantType !== "UNSPECIFIED" && !EMPLOYMENT_TYPES.includes(wantType as never)) throw new Error("BAD_EMPLOYMENT_TYPE");
  const teamId = f.teamId ? String(f.teamId) : "";

  const owners = await ownerAdminIds(); // owners are not part of the employee document compliance list or its counts
  const users = await prisma.user.findMany({
    where: {
      platformId: v.platformId,
      status: { notIn: ["EXITED", "SUSPENDED"] },
      ...(owners.length ? { id: { notIn: owners } } : {}),
      ...(q ? { OR: [{ firstName: { contains: q, mode: "insensitive" as const } }, { lastName: { contains: q, mode: "insensitive" as const } }, { employeeCode: { contains: q, mode: "insensitive" as const } }] } : {}),
      ...(teamId ? { teamMemberships: { some: { teamId, isActive: true } } } : {}),
    },
    select: { id: true, firstName: true, lastName: true, employeeCode: true, designation: true, status: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    take: 1000,
  });
  const ids = users.map((u) => u.id);
  const [requirements, docs, types, scopeBy, teams] = await Promise.all([
    prisma.documentRequirement.findMany({ where: { platformId: v.platformId } }),
    ids.length ? prisma.employeeDocument.findMany({ where: { userId: { in: ids } }, include: { reviewedBy: { select: { firstName: true, lastName: true } } } }) : Promise.resolve([]),
    typesOf(ids),
    scopeMap(v.platformId),
    prisma.team.findMany({ where: { platformId: v.platformId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const docsBy = new Map<string, Doc[]>();
  for (const d of docs) docsBy.set(d.userId, [...(docsBy.get(d.userId) ?? []), d as unknown as Doc]);

  let rows = users.map((u) => {
    const type = types.get(u.id) ?? null;
    const c = checklist(requirements, docsBy.get(u.id) ?? [], scopeBy, type);
    return {
      id: u.id,
      name: name(u),
      employeeCode: u.employeeCode,
      designation: u.designation,
      employmentType: type,
      ...c.summary,
      complete: c.summary.missing === 0 && c.summary.submitted === 0 && c.summary.rejected === 0,
    };
  });
  if (wantType) rows = rows.filter((r) => (wantType === "UNSPECIFIED" ? !r.employmentType : r.employmentType === wantType));
  const totals = {
    people: rows.length,
    withMissing: rows.filter((r) => r.missing > 0).length,
    withPending: rows.filter((r) => r.submitted > 0).length,
    withRejected: rows.filter((r) => r.rejected > 0).length,
    complete: rows.filter((r) => r.complete).length,
  };
  if (wantStatus === "missing") rows = rows.filter((r) => r.missing > 0);
  if (wantStatus === "pending") rows = rows.filter((r) => r.submitted > 0);
  if (wantStatus === "rejected") rows = rows.filter((r) => r.rejected > 0);
  if (wantStatus === "complete") rows = rows.filter((r) => r.complete);
  return { totals, teams, rows };
}

export async function employeeChecklist(viewerId: string, userId: string) {
  const v = await staff(viewerId);
  const u = await prisma.user.findFirst({ where: { id: userId, platformId: v.platformId }, select: { id: true, firstName: true, lastName: true, employeeCode: true, designation: true, status: true } });
  if (!u) throw new Error("NOT_FOUND");
  const [requirements, docs, types, scopeBy] = await Promise.all([
    prisma.documentRequirement.findMany({ where: { platformId: v.platformId }, orderBy: [{ sortOrder: "asc" }, { label: "asc" }] }),
    prisma.employeeDocument.findMany({ where: { userId }, include: { reviewedBy: { select: { firstName: true, lastName: true } } } }),
    typesOf([userId]),
    scopeMap(v.platformId),
  ]);
  const type = types.get(userId) ?? null;
  return { employee: { id: u.id, name: name(u), employeeCode: u.employeeCode, designation: u.designation }, employmentType: type, ...checklist(requirements, docs as unknown as Doc[], scopeBy, type) };
}

export async function setEmploymentType(viewerId: string, userId: string, value: unknown) {
  const v = await staff(viewerId);
  const target = await prisma.user.findFirst({ where: { id: userId, platformId: v.platformId }, select: { id: true, firstName: true, lastName: true } });
  if (!target) throw new Error("NOT_FOUND");
  const next = value === null || value === "" || value === undefined ? null : EMPLOYMENT_TYPES.find((t) => t === value);
  if (value !== null && value !== "" && value !== undefined && !next) throw new Error("BAD_EMPLOYMENT_TYPE");
  const before = (await typesOf([userId])).get(userId) ?? null;

  try {
    if (next) await prisma.employeeProfile.upsert({ where: { userId }, update: { employmentType: next }, create: { userId, employmentType: next } });
    else await prisma.employeeProfile.deleteMany({ where: { userId } });
  } catch (e) {
    // The new tables are not there yet (database update not applied).
    if ((e as { code?: string }).code === "P2021" || /does not exist/i.test(String((e as Error).message))) throw new Error("FEATURE_UNAVAILABLE");
    throw e;
  }
  auditNote({ module: "Employees", action: "UPDATE", recordType: "User", recordId: userId, targetUserId: userId, before: { employmentType: before }, after: { employmentType: next }, summary: `Set employment type for ${name(target)}: ${before ?? "unspecified"} → ${next ?? "unspecified"}` });
  return { employmentType: next };
}
