import { prisma } from "../../lib/prisma.js";
import { parseIsoDay, platformToday } from "../../lib/dates.js";
import { auditNote } from "../../lib/auditContext.js";
import { accessFor, deciderIdsForCompany, scopeWhere, type Access } from "../../lib/companyAccess.js";
import { notifyUsers } from "../../lib/notify.js";
import { claimStep, gateForHr, rowsForManager, startStep, stepViews } from "../approvals/managerStep.js";
import { getPinnedCompany } from "../../lib/deployment.js";

// ---------------------------------------------------------------------------
// LEAVE REQUESTS
//
// Employee asks -> HR/Admin of the SAME company approves or rejects. Exception by design: an owner (OWNER_CODES) who is HR/Admin
// handles every company's requests (a deployment pinned to one company switches that off).
// A request on its own changes nothing in reports. Only when it is approved do
// we write one leave_days row per working day, and from then on Reports and
// the live dashboard treat those days as leave (not absence).
// "Leave taken" is counted from leave_days, so days HR marked by hand count too.
// ---------------------------------------------------------------------------

export const REQUEST_TYPES = ["CASUAL", "SICK", "EARNED", "UNPAID"] as const;
const DECIDERS = ["HR", "ADMIN"];
const MAX_SPAN_DAYS = 60;
const MAX_DAYS_BACK = 30;
const DAY_MS = 86_400_000;

async function who(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      platform: { select: { timezone: true } },
      shift: { select: { workingDays: true } },
      teamMemberships: {
        where: { isActive: true },
        take: 1,
        include: { team: { select: { shift: { select: { workingDays: true } } } } },
      },
    },
  });
  if (!user) throw new Error("USER_NOT_FOUND");
  const shift = user.teamMemberships[0]?.team.shift ?? user.shift;
  return {
    id: user.id,
    role: String(user.role),
    platformId: user.platformId,
    timezone: user.platform.timezone,
    workingDays: shift?.workingDays?.length ? shift.workingDays : [1, 2, 3, 4, 5, 6],
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const isoWeekday = (d: Date) => d.getUTCDay() || 7; // Mon=1 ... Sun=7

// The days in [from,to] the person is expected to work: their shift's working
// days, minus the company's holidays.
async function workingDates(platformId: string, workingDays: number[], from: Date, to: Date) {
  const holidays = await prisma.holiday.findMany({
    where: { platformId, date: { gte: from, lte: to }, dayType: { not: "WORKING" } },
    select: { date: true },
  });
  const off = new Set(holidays.map((h) => iso(h.date)));
  const out: Date[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
    const d = new Date(t);
    if (workingDays.includes(isoWeekday(d)) && !off.has(iso(d))) out.push(d);
  }
  return out;
}

function parseYear(value: unknown, timezone: string) {
  if (value === undefined || value === "") return platformToday(timezone).getUTCFullYear();
  const y = Number(value);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new Error("BAD_YEAR");
  return y;
}

type Taken = Record<string, number> & { total: number };
function emptyTaken(): Taken {
  return { CASUAL: 0, SICK: 0, EARNED: 0, UNPAID: 0, PLANNED: 0, COMP_OFF: 0, OTHER: 0, total: 0 };
}

// Leave per person for a calendar year, by type. Half days count 0.5.
async function takenByUser(platformId: string | string[] | undefined, year: number, userIds?: string[]) {
  const rows = await prisma.leaveDay.findMany({
    where: {
      ...(platformId ? { platformId: Array.isArray(platformId) ? { in: platformId } : platformId } : {}),
      date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) },
      ...(userIds ? { userId: { in: userIds } } : {}),
    },
    select: { userId: true, leaveType: true, isHalfDay: true },
  });
  const map = new Map<string, Taken>();
  for (const r of rows) {
    const t = map.get(r.userId) ?? emptyTaken();
    const n = r.isHalfDay ? 0.5 : 1;
    t[String(r.leaveType)] = (t[String(r.leaveType)] ?? 0) + n;
    t.total += n;
    map.set(r.userId, t);
  }
  return map;
}

const personSelect = { id: true, firstName: true, lastName: true, employeeCode: true, designation: true } as const;
const deciderSelect = { select: { firstName: true, lastName: true } } as const;

