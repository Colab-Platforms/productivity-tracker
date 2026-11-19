// ===========================================================================
// PAYROLL — salary slips
//
// This stores and distributes slips. It does NOT calculate payroll: the
// amounts are optional metadata so a list is scannable without opening every
// PDF, and the PDF your accounts team produced remains the source of truth.
//
// VISIBILITY
// A slip is invisible until publishedAt is set. Pay is the most sensitive
// data here, so the owner check happens on the server, the file is never
// served from a guessable path, and nothing is cacheable.
// ===========================================================================

import { prisma } from "../../lib/prisma.js";
import { notifySlipsPublished } from "./payroll.generate.js";
import { saveUpload, readStored, deleteStored, contentTypeFor } from "../../lib/storage.js";
import { accessFor, scopeWhere } from "../../lib/companyAccess.js";
import { canAccess } from "../../lib/companyAccess.logic.js";

const PAYROLL_ROLES = new Set(["HR", "ADMIN"]);

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

async function actor(viewerId: string) {
  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    select: { id: true, role: true, platformId: true },
  });
  if (!viewer) throw new Error("NOT_FOUND");
  return viewer;
}

/** The companies this HR/Admin may run payroll for (own, assigned, or all for top management; a pinned deployment limits it). */
async function reach(viewerId: string) {
  const a = await accessFor(viewerId);
  return { a, where: scopeWhere(a), can: (platformId: string | null | undefined) => !!platformId && canAccess(a, platformId) };
}

function assertPayrollStaff(role: string) {
  if (!PAYROLL_ROLES.has(String(role))) throw new Error("FORBIDDEN");
}

function assertPeriod(month: number, year: number) {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("BAD_MONTH");
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error("BAD_YEAR");
}

function label(month: number, year: number) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// Decimal comes back from Prisma as an object; a plain string keeps the
// precision intact all the way to the screen.
function money(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

// ===========================================================================
// THE EMPLOYEE'S OWN SLIPS
// ===========================================================================

export async function listMySlips(userId: string, year?: number) {
  const slips = await prisma.salarySlip.findMany({
    where: {
      userId,
      // The whole point of publishing: an unpublished slip does not exist
      // as far as the employee is concerned.
      publishedAt: { not: null },
      ...(year ? { year } : {}),
    },
    select: {
      id: true,
      month: true,
      year: true,
      netAmount: true,
      grossAmount: true,
      deductions: true,
      fileName: true,
      fileSize: true,
      publishedAt: true,
    },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });

  const years = await prisma.salarySlip.findMany({
    where: { userId, publishedAt: { not: null } },
    select: { year: true },
    distinct: ["year"],
    orderBy: { year: "desc" },
  });

  return {
    years: years.map((y) => y.year),
    slips: slips.map((s) => ({
      id: s.id,
      month: s.month,
      year: s.year,
      label: label(s.month, s.year),
      grossAmount: money(s.grossAmount),
      deductions: money(s.deductions),
      netAmount: money(s.netAmount),
      fileName: s.fileName,
      fileSize: s.fileSize,
      publishedAt: s.publishedAt,
    })),
  };
}

// ===========================================================================
// HR
// ===========================================================================

export async function listSlipsForMonth(viewerId: string, month: number, year: number) {
  const viewer = await actor(viewerId);
  assertPayrollStaff(String(viewer.role));
  assertPeriod(month, year);
  const { where: companies } = await reach(viewerId);

  // Everyone in the companies this person acts on who is part of THIS payroll cycle: active people, plus anybody who already has a slip for the
  // month (so an earlier record of someone who has since left is never hidden). Candidates never have a payslip. No paging and no cap: the
  // totals below are of this one list.
  const [withSlip, active] = await Promise.all([
    prisma.salarySlip.findMany({ where: { ...companies, month, year }, select: { userId: true } }),
    prisma.user.findMany({ where: { ...companies, status: "ACTIVE" }, select: { id: true } }),
  ]);
  const ids = [...new Set([...withSlip.map((x) => x.userId), ...active.map((x) => x.id)])];

  const people = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeCode: true,
          designation: true,
          status: true,
          monthlySalary: true,
          platformId: true,
          platform: { select: { name: true } },
        },
        orderBy: [{ platform: { name: "asc" } }, { firstName: "asc" }, { lastName: "asc" }],
      })
    : [];

  const slips = ids.length
    ? await prisma.salarySlip.findMany({
        where: { userId: { in: ids }, month, year },
        select: {
          id: true,
          userId: true,
          fileName: true,
          fileSize: true,
          grossAmount: true,
          deductions: true,
          netAmount: true,
          publishedAt: true,
          status: true,
          payableDays: true,
          otherDeduction: true,
          storageKey: true,
          createdAt: true,
          uploadedBy: { select: { firstName: true, lastName: true } },
        },
      })
    : [];

  const byUser = new Map(slips.map((x) => [x.userId, x]));

  const rows = people.map((p) => {
    const slip = byUser.get(p.id);
    const salary = p.monthlySalary === null ? 0 : Number(p.monthlySalary);
    const salaryOk = Number.isFinite(salary) && salary > 0;
    return {
      userId: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      employeeCode: p.employeeCode,
      designation: p.designation,
      company: p.platform.name,
      companyId: p.platformId,
      employmentStatus: String(p.status),
      // Never the amount: only whether payroll can be run for this person.
      payroll: salaryOk
        ? { ready: true, status: "READY", reason: null as string | null }
        : { ready: false, status: "SALARY_MISSING", reason: "Salary details missing. Ask an Admin to add the monthly salary in Edit Employee." },
      slip: slip
        ? {
            id: slip.id,
            fileName: slip.fileName,
            fileSize: slip.fileSize,
            grossAmount: money(slip.grossAmount),
            deductions: money(slip.deductions),
            netAmount: money(slip.netAmount),
            publishedAt: slip.publishedAt,
            status: slip.status,
            payableDays: slip.payableDays === null ? null : Number(slip.payableDays),
            otherDeduction: slip.otherDeduction === null ? null : Number(slip.otherDeduction),
            hasFile: Boolean(slip.storageKey),
            uploadedBy: `${slip.uploadedBy.firstName} ${slip.uploadedBy.lastName}`.trim(),
          }
        : null,
    };
  });

  return {
    month,
    year,
    label: label(month, year),
    rows,
    // Totals of THIS list (the same rows the screen shows): never of a page.
    employees: rows.length,
    eligible: rows.filter((r) => r.payroll.ready).length,
    setupRequired: rows.filter((r) => !r.payroll.ready).length,
    companies: [...new Map(rows.map((r) => [r.companyId, r.company])).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    uploaded: slips.length,
    published: slips.filter((x) => x.publishedAt).length,
  };
}

