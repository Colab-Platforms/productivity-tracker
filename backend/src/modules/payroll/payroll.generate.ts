// Salary generation. Reads the attendance engine, applies each person's
// monthly salary, and writes a DRAFT slip. It never publishes and never
// touches an approved slip — HR approves, and publishing stays where it
// already is.
//
// The arithmetic, in one place:
//   perDayRate = monthlySalary / days in the month
//   earned     = perDayRate x payableDays
//   lossOfPay  = monthlySalary - earned
//   deductions = lossOfPay + otherDeduction
//   netAmount  = monthlySalary - deductions
//
// payableDays already accounts for absence, half days, holidays, week-offs,
// approved leave, untracked days and the joining/exit dates, so this file does
// no attendance thinking of its own.

import { prisma } from "../../lib/prisma.js";
import { viewerIsOwner } from "../../lib/owner.js";
import { notifyUsers } from "../../lib/notify.js";
import {
  getMonthAttendance,
  getMonthAttendanceBulk,
  type MonthAttendance,
} from "../attendance/attendance.service.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type SkippedEmployee = {
  userId: string;
  name: string;
  employeeCode: string | null;
  reason: string;
};

export type GeneratedSlip = {
  slipId: string;
  userId: string;
  name: string;
  employeeCode: string | null;
  monthlySalary: number;
  daysInMonth: number;
  payableDays: number;
  absentDays: number;
  perDayRate: number;
  lossOfPay: number;
  otherDeduction: number;
  deductions: number;
  netAmount: number;
  status: string;
  attendanceSummary: MonthAttendance["totals"];
};

export type GenerateResult = {
  month: number;
  year: number;
  monthComplete: boolean;
  warning: string | null;
  created: number;
  updated: number;
  slips: GeneratedSlip[];
  skipped: SkippedEmployee[];
};

async function resolvePlatform(
  actorId: string,
  requestedPlatformId?: string,
): Promise<string> {
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { platformId: true },
  });
  if (!actor) throw new Error("USER_NOT_FOUND");

  // Only an owner may run payroll for a company other than their own. HR of
  // one company must never be able to generate another company's salaries.
  if (requestedPlatformId && requestedPlatformId !== actor.platformId) {
    if (!(await viewerIsOwner(actorId))) throw new Error("NOT_YOUR_COMPANY");
    return requestedPlatformId;
  }
  return actor.platformId;
}

/** Every team id must exist in this company. Empty list = whole company. */
async function validateTeams(platformId: string, teamIds: string[]): Promise<string[]> {
  const ids = [...new Set(teamIds.map(String).filter(Boolean))];
  if (ids.length === 0) return [];
  const found = await prisma.team.count({ where: { id: { in: ids }, platformId } });
  if (found !== ids.length) throw new Error("NOT_YOUR_COMPANY");
  return ids;
}

