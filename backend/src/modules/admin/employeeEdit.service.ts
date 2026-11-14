import { prisma } from "../../lib/prisma.js";
import { linksReady, linkedManagerIdsOf } from "../../lib/reportingLinks.js";
import { reportingError } from "./hierarchy.logic.js";
import { parseIsoDay } from "../../lib/dates.js";
import { auditNote, changedFields } from "../../lib/auditContext.js";
import { accessFor, assertCompany, scopeWhere, type Access } from "../../lib/companyAccess.js";
import { visibleCompanies } from "../../lib/companyAccess.logic.js";
import { photoStamps } from "../photos/photos.service.js";
import { sharedDesignations, canonicalDesignation } from "../../lib/designations.js";

// ---------------------------------------------------------------------------
// EDIT EMPLOYEE + the dropdowns that feed it.
//
// Rules (all enforced here, on the server; the screen only hides what you may not use):
//  - HR/Admin can edit only people of companies they may act on (own, assigned, or all for top management).
//  - The employee ID never changes. The company is shown but cannot be changed here (a move would orphan history).
//  - A designation or salary that already has a value is replaced only with an explicit confirmation.
//  - Salary: Admin and top management only. Designation must come from the company's list once the company has one.
//  - Reporting manager: an active manager/admin of the SAME company, never the person themselves, never a loop.
//  - Only an Admin changes HR/Admin accounts, roles, status or tracker access of such accounts (existing rule).
//  - Every change is written to the audit log with what it was and what it became.
// ---------------------------------------------------------------------------

const USER_ROLES = ["EMPLOYEE", "MANAGER", "HR", "ADMIN"] as const;
const USER_STATUSES = ["CANDIDATE", "INVITED", "ACTIVE", "SUSPENDED", "EXITED"] as const;
const ONBOARDING_STATUSES = ["OFFER_SENT", "OFFER_ACCEPTED", "DOCUMENTS_PENDING", "DOCUMENTS_SUBMITTED", "AWAITING_RESUME", "ACTIVE"] as const;
export const EMPLOYMENT_TYPES = ["PERMANENT", "PROBATION", "CONTRACT", "INTERN"] as const;
const PRIVILEGED = ["HR", "ADMIN"];
const MAX_SALARY = 10_000_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const canEditSalary = (a: Access & { role: string }) => a.role === "ADMIN" || a.all;

async function typeTableReady() {
  try {
    await prisma.employeeProfile.findFirst({ select: { userId: true } });
    return true;
  } catch {
    return false;
  }
}

// One shared list for every company (see lib/designations.ts); the company no longer limits the choice.
const designationList = (_platformId: string): Promise<string[]> => sharedDesignations();

type SalaryInput = number | string | null | undefined;
function parseSalary(v: SalaryInput): number | null {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > MAX_SALARY) throw new Error("BAD_SALARY");
  return Math.round(n * 100) / 100;
}

/** Walk up from the proposed manager; if we meet the person being edited, saving would create a loop. */
async function reachesPerson(managerId: string, personId: string): Promise<boolean> {
  let cursor: string | null = managerId;
  for (let i = 0; i < 50 && cursor; i++) {
    if (cursor === personId) return true;
    const up: { reportsToId: string | null } | null = await prisma.user.findUnique({ where: { id: cursor }, select: { reportsToId: true } });
    cursor = up?.reportsToId ?? null;
  }
  return false;
}

export type EditBody = {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  email?: string;
  role?: string;
  status?: string;
  designation?: string | null;
  employeeCode?: string;
  companyId?: string;
  shiftId?: string | null;
  reportsToId?: string | null;
  dateOfJoining?: string | null;
  onboardingStatus?: string;
  trackerAccessEnabled?: boolean;
  biometricId?: string | null;
  employmentType?: string | null;
  monthlySalary?: SalaryInput;
  confirmOverwrite?: { designation?: boolean; salary?: boolean };
};