function requestView(r: {
  id: string;
  fromDate: Date;
  toDate: Date;
  leaveType: unknown;
  isHalfDay: boolean;
  isFirstHalf: boolean;
  dayCount: number;
  reason: string;
  status: unknown;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
  decidedBy?: { firstName: string; lastName: string } | null;
}) {
  return {
    id: r.id,
    from: iso(r.fromDate),
    to: iso(r.toDate),
    leaveType: String(r.leaveType),
    isHalfDay: r.isHalfDay,
    isFirstHalf: r.isFirstHalf,
    dayCount: r.dayCount,
    reason: r.reason,
    status: String(r.status),
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    decidedBy: r.decidedBy ? `${r.decidedBy.firstName} ${r.decidedBy.lastName}`.trim() : null,
    createdAt: r.createdAt,
  };
}

// Who is told about a new request: HR/Admin of the person's company, plus owners who are HR/Admin (they decide every company's
// requests). Never the requester. A pinned deployment drops the owners from other companies.
const deciderIdsFor = (platformId: string, exceptUserId: string) => deciderIdsForCompany(platformId, exceptUserId);

const dayLabel = (r: { fromDate: Date; toDate: Date }) => (iso(r.fromDate) === iso(r.toDate) ? iso(r.fromDate) : `${iso(r.fromDate)} to ${iso(r.toDate)}`);

// --- employee ----------------------------------------------------------------

export async function requestLeave(
  userId: string,
  body: { from?: string; to?: string; leaveType?: string; isHalfDay?: boolean; isFirstHalf?: boolean; reason?: string }
) {
  const me = await who(userId);

  const from = parseIsoDay(body.from);
  const to = body.to ? parseIsoDay(body.to) : from;
  if (to.getTime() < from.getTime()) throw new Error("BAD_RANGE");
  if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_SPAN_DAYS) throw new Error("RANGE_TOO_LONG");
  const today = platformToday(me.timezone);
  if (from.getTime() < today.getTime() - MAX_DAYS_BACK * DAY_MS) throw new Error("TOO_OLD");

  const leaveType = REQUEST_TYPES.find((t) => t === body.leaveType);
  if (!leaveType) throw new Error("BAD_TYPE");

  const reason = String(body.reason ?? "").trim();
  if (reason.length < 3) throw new Error("REASON_REQUIRED");
  if (reason.length > 500) throw new Error("REASON_TOO_LONG");

  const isHalfDay = body.isHalfDay === true;
  if (isHalfDay && from.getTime() !== to.getTime()) throw new Error("HALF_DAY_ONE_DAY");

  const dates = await workingDates(me.platformId, me.workingDays, from, to);
  if (dates.length === 0) throw new Error("NO_WORKING_DAYS");

  const [clash, pending] = await Promise.all([
    prisma.leaveDay.count({ where: { userId, date: { gte: from, lte: to } } }),
    prisma.leaveRequest.count({
      where: { userId, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: to }, toDate: { gte: from } },
    }),
  ]);
  if (clash > 0 || pending > 0) throw new Error("LEAVE_OVERLAP");

  const created = await prisma.leaveRequest.create({
    data: {
      platformId: me.platformId,
      userId,
      fromDate: from,
      toDate: to,
      leaveType,
      isHalfDay,
      isFirstHalf: body.isFirstHalf !== false,
      dayCount: isHalfDay ? 0.5 : dates.length,
      reason,
    },
    include: { decidedBy: deciderSelect },
  });

  // Tell the people who decide. A notification problem must never fail the request.
  try {
    const person = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, employeeCode: true } });
    const name = `${person?.firstName ?? ""} ${person?.lastName ?? ""}`.trim() || "An employee";
    // The manager answers first; HR is told when the manager approves. No manager (or an HR/Admin boss): straight to HR.
    const approvers = await startStep("LEAVE", created.id, { id: userId, platformId: me.platformId }).catch((e) => { console.error("[leave] manager step not created:", e); return [] as string[]; });
    const what = `${name} (${person?.employeeCode ?? "no ID"}) asked for ${isHalfDay ? "a half day" : `${created.dayCount} day(s)`} of ${leaveType.toLowerCase()} leave, ${dayLabel(created)}. Reason: ${reason}`;
    await notifyUsers({
      platformId: me.platformId,
      userIds: approvers.length ? approvers : await deciderIdsFor(me.platformId, userId),
      type: "LEAVE_REQUESTED",
      title: approvers.length ? `Leave request for your approval: ${name}` : `Leave request: ${name}`,
      body: what,
      link: "/dashboard/leave",
      data: { requestId: created.id },
    });
  } catch (e) {
    console.error("[leave] could not notify deciders:", e);
  }
  return requestView(created);
}