export async function uploadSlip(
  viewerId: string,
  data: {
    userId: string;
    month: number;
    year: number;
    grossAmount?: string;
    deductions?: string;
    netAmount?: string;
    fileName: string;
    data: string;
    mimeType?: string;
  }
) {
  const viewer = await actor(viewerId);
  assertPayrollStaff(String(viewer.role));

  const month = Number(data.month);
  const year = Number(data.year);
  assertPeriod(month, year);

  const { can } = await reach(viewerId);
  const target = await prisma.user.findUnique({
    where: { id: data.userId },
    select: { platformId: true, monthlySalary: true },
  });
  if (!target || !can(target.platformId)) throw new Error("NOT_FOUND");

  // One slip per person per month: look first, so a person with no payroll details cannot get a NEW slip, while an existing one can still be replaced.
  const existing = await prisma.salarySlip.findFirst({
    where: { userId: data.userId, month, year },
    select: { id: true, storageKey: true },
  });
  const salary = target.monthlySalary === null ? 0 : Number(target.monthlySalary);
  if (!existing && !(Number.isFinite(salary) && salary > 0)) throw new Error("PAYROLL_SETUP_REQUIRED");

  const stored = await saveUpload({
    platformId: target.platformId,
    folder: "payslips",
    originalName: data.fileName,
    data: data.data,
    mimeType: data.mimeType,
  });

  const amounts = {
    grossAmount: data.grossAmount ? data.grossAmount : null,
    deductions: data.deductions ? data.deductions : null,
    netAmount: data.netAmount ? data.netAmount : null,
  };

  // Re-uploading October replaces October rather than creating a second one (the unique constraint backs this up).
  if (existing) {
    await prisma.salarySlip.update({
      where: { id: existing.id },
      data: {
        ...stored,
        ...amounts,
        uploadedById: viewer.id,
        // A replaced slip goes back to unpublished — if it needed replacing,
        // it needs checking again before anyone sees it.
        publishedAt: null,
      },
    });
    if (existing.storageKey) await deleteStored(existing.storageKey);
    return { ok: true, replaced: true };
  }

  await prisma.salarySlip.create({
    data: {
      platformId: target.platformId,
      userId: data.userId,
      month,
      year,
      ...stored,
      ...amounts,
      uploadedById: viewer.id,
    },
  });

  return { ok: true, replaced: false };
}