/** Teams of the viewer's company, for the department picker. */
export async function listPayrollTeams(actorId: string) {
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { platformId: true },
  });
  if (!actor) throw new Error("USER_NOT_FOUND");
  return prisma.team.findMany({
    where: { platformId: actor.platformId, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/**
 * One-click release: approve every DRAFT slip in scope, publish every approved
 * unpublished generated slip in scope, then tell each employee once.
 * Uploaded-PDF slips (storageKey set) are left exactly as they are.
 */
export async function releaseMonth(
  actorId: string,
  month: number,
  year: number,
  teamIds: string[] = [],
) {
  if (month < 1 || month > 12) throw new Error("BAD_MONTH");
  if (year < 2020 || year > 2100) throw new Error("BAD_YEAR");

  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { platformId: true },
  });
  if (!actor) throw new Error("USER_NOT_FOUND");
  const teams = await validateTeams(actor.platformId, teamIds);

  const scopeWhere = {
    platformId: actor.platformId,
    month,
    year,
    storageKey: null,
    ...(teams.length
      ? { user: { teamMemberships: { some: { teamId: { in: teams }, isActive: true } } } }
      : {}),
  };

  const now = new Date();
  const released = await prisma.$transaction(async (tx) => {
    const approved = await tx.salarySlip.updateMany({
      where: { ...scopeWhere, status: "DRAFT" },
      data: { status: "APPROVED", approvedAt: now },
    });
    const toPublish = await tx.salarySlip.findMany({
      where: { ...scopeWhere, status: "APPROVED", publishedAt: null },
      select: { id: true, userId: true },
    });
    if (toPublish.length) {
      await tx.salarySlip.updateMany({
        where: { id: { in: toPublish.map((s) => s.id) } },
        data: { publishedAt: now },
      });
    }
    return { approved: approved.count, slips: toPublish };
  });

  await notifySlipsPublished(
    actor.platformId,
    released.slips.map((s) => ({ ...s, month, year })),
  );

  return { approved: released.approved, published: released.slips.length };
}

/**
 * Take released slips back (same department scope as release). The employee can no
 * longer see them, and their "slip is ready" notification is removed so it does not
 * point at nothing; releasing again notifies afresh. Slips stay APPROVED, so HR can
 * release again without regenerating. Uploaded-PDF slips are not touched here.
 */
export async function unreleaseMonth(
  actorId: string,
  month: number,
  year: number,
  teamIds: string[] = [],
) {
  if (month < 1 || month > 12) throw new Error("BAD_MONTH");
  if (year < 2020 || year > 2100) throw new Error("BAD_YEAR");

  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { platformId: true },
  });
  if (!actor) throw new Error("USER_NOT_FOUND");
  const teams = await validateTeams(actor.platformId, teamIds);

  const where = {
    platformId: actor.platformId,
    month,
    year,
    storageKey: null,
    publishedAt: { not: null },
    ...(teams.length
      ? { user: { teamMemberships: { some: { teamId: { in: teams }, isActive: true } } } }
      : {}),
  };
  const slips = await prisma.salarySlip.findMany({ where, select: { id: true } });
  if (slips.length === 0) return { unreleased: 0 };

  const ids = slips.map((s) => s.id);
  await prisma.salarySlip.updateMany({ where: { id: { in: ids } }, data: { publishedAt: null } });

  try {
    await prisma.$executeRaw`DELETE FROM notifications WHERE "platformId" = ${actor.platformId}::uuid AND type = 'PAYSLIP_PUBLISHED' AND data->>'dedupeKey' = ANY(${ids.map((i) => `payslip:${i}:published`)})`;
  } catch (err) {
    console.error("[payroll] could not clear notifications", err);
  }
  return { unreleased: ids.length };
}

/**
 * Tell each employee their slip is ready. Used by EVERY way of publishing
 * (one-click release, release approved, release month, publish a chosen set).
 * A failure here must never undo a release.
 */