export async function updateEmployee(viewerId: string, userId: string, data: EditBody) {
  const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: { id: true, role: true } });
  if (!viewer) throw new Error("NOT_FOUND");
  const access = await accessFor(viewerId);
  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, platformId: true, role: true, status: true, employeeCode: true, email: true, designation: true, monthlySalary: true, reportsToId: true,
      firstName: true, lastName: true, phone: true, shiftId: true, biometricId: true, dateOfJoining: true, onboardingStatus: true, trackerAccessEnabled: true,
    },
  });
  if (!current) throw new Error("NOT_FOUND");
  assertCompany(access, current.platformId); // an id from a company you cannot act on is simply "not found"

  const viewerRole = String(viewer.role);
  // Only an Admin may change an HR/Admin account (other than their own details).
  if (viewerRole !== "ADMIN" && PRIVILEGED.includes(String(current.role)) && userId !== viewer.id) throw new Error("ROLE_NOT_ALLOWED");

  const role = USER_ROLES.find((r) => r === data.role);
  if (role && PRIVILEGED.includes(role) && viewerRole !== "ADMIN") throw new Error("ROLE_NOT_ALLOWED");
  if (role && role !== String(current.role) && viewerRole !== "ADMIN") throw new Error("ROLE_NOT_ALLOWED"); // changing a system role is Admin-only
  const status = USER_STATUSES.find((s) => s === data.status);
  if (viewerRole !== "ADMIN" && userId === viewer.id && (role || data.status !== undefined || data.trackerAccessEnabled !== undefined)) throw new Error("ROLE_NOT_ALLOWED");
  const onboardingStatus = ONBOARDING_STATUSES.find((s) => s === data.onboardingStatus);

  // ---- things that never change here ----
  if (data.employeeCode !== undefined && String(data.employeeCode).trim().toUpperCase() !== String(current.employeeCode ?? "").toUpperCase()) throw new Error("EMPLOYEE_CODE_LOCKED");
  if (data.companyId !== undefined && data.companyId !== current.platformId) throw new Error("COMPANY_TRANSFER_NOT_SUPPORTED");

  // ---- email ----
  let email: string | undefined;
  if (data.email !== undefined) {
    const e = String(data.email).trim().toLowerCase();
    if (!EMAIL_RE.test(e)) throw new Error("BAD_EMAIL");
    if (e !== current.email.toLowerCase()) {
      const clash = await prisma.user.findFirst({ where: { platformId: current.platformId, email: e, id: { not: userId } }, select: { id: true } });
      if (clash) throw new Error("EMAIL_TAKEN");
      email = e;
    }
  }

  // ---- designation: from the company's list; replacing an existing one needs a confirmation ----
  let designation: string | null | undefined;
  if (data.designation !== undefined) {
    const wanted = data.designation === null ? null : String(data.designation).trim().replace(/\s+/g, " ");
    const next = wanted === "" ? null : wanted;
    if ((next ?? null) !== (current.designation ?? null)) {
      if (current.designation && data.confirmOverwrite?.designation !== true) throw new Error("DESIGNATION_OVERWRITE_NEEDS_CONFIRM");
      if (next) {
        // A fixed list for every company: only one of its entries is accepted (the list's own spelling is stored).
        const hit = canonicalDesignation(next);
        if (!hit) throw new Error("DESIGNATION_NOT_IN_LIST");
        designation = hit;
      } else designation = null;
    }
  }

  // ---- salary: Admin / top management, with confirmation when replacing a value ----
  let salary: number | null | undefined;
  if (data.monthlySalary !== undefined) {
    if (!canEditSalary(access)) throw new Error("SALARY_NOT_ALLOWED");
    const next = parseSalary(data.monthlySalary);
    const had = current.monthlySalary === null ? null : Number(current.monthlySalary);
    if (next !== had) {
      if (had !== null && data.confirmOverwrite?.salary !== true) throw new Error("SALARY_OVERWRITE_NEEDS_CONFIRM");
      salary = next;
    }
  }

  // ---- reporting manager ----
  let reportsToId: string | null | undefined;
  if (data.reportsToId !== undefined) {
    const next = data.reportsToId || null;
    if (next !== (current.reportsToId ?? null)) {
      if (viewerRole !== "ADMIN") throw new Error("HIERARCHY_ADMIN_ONLY"); // the reporting hierarchy is configured by Admin only
      if (next) {
        if (next === userId) throw new Error("BAD_MANAGER");
        const m = await prisma.user.findUnique({ where: { id: next }, select: { id: true, platformId: true, role: true, status: true } });
        // Employee -> a Manager, Manager -> an Admin (HR/Admin: a Manager or Admin as before); same company, active, never themselves.
        const bad = reportingError({ id: userId, role: String(current.role), platformId: current.platformId }, m ? { id: m.id, role: String(m.role), status: String(m.status), platformId: m.platformId } : null, { anyCompany: true });
        if (bad) throw new Error(bad);
        if (await reachesPerson(next, userId)) throw new Error("MANAGER_CYCLE");
      }
      reportsToId = next;
    }
  }

  // ---- employee type ----
  let employmentType: (typeof EMPLOYMENT_TYPES)[number] | null | undefined;
  if (data.employmentType !== undefined) {
    if (data.employmentType === null || data.employmentType === "") employmentType = null;
    else {
      const t = EMPLOYMENT_TYPES.find((x) => x === data.employmentType);
      if (!t) throw new Error("BAD_EMPLOYMENT_TYPE");
      employmentType = t;
    }
    if (!(await typeTableReady())) throw new Error("FEATURES_NOT_READY");
  }
  const typeBefore = employmentType !== undefined ? (await prisma.employeeProfile.findUnique({ where: { userId }, select: { employmentType: true } }))?.employmentType ?? null : null;

  const AUDIT_KEYS = ["firstName", "lastName", "phone", "email", "role", "status", "designation", "shiftId", "reportsToId", "biometricId", "dateOfJoining", "onboardingStatus", "trackerAccessEnabled", "monthlySalary", "employmentType"];
  const flat = (r: Record<string, unknown>, type: string | null) => ({ ...r, monthlySalary: r.monthlySalary === null || r.monthlySalary === undefined ? null : Number(r.monthlySalary), employmentType: type });
  const beforeRow = flat(current as unknown as Record<string, unknown>, typeBefore);

  const gate =
    data.trackerAccessEnabled === undefined ? {} : { trackerAccessEnabled: data.trackerAccessEnabled, accessGrantedAt: data.trackerAccessEnabled ? new Date() : null };

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName !== undefined ? { firstName: String(data.firstName).trim() } : {}),
        ...(data.lastName !== undefined ? { lastName: String(data.lastName).trim() } : {}),
        ...(data.phone !== undefined ? { phone: data.phone ? String(data.phone).trim() : null } : {}),
        ...(email ? { email } : {}),
        ...(role ? { role } : {}),
        ...(status ? { status, ...(status === "EXITED" ? { exitDate: new Date() } : {}) } : {}),
        ...(designation !== undefined ? { designation } : {}),
        ...(salary !== undefined ? { monthlySalary: salary } : {}),
        ...(data.shiftId !== undefined ? { shiftId: data.shiftId || null } : {}),
        ...(reportsToId !== undefined ? { reportsToId } : {}),
        ...(data.biometricId !== undefined ? { biometricId: data.biometricId ? String(data.biometricId).trim() : null } : {}),
        ...(data.dateOfJoining !== undefined ? { dateOfJoining: data.dateOfJoining ? parseIsoDay(data.dateOfJoining) : null } : {}),
        ...(onboardingStatus ? { onboardingStatus } : {}),
        ...gate,
      },
    });
    if (employmentType !== undefined) {
      if (employmentType === null) await tx.employeeProfile.deleteMany({ where: { userId } });
      else await tx.employeeProfile.upsert({ where: { userId }, update: { employmentType }, create: { userId, employmentType } });
    }
  });

  const afterUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, phone: true, email: true, role: true, status: true, designation: true, monthlySalary: true, shiftId: true, reportsToId: true, biometricId: true, dateOfJoining: true, onboardingStatus: true, trackerAccessEnabled: true },
  });
  const typeAfter = employmentType !== undefined ? employmentType : typeBefore;
  const afterRow = flat((afterUser ?? {}) as Record<string, unknown>, typeAfter);
  const diff = changedFields(beforeRow, afterRow, AUDIT_KEYS);
  const changed = Object.keys(diff.after as Record<string, unknown>);
  const permission = ["role", "status", "trackerAccessEnabled"].some((k) => changed.includes(k));
  auditNote({
    module: "Employees",
    action: permission ? "PERMISSION" : "UPDATE",
    recordType: "User",
    recordId: userId,
    targetUserId: userId,
    before: diff.before,
    after: diff.after,
    summary: changed.length ? (permission ? "Changed access: " : "Updated: ") + changed.join(", ") : "Saved with no changes",
  });
  return { id: userId, changed };
}