// A slip HR generated from attendance has no file behind it, so the only thing
// vouching for its figures is the approval. It must not reach an employee
// before that. A slip HR uploaded as a PDF is HR's own document and is
// released as it always was.
const NOT_YET_APPROVED = { status: { not: "APPROVED" }, storageKey: null } as const;

export async function publishSlips(
  viewerId: string,
  slipIds: string[],
  publish: boolean
) {
  const viewer = await actor(viewerId);
  assertPayrollStaff(String(viewer.role));
  if (slipIds.length === 0) return { updated: 0 };
  const { where: companies } = await reach(viewerId);

  // Slips that are about to become visible for the first time get a notification.
  const fresh = publish
    ? await prisma.salarySlip.findMany({
        where: { id: { in: slipIds }, ...companies, publishedAt: null, NOT: NOT_YET_APPROVED },
        select: { id: true, userId: true, month: true, year: true },
      })
    : [];

  const result = await prisma.salarySlip.updateMany({
    where: {
      id: { in: slipIds },
      ...companies,
      ...(publish ? { NOT: NOT_YET_APPROVED } : {}),
    },
    data: { publishedAt: publish ? new Date() : null },
  });

  await notifySlipsPublished(viewer.platformId, fresh);

  return { updated: result.count, skipped: slipIds.length - result.count };
}

export async function publishMonth(viewerId: string, month: number, year: number) {
  const viewer = await actor(viewerId);
  assertPayrollStaff(String(viewer.role));
  assertPeriod(month, year);
  const { where: companies } = await reach(viewerId);

  const fresh = await prisma.salarySlip.findMany({
    where: { ...companies, month, year, publishedAt: null, NOT: NOT_YET_APPROVED },
    select: { id: true, userId: true, month: true, year: true },
  });

  const result = await prisma.salarySlip.updateMany({
    where: {
      ...companies,
      month,
      year,
      publishedAt: null,
      NOT: NOT_YET_APPROVED,
    },
    data: { publishedAt: new Date() },
  });

  await notifySlipsPublished(viewer.platformId, fresh);

  const waiting = await prisma.salarySlip.count({
    where: { ...companies, month, year, publishedAt: null, ...NOT_YET_APPROVED },
  });

  return { updated: result.count, waitingForApproval: waiting };
}

export async function deleteSlip(viewerId: string, slipId: string) {
  const viewer = await actor(viewerId);
  assertPayrollStaff(String(viewer.role));

  const slip = await prisma.salarySlip.findUnique({
    where: { id: slipId },
    select: { platformId: true, storageKey: true },
  });
  if (!slip || !(await reach(viewerId)).can(slip.platformId)) throw new Error("NOT_FOUND");

  await prisma.salarySlip.delete({ where: { id: slipId } });
  if (slip.storageKey) await deleteStored(slip.storageKey);

  return { ok: true };
}

// ===========================================================================
// DOWNLOAD
// ===========================================================================

export async function downloadSlip(viewerId: string, slipId: string) {
  const viewer = await actor(viewerId);

  const slip = await prisma.salarySlip.findUnique({
    where: { id: slipId },
    select: {
      platformId: true,
      userId: true,
      storageKey: true,
      fileName: true,
      mimeType: true,
      publishedAt: true,
      month: true,
      year: true,
    },
  });
  const isOwner = !!slip && slip.userId === viewer.id;
  const isStaff = PAYROLL_ROLES.has(String(viewer.role));
  // The person always reaches their own slip; HR/Admin reach the slips of the companies they act on; nobody else.
  if (!slip || !(isOwner || (isStaff && (await reach(viewerId)).can(slip.platformId)))) throw new Error("NOT_FOUND");

  // Nobody else. Not a manager, not a colleague — pay is between the person
  // and HR.
  if (!isOwner && !isStaff) throw new Error("FORBIDDEN");

  // HR can open a draft to check it. The owner cannot see it until released.
  if (isOwner && !isStaff && !slip.publishedAt) throw new Error("NOT_PUBLISHED");

  // A generated slip carries its figures but no file until somebody
  // produces one, so downloading it is a different thing from having it.
  if (!slip.storageKey) {
    // No stored file: build the PDF from the slip's own figures, so it
    // always matches the current numbers rather than a stale copy.
    const { buildPayslipPdf } = await import("./payroll.pdf.js");
    const built = await buildPayslipPdf(viewerId, slipId);
    return { buffer: built.pdf, fileName: built.fileName, mimeType: "application/pdf" };
  }

  const buffer = await readStored(slip.storageKey);

  return {
    buffer,
    fileName: slip.fileName || `payslip-${slip.year}-${slip.month}.pdf`,
    mimeType: slip.mimeType ?? contentTypeFor(slip.storageKey),
  };
}