export async function myLeave(userId: string, yearParam?: unknown) {
  const me = await who(userId);
  const year = parseYear(yearParam, me.timezone);
  const [requests, taken] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { decidedBy: deciderSelect },
    }),
    takenByUser(me.platformId, year, [userId]),
  ]);
  const steps = await stepViews("LEAVE", requests.map((r) => r.id));
  return {
    year,
    taken: taken.get(userId) ?? emptyTaken(),
    pending: requests.filter((r) => r.status === "PENDING").length,
    requests: requests.map((r) => ({ ...requestView(r), managerStep: steps.get(r.id) ?? null })),
  };
}

export async function cancelRequest(userId: string, requestId: string) {
  const r = await prisma.leaveRequest.findUnique({ where: { id: requestId } });
  if (!r || r.userId !== userId) throw new Error("NOT_FOUND");
  // The status is part of the filter: if HR decides at the same moment,
  // exactly one of the two wins.
  const res = await prisma.leaveRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  if (res.count === 0) throw new Error("NOT_PENDING");
  return { ok: true };
}

// --- HR / Admin -------------------------------------------------------------

async function decider(viewerId: string) {
  const v = await who(viewerId);
  if (!DECIDERS.includes(v.role)) throw new Error("NOT_ALLOWED");
  return { ...v, access: await accessFor(viewerId) };
}

// Which companies the decider may see: their own, or all of them for an owner.
const scopeOf = (v: { access: Access }) => scopeWhere(v.access);
const takenScope = (v: { access: Access }) => (v.access.all ? undefined : v.access.ids);