export async function notifySlipsPublished(
  platformId: string,
  slips: { id: string; userId: string; month: number; year: number }[],
) {
  try {
    await Promise.all(
      slips.map((s) =>
        notifyUsers({
          platformId,
          userIds: [s.userId],
          type: "PAYSLIP_PUBLISHED",
          title: `Your salary slip for ${MONTHS[s.month - 1]} ${s.year} is ready`,
          body: "Open My Payslips to view or download it.",
          link: "/dashboard/payslips",
          data: { slipId: s.id, month: s.month, year: s.year },
          dedupeKey: `payslip:${s.id}:published`,
        }),
      ),
    );
  } catch (err) {
    console.error("[payroll] notify failed", err);
  }
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Generate or refresh DRAFT slips for one company and one month.
 * Running it twice is safe: a DRAFT is recalculated, an approved slip is left
 * alone and reported as skipped.
 */
export async function generateMonth(
  actorId: string,
  month: number,
  year: number,
  platformId?: string,
  teamIds: string[] = [],
): Promise<GenerateResult> {
  if (month < 1 || month > 12) throw new Error("BAD_MONTH");
  if (year < 2020 || year > 2100) throw new Error("BAD_YEAR");

  const scope = await resolvePlatform(actorId, platformId);
  const teams = await validateTeams(scope, teamIds);

  // A month that has not finished can still be generated — HR often wants a
  // preview — but the result says so, because the remaining days are counted
  // as payable and the figure will change.
  const now = new Date();
  const monthComplete =
    year < now.getUTCFullYear() ||
    (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1);

  const employees = await prisma.user.findMany({
    where: {
      platformId: scope,
      status: "ACTIVE",
      ...(teams.length
        ? { teamMemberships: { some: { teamId: { in: teams }, isActive: true } } }
        : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      monthlySalary: true,
    },
    orderBy: { employeeCode: "asc" },
  });

  if (employees.length === 0) {
    return {
      month, year, monthComplete,
      warning: "No active employees in this company.",
      created: 0, updated: 0, slips: [], skipped: [],
    };
  }

  const nameOf = (e: (typeof employees)[number]) =>
    [e.firstName, e.lastName].filter(Boolean).join(" ").trim() || "Unnamed";

  // One attendance pass for the whole company.
  const attendance = await getMonthAttendanceBulk(
    employees.map((e) => e.id),
    year,
    month,
  );
  const attByUser = new Map(attendance.map((a) => [a.userId, a]));

  const existing = await prisma.salarySlip.findMany({
    where: { userId: { in: employees.map((e) => e.id) }, month, year },
    select: {
      id: true,
      userId: true,
      status: true,
      otherDeduction: true,
      otherDeductionNote: true,
    },
  });
  const existingByUser = new Map(existing.map((s) => [s.userId, s]));

  const slips: GeneratedSlip[] = [];
  const skipped: SkippedEmployee[] = [];
  let created = 0;
  let updated = 0;

  for (const emp of employees) {
    const att = attByUser.get(emp.id);
    if (!att) {
      skipped.push({
        userId: emp.id, name: nameOf(emp), employeeCode: emp.employeeCode,
        reason: "No attendance could be calculated",
      });
      continue;
    }

    // Nobody gets a slip off a guessed salary. A missing figure is a data gap
    // for HR to fill, not something to assume.
    const salary = emp.monthlySalary === null ? 0 : Number(emp.monthlySalary);
    if (!Number.isFinite(salary) || salary <= 0) {
      skipped.push({
        userId: emp.id, name: nameOf(emp), employeeCode: emp.employeeCode,
        reason: "No monthly salary set",
      });
      continue;
    }

    const prior = existingByUser.get(emp.id) ?? null;

    // An approved slip is a promise already made. Regenerating must never
    // silently rewrite one.
    if (prior && prior.status !== "DRAFT") {
      skipped.push({
        userId: emp.id, name: nameOf(emp), employeeCode: emp.employeeCode,
        reason: `Already ${prior.status.toLowerCase()} — not recalculated`,
      });
      continue;
    }

    const daysInMonth = att.totals.daysInMonth;
    const payableDays = att.totals.payableDays;

    // perDayRate is rounded for display only. The money is worked out from the
    // unrounded rate so 31 roundings cannot drift the total by a rupee.
    const perDayRate = round2(salary / daysInMonth);
    const earned = round2((salary / daysInMonth) * payableDays);
    const lossOfPay = round2(salary - earned);

    const otherDeduction =
      prior?.otherDeduction === null || prior?.otherDeduction === undefined
        ? 0
        : Number(prior.otherDeduction);

    const deductions = round2(lossOfPay + otherDeduction);
    const netAmount = round2(salary - deductions);

    const figures = {
      grossAmount: salary,
      deductions,
      netAmount,
      daysInMonth,
      payableDays,
      absentDays: att.totals.lossOfPayDays,
      perDayRate,
      lossOfPay,
      status: "DRAFT",
      generatedAt: new Date(),
      approvedAt: null,
    };

    let slipId: string;
    if (prior) {
      await prisma.salarySlip.update({ where: { id: prior.id }, data: figures });
      slipId = prior.id;
      updated++;
    } else {
      const made = await prisma.salarySlip.create({
        data: {
          ...figures,
          platformId: scope,
          userId: emp.id,
          month,
          year,
          otherDeduction: 0,
          // Who ran the generation. The schema requires it, and for a salary
          // figure "the system did it" is never an acceptable answer.
          uploadedById: actorId,
        },
        select: { id: true },
      });
      slipId = made.id;
      created++;
    }

    slips.push({
      slipId,
      userId: emp.id,
      name: nameOf(emp),
      employeeCode: emp.employeeCode,
      monthlySalary: salary,
      daysInMonth,
      payableDays,
      absentDays: att.totals.lossOfPayDays,
      perDayRate,
      lossOfPay,
      otherDeduction,
      deductions,
      netAmount,
      status: "DRAFT",
      attendanceSummary: att.totals,
    });
  }

  return {
    month,
    year,
    monthComplete,
    warning: monthComplete
      ? null
      : "This month has not finished. Remaining days are counted as payable, so these figures will change.",
    created,
    updated,
    slips,
    skipped,
  };
}

/** One slip beside the attendance it was calculated from. The review screen. */
export async function getSlipWithAttendance(actorId: string, slipId: string) {
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { platformId: true },
  });
  if (!actor) throw new Error("USER_NOT_FOUND");

  const slip = await prisma.salarySlip.findUnique({
    where: { id: slipId },
    select: {
      id: true, platformId: true, userId: true, month: true, year: true,
      grossAmount: true, deductions: true, netAmount: true,
      daysInMonth: true, payableDays: true, absentDays: true,
      perDayRate: true, lossOfPay: true,
      otherDeduction: true, otherDeductionNote: true,
      status: true, generatedAt: true, approvedAt: true,
    },
  });
  if (!slip) throw new Error("SLIP_NOT_FOUND");

  if (slip.platformId !== actor.platformId && !(await viewerIsOwner(actorId))) {
    throw new Error("NOT_YOUR_COMPANY");
  }

  // Recalculated live, so HR can see whether the stored figure still matches
  // the attendance. If somebody corrected a day after generation, the two
  // disagree and HR regenerates rather than paying a stale number.
  const attendance = await getMonthAttendance(slip.userId, slip.year, slip.month);

  const storedPayable =
    slip.payableDays === null ? null : Number(slip.payableDays);
  const stale =
    storedPayable !== null && storedPayable !== attendance.totals.payableDays;

  return {
    slip: {
      ...slip,
      grossAmount: slip.grossAmount === null ? null : Number(slip.grossAmount),
      deductions: slip.deductions === null ? null : Number(slip.deductions),
      netAmount: slip.netAmount === null ? null : Number(slip.netAmount),
      payableDays: storedPayable,
      absentDays: slip.absentDays === null ? null : Number(slip.absentDays),
      perDayRate: slip.perDayRate === null ? null : Number(slip.perDayRate),
      lossOfPay: slip.lossOfPay === null ? null : Number(slip.lossOfPay),
      otherDeduction:
        slip.otherDeduction === null ? 0 : Number(slip.otherDeduction),
    },
    attendance,
    stale,
    staleMessage: stale
      ? "Attendance has changed since this slip was generated. Regenerate before approving."
      : null,
  };
}