// ---------------------------------------------------------------------------
// What the Edit form needs for ONE person: their details, the permissions of the person editing, and the dropdown choices of THEIR company.

export async function dropdownsFor(viewerId: string, platformId: string) {
  const access = await accessFor(viewerId);
  assertCompany(access, platformId);
  const [teams, designations, managers, shifts] = await Promise.all([
    prisma.team.findMany({ where: { platformId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    designationList(platformId),
    prisma.user.findMany({
      where: { platformId, role: { in: ["MANAGER", "ADMIN"] }, status: { in: ["ACTIVE", "INVITED"] } },
      select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true },
      orderBy: [{ firstName: "asc" }],
    }),
    prisma.shift.findMany({ where: { platformId, isActive: true }, select: { id: true, name: true, startTime: true, endTime: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    departments: teams,
    designations,
    managers: managers.map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}`.trim(), employeeCode: m.employeeCode, role: m.role })),
    shifts,
    statuses: USER_STATUSES.map((s) => s),
    employeeTypes: EMPLOYMENT_TYPES.map((t) => t),
  };
}

/** Companies the person may pick from (all for top management, assigned ones for HR). */
export async function companiesFor(viewerId: string) {
  const access = await accessFor(viewerId);
  const rows = visibleCompanies(access, await prisma.platform.findMany({ where: { isActive: true }, select: { id: true, name: true, slug: true, employeeCodePrefix: true }, orderBy: { name: "asc" } }));
  return { all: access.all, ownCompanyId: access.ownPlatformId, canSwitch: rows.length > 1, companies: rows };
}

export async function editModel(viewerId: string, userId: string) {
  const access = await accessFor(viewerId);
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, platformId: true, firstName: true, lastName: true, email: true, phone: true, employeeCode: true, role: true, status: true, designation: true, monthlySalary: true,
      dateOfJoining: true, reportsToId: true, shiftId: true, biometricId: true, onboardingStatus: true, trackerAccessEnabled: true,
      platform: { select: { name: true } },
      teamMemberships: { where: { isActive: true }, select: { team: { select: { id: true, name: true } } } },
    },
  });
  if (!u) throw new Error("NOT_FOUND");
  assertCompany(access, u.platformId);
  const type = (await typeTableReady()) ? (await prisma.employeeProfile.findUnique({ where: { userId }, select: { employmentType: true } }))?.employmentType ?? null : null;
  const mayEditSalary = canEditSalary(access);
  const photoAt = (await photoStamps([u.id])).get(u.id) ?? null;
  const extraIds = (await linkedManagerIdsOf([u.id])).get(u.id) ?? [];
  const extraPeople = extraIds.length ? await prisma.user.findMany({ where: { id: { in: extraIds } }, select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true, platform: { select: { name: true } } } }) : [];
  return {
    additionalManagers: extraPeople.map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}`.trim(), employeeCode: m.employeeCode, role: String(m.role), company: m.platform.name })),
    additionalManagersReady: await linksReady(),
    person: {
      id: u.id,
      photoAt,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      phone: u.phone,
      employeeCode: u.employeeCode,
      role: u.role,
      status: u.status,
      designation: u.designation,
      dateOfJoining: u.dateOfJoining ? u.dateOfJoining.toISOString().slice(0, 10) : null,
      reportsToId: u.reportsToId,
      shiftId: u.shiftId,
      biometricId: u.biometricId,
      onboardingStatus: u.onboardingStatus,
      trackerAccessEnabled: u.trackerAccessEnabled,
      employmentType: type,
      companyId: u.platformId,
      company: u.platform.name,
      departments: u.teamMemberships.map((m) => m.team),
      // The salary is sent only to people who may change it.
      monthlySalary: mayEditSalary ? (u.monthlySalary === null ? null : Number(u.monthlySalary)) : undefined,
    },
    permissions: { canEditPhoto: access.role === "HR" || access.role === "ADMIN", canEditSalary: mayEditSalary, canChangeRoles: access.role === "ADMIN", canEditHierarchy: access.role === "ADMIN", employeeCodeLocked: true, companyLocked: true },
    dropdowns: await dropdownsFor(viewerId, u.platformId),
  };
}

export { scopeWhere };

/**
 * ADDITIONAL reporting managers of one person. Admin only (the hierarchy is Admin-only). The list REPLACES the person's current extra managers.
 * Each one must be an ACTIVE Manager or Admin, not the person themselves and not their main reporting manager; the company does not matter (a
 * manager can run people of another company). The main reporting manager (users.reportsToId) is not touched.
 */
export async function setAdditionalManagers(viewerId: string, userId: string, managerIdsIn: unknown) {
  const access = await accessFor(viewerId);
  if (access.role !== "ADMIN") throw new Error("HIERARCHY_ADMIN_ONLY");
  if (!(await linksReady())) throw new Error("FEATURES_NOT_READY");
  if (!Array.isArray(managerIdsIn) || managerIdsIn.some((x) => typeof x !== "string")) throw new Error("BAD_MANAGER_LIST");
  const wanted = [...new Set(managerIdsIn as string[])];
  if (wanted.length > 5) throw new Error("TOO_MANY_MANAGERS");
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, platformId: true, firstName: true, lastName: true, reportsToId: true } });
  if (!u) throw new Error("NOT_FOUND");
  assertCompany(access, u.platformId);
  if (wanted.includes(u.id)) throw new Error("MANAGER_IS_SELF");
  if (u.reportsToId && wanted.includes(u.reportsToId)) throw new Error("ALREADY_MAIN_MANAGER");
  const people = wanted.length ? await prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, role: true, status: true } }) : [];
  if (people.length !== wanted.length || people.some((p) => !["MANAGER", "ADMIN"].includes(String(p.role)) || !["ACTIVE", "INVITED"].includes(String(p.status)))) throw new Error("MANAGER_WRONG_ROLE");

  const before = (await linkedManagerIdsOf([userId])).get(userId) ?? [];
  await prisma.$transaction(async (tx) => {
    await tx.reportingManagerLink.deleteMany({ where: { userId, managerId: { notIn: wanted } } });
    for (const managerId of wanted) {
      if (before.includes(managerId)) continue;
      await tx.reportingManagerLink.create({ data: { userId, managerId, createdById: viewerId } });
    }
  });
  auditNote({
    platformId: u.platformId, module: "Employees", action: "UPDATE", recordType: "User", recordId: userId, targetUserId: userId,
    summary: `Changed additional reporting managers of ${u.firstName} ${u.lastName}`.trim(), before: { additionalManagerIds: before }, after: { additionalManagerIds: wanted },
  });
  return { ok: true, managerIds: wanted };
}