export async function listRequests(viewerId: string, status?: unknown) {
  const v = await decider(viewerId);
  const wanted = (["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const).find((s) => s === status);
  const rows = await prisma.leaveRequest.findMany({
    where: { ...scopeOf(v), ...(wanted ? { status: wanted } : {}) },
    orderBy: [{ createdAt: "desc" }],
    take: 300,
    include: { user: { select: personSelect }, decidedBy: deciderSelect },
  });
  const year = platformToday(v.timezone).getUTCFullYear();
  const taken = await takenByUser(takenScope(v), year, [...new Set(rows.map((r) => r.userId))]);
  const steps = await stepViews("LEAVE", rows.map((r) => r.id));
  return {
    year,
    requests: rows.map((r) => ({
      ...requestView(r),
      managerStep: steps.get(r.id) ?? null,
      person: {
        id: r.user.id,
        name: `${r.user.firstName} ${r.user.lastName}`.trim(),
        employeeCode: r.user.employeeCode,
        designation: r.user.designation,
      },
      takenThisYear: taken.get(r.userId) ?? emptyTaken(),
    })),
  };
}

// The employee hears the answer in their bell. Never allowed to fail the decision.
async function tellRequester(r: { id: string; platformId: string; userId: string; fromDate: Date; toDate: Date }, outcome: "APPROVED" | "REJECTED", note: string | null) {
  try {
    await notifyUsers({
      platformId: r.platformId,
      userIds: [r.userId],
      type: "LEAVE_DECIDED",
      title: outcome === "APPROVED" ? "Leave approved" : "Leave not approved",
      body: `Your leave for ${dayLabel(r)} was ${outcome === "APPROVED" ? "approved" : "not approved"}.${note ? ` HR comment: ${note}` : ""}`,
      link: "/dashboard/leave",
      data: { requestId: r.id },
    });
  } catch (e) {
    console.error("[leave] could not notify requester:", e);
  }
}

export async function decideRequest(viewerId: string, requestId: string, decision: unknown, note: unknown, skip: { skipManager?: unknown; skipReason?: unknown } = {}) {
  const v = await decider(viewerId);
  if (decision !== "APPROVE" && decision !== "REJECT") throw new Error("BAD_DECISION");
  const text = String(note ?? "").trim().slice(0, 500) || null;

  const r = await prisma.leaveRequest.findFirst({ where: { id: requestId, ...scopeOf(v) } });
  if (!r) throw new Error("NOT_FOUND");
  if (r.userId === v.id) throw new Error("OWN_REQUEST");
  if (r.status !== "PENDING") throw new Error("ALREADY_DECIDED");
  // The manager answers first. HR can approve only after the manager approved (or, with a written reason, without the manager);
  // a manager's rejection can never be turned into an approval.
  const skipReason = await gateForHr("LEAVE", r.id, v.id, { ...skip, decision });
  const viaSkip = skipReason ? ` (decided without the manager: ${skipReason})` : "";

  if (decision === "REJECT") {
    const res = await prisma.leaveRequest.updateMany({
      where: { id: r.id, status: "PENDING" },
      data: { status: "REJECTED", decidedById: v.id, decidedAt: new Date(), decisionNote: text },
    });
    if (res.count === 0) throw new Error("ALREADY_DECIDED");
    auditNote({ recordType: "LeaveRequest", recordId: r.id, targetUserId: r.userId, before: { status: "PENDING" }, after: { status: "REJECTED", decisionNote: text }, summary: `Rejected leave ${iso(r.fromDate)} to ${iso(r.toDate)}${viaSkip}` });
    await tellRequester(r, "REJECTED", text);
    return { status: "REJECTED" };
  }

  // Approve: work out the days NOW (a holiday may have been added since the
  // request), then flip the status and write the days in ONE transaction so a
  // request can never be approved without its days.
  const requester = await who(r.userId);
  const dates = await workingDates(r.platformId, requester.workingDays, r.fromDate, r.toDate);

  await prisma.$transaction(async (tx) => {
    const res = await tx.leaveRequest.updateMany({
      where: { id: r.id, status: "PENDING" },
      data: {
        status: "APPROVED",
        decidedById: v.id,
        decidedAt: new Date(),
        decisionNote: text,
        dayCount: r.isHalfDay ? 0.5 : dates.length,
      },
    });
    if (res.count === 0) throw new Error("ALREADY_DECIDED");
    for (const date of dates) {
      const data = {
        leaveType: r.leaveType,
        isHalfDay: r.isHalfDay,
        isFirstHalf: r.isFirstHalf,
        note: r.reason,
        markedById: v.id,
        leaveRequestId: r.id,
      };
      await tx.leaveDay.upsert({
        where: { userId_date: { userId: r.userId, date } },
        update: data,
        create: { platformId: r.platformId, userId: r.userId, date, ...data },
      });
    }
  });
  auditNote({ recordType: "LeaveRequest", recordId: r.id, targetUserId: r.userId, before: { status: "PENDING" }, after: { status: "APPROVED", days: dates.length, decisionNote: text }, summary: `Approved leave ${iso(r.fromDate)} to ${iso(r.toDate)} (${dates.length} working days)${viaSkip}` });
  await tellRequester(r, "APPROVED", text);
  return { status: "APPROVED", days: dates.length };
}

// --- manager step ----------------------------------------------------------------

async function managerOnly(managerId: string) {
  const m = await who(managerId);
  if (m.role !== "MANAGER") throw new Error("NOT_ALLOWED");
  return m;
}

// Requests waiting for this manager, and the ones they answered recently.
export async function managerRequests(managerId: string) {
  const m = await managerOnly(managerId);
  const rows = await rowsForManager("LEAVE", managerId);
  const ids = [...new Set(rows.map((r) => r.requestId))];
  const reqs = ids.length
    ? await prisma.leaveRequest.findMany({ where: { id: { in: ids }, platformId: m.platformId }, include: { user: { select: personSelect }, decidedBy: deciderSelect } })
    : [];
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const year = platformToday(m.timezone).getUTCFullYear();
  const taken = await takenByUser(m.platformId, year, [...new Set(reqs.map((r) => r.userId))]);
  const steps = await stepViews("LEAVE", ids);
  const view = (id: string) => {
    const r = byId.get(id);
    if (!r) return null;
    return {
      ...requestView(r),
      managerStep: steps.get(id) ?? null,
      person: { id: r.user.id, name: `${r.user.firstName} ${r.user.lastName}`.trim(), employeeCode: r.user.employeeCode, designation: r.user.designation },
      takenThisYear: taken.get(r.userId) ?? emptyTaken(),
    };
  };
  const pending = rows.filter((r) => r.status === "PENDING").map((r) => view(r.requestId)).filter((x) => x && x.status === "PENDING");
  const answered = rows.filter((r) => r.status !== "PENDING").map((r) => view(r.requestId)).filter(Boolean);
  return { year, pending, answered };
}

export async function managerDecide(managerId: string, requestId: string, decision: unknown, note: unknown) {
  const m = await managerOnly(managerId);
  if (decision !== "APPROVE" && decision !== "REJECT") throw new Error("BAD_DECISION");
  const text = String(note ?? "").trim().slice(0, 500) || null;
  if (decision === "REJECT" && (!text || text.length < 3)) throw new Error("COMMENT_REQUIRED");

  const r = await prisma.leaveRequest.findFirst({ where: { id: requestId, platformId: m.platformId }, include: { user: { select: { firstName: true, lastName: true, employeeCode: true } } } });
  if (!r) throw new Error("NOT_FOUND");
  if (r.status !== "PENDING") throw new Error("ALREADY_DECIDED");
  await claimStep({ kind: "LEAVE", requestId: r.id, managerId, requesterId: r.userId, decision, note: text });

  const name = `${r.user.firstName} ${r.user.lastName}`.trim();
  if (decision === "REJECT") {
    // The manager's rejection closes the request. (If the person cancelled at the same moment, there is nothing left to close.)
    await prisma.leaveRequest.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: "REJECTED", decidedById: managerId, decidedAt: new Date(), decisionNote: text } });
    auditNote({ recordType: "LeaveRequest", recordId: r.id, targetUserId: r.userId, before: { status: "PENDING" }, after: { status: "REJECTED", by: "manager", decisionNote: text }, summary: `Manager rejected leave ${dayLabel(r)}` });
    await tellRequester(r, "REJECTED", text ? `${text} (your manager)` : null);
    return { status: "REJECTED" };
  }
  auditNote({ recordType: "LeaveRequest", recordId: r.id, targetUserId: r.userId, before: { managerStep: "PENDING" }, after: { managerStep: "APPROVED", decisionNote: text }, summary: `Manager approved leave ${dayLabel(r)}; waiting for HR` });
  try {
    await notifyUsers({
      platformId: r.platformId,
      userIds: await deciderIdsFor(r.platformId, r.userId),
      type: "LEAVE_REQUESTED",
      title: `Leave request ready for HR: ${name}`,
      body: `${name} (${r.user.employeeCode ?? "no ID"}): ${dayLabel(r)}. Their manager approved it${text ? `: ${text}` : ""}. HR decides now.`,
      link: "/dashboard/leave",
      data: { requestId: r.id },
    });
    await notifyUsers({
      platformId: r.platformId,
      userIds: [r.userId],
      type: "LEAVE_DECIDED",
      title: "Your manager approved your leave",
      body: `Your leave for ${dayLabel(r)} was approved by your manager. It is now waiting for HR.`,
      link: "/dashboard/leave",
      data: { requestId: r.id },
    });
  } catch (e) {
    console.error("[leave] could not notify after manager step:", e);
  }
  return { status: "WAITING_FOR_HR" };
}