/** A manual deduction line, with a reason. DRAFT only. */
export async function setOtherDeduction(
  actorId: string,
  slipId: string,
  amount: number,
  note: string,
) {
  const amt = round2(Number(amount));
  if (!Number.isFinite(amt) || amt < 0) throw new Error("BAD_AMOUNT");
  if (amt > 0 && !String(note ?? "").trim()) throw new Error("NOTE_REQUIRED");

  const { slip } = await getSlipWithAttendance(actorId, slipId);
  if (slip.status !== "DRAFT") throw new Error("NOT_DRAFT");

  const gross = slip.grossAmount ?? 0;
  const lossOfPay = slip.lossOfPay ?? 0;
  const deductions = round2(lossOfPay + amt);

  await prisma.salarySlip.update({
    where: { id: slipId },
    data: {
      otherDeduction: amt,
      otherDeductionNote: amt > 0 ? String(note).trim() : null,
      deductions,
      netAmount: round2(gross - deductions),
    },
  });

  return getSlipWithAttendance(actorId, slipId);
}

/** Approve. Nothing reaches an employee without this, and publishing is still
 *  a separate, deliberate step. */
export async function approveSlips(actorId: string, slipIds: string[]) {
  const ids = slipIds.map(String).filter(Boolean);
  if (ids.length === 0) throw new Error("NO_SLIPS");

  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { platformId: true },
  });
  if (!actor) throw new Error("USER_NOT_FOUND");
  const isOwner = await viewerIsOwner(actorId);

  const rows = await prisma.salarySlip.findMany({
    where: { id: { in: ids } },
    select: { id: true, platformId: true, status: true },
  });

  const approvable = rows
    .filter((r) => r.status === "DRAFT")
    .filter((r) => isOwner || r.platformId === actor.platformId)
    .map((r) => r.id);

  if (approvable.length === 0) throw new Error("NOTHING_TO_APPROVE");

  const result = await prisma.salarySlip.updateMany({
    where: { id: { in: approvable } },
    data: { status: "APPROVED", approvedAt: new Date() },
  });

  return {
    approved: result.count,
    skipped: ids.length - approvable.length,
  };
}