// Everyone in the company with the leave they have taken this year.
export async function leaveSummary(viewerId: string, yearParam?: unknown) {
  const v = await decider(viewerId);
  const year = parseYear(yearParam, v.timezone);
  const [people, taken, pending] = await Promise.all([
    prisma.user.findMany({
      where: { ...scopeOf(v), status: { not: "EXITED" } },
      select: personSelect,
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    takenByUser(takenScope(v), year),
    prisma.leaveRequest.groupBy({
      by: ["userId"],
      where: { ...scopeOf(v), status: "PENDING" },
      _count: true,
    }),
  ]);
  const pend = new Map(pending.map((p) => [p.userId, p._count]));
  return {
    year,
    people: people.map((p) => ({
      id: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      employeeCode: p.employeeCode,
      designation: p.designation,
      taken: taken.get(p.id) ?? emptyTaken(),
      pending: pend.get(p.id) ?? 0,
    })),
  };
}

// One person's leave history for a year (HR drill-down).
export async function personLeave(viewerId: string, personId: string, yearParam?: unknown) {
  const v = await decider(viewerId);
  const year = parseYear(yearParam, v.timezone);
  const yStart = new Date(Date.UTC(year, 0, 1));
  const yEnd = new Date(Date.UTC(year, 11, 31));
  const person = await prisma.user.findFirst({
    where: { id: personId, ...scopeOf(v) },
    select: { ...personSelect, platformId: true },
  });
  if (!person) throw new Error("NOT_FOUND");
  const [requests, days, taken] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: { userId: personId, fromDate: { lte: yEnd }, toDate: { gte: yStart } },
      orderBy: { fromDate: "desc" },
      include: { decidedBy: deciderSelect },
    }),
    prisma.leaveDay.findMany({
      where: { userId: personId, platformId: person.platformId, date: { gte: yStart, lte: yEnd } },
      orderBy: { date: "desc" },
      select: { date: true, leaveType: true, isHalfDay: true, leaveRequestId: true },
    }),
    takenByUser(person.platformId, year, [personId]),
  ]);
  return {
    year,
    person: {
      id: person.id,
      name: `${person.firstName} ${person.lastName}`.trim(),
      employeeCode: person.employeeCode,
      designation: person.designation,
    },
    taken: taken.get(personId) ?? emptyTaken(),
    requests: requests.map(requestView),
    days: days.map((d) => ({
      date: iso(d.date),
      leaveType: String(d.leaveType),
      isHalfDay: d.isHalfDay,
      fromRequest: d.leaveRequestId !== null,
    })),
  };
}
