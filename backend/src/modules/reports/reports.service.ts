// ===========================================================================
// REPORTS — aggregate work sessions over any date range.
//
// Reads the pre-computed totals on work_sessions. Never recalculates from
// breaks and meetings — that is recompute-on-write's job, done at the moment
// the break or meeting closes.
//
// ATTAINMENT: EXPECTED-DAYS MODEL
// Target accrues per SCHEDULED working day, not per day attended. Absence
// therefore drags attainment down, which is what anyone reading an
// attendance report assumes they are looking at. Approved leave removes the
// day's target entirely, so taking leave you are entitled to is neutral.
//
// A report is a snapshot of recorded fact. Time ticking on a session that is
// still open is NOT added; the response flags hasOpenSessions so the UI can
// say so. The Live Team page is the real-time view.
// ===========================================================================

import { prisma } from "../../lib/prisma.js";
import { narrowIds } from "../hr-filters/hrFilters.service.js";
import type { HrFilters } from "../hr-filters/hrFilters.logic.js";
import { accessFor, scopeWhere } from "../../lib/companyAccess.js";
import { onlyPinnedCompany } from "../../lib/deployment.js";
import { visibleUserIds } from "../tracker/tracker.service.js";
import { huddleSecondsByDay } from "../meetings/participation.service.js";
import { awayOf } from "../tracker/activityClass.js";
import { platformToday, parseIsoDay } from "../../lib/dates.js";

export type GroupBy = "person" | "day" | "week" | "month" | "year";

const WEIGHT_VALUES: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 5,
};

const EXCLUDED_STATUSES = new Set(["CANDIDATE", "OFFER_SENT", "OFFER_ACCEPTED"]);

// Days a holiday row removes from the expected count. An OPTIONAL_HOLIDAY is
// deliberately not here — it is optional, so the day is still expected.
const NON_WORKING_DAY_TYPES = new Set(["PUBLIC_HOLIDAY", "WEEKLY_OFF"]);

const DEFAULT_PRODUCTIVE_HOURS = 8;
const DEFAULT_BREAK_BUDGET_MINUTES = 60;
const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5, 6];

// --- date helpers ----------------------------------------------------------
// @db.Date columns come back as UTC midnight, so slicing the ISO string is
// the correct way to get the calendar day. Never use getDate() here — that
// applies the server's local offset and can shift the day by one.

function toKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDay(value: string): Date {
  return parseIsoDay(value);
}

// ISO week: weeks start Monday, and the week belongs to whichever year holds
// its Thursday. This is why "2026-W01" can contain days from 2025.
function isoWeekKey(date: Date): string {
  const t = new Date(date.getTime());
  const dayOfWeek = t.getUTCDay() || 7; // Sunday 0 -> 7
  t.setUTCDate(t.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function bucketKey(date: Date, groupBy: GroupBy): string {
  const iso = toKey(date);
  if (groupBy === "day") return iso;
  if (groupBy === "week") return isoWeekKey(date);
  if (groupBy === "month") return iso.slice(0, 7);
  if (groupBy === "year") return iso.slice(0, 4);
  return iso;
}

// --- who is the viewer allowed to see? -------------------------------------
// Scope comes from the JWT's userId and the role on their own row. It is
// never taken from the request, so adding ?userId= to the URL changes
// nothing — that is the IDOR guard.

async function resolveScope(viewerId: string) {
  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    select: {
      id: true,
      role: true,
      platformId: true,
      platform: { select: { name: true, timezone: true } },
    },
  });

  if (!viewer) throw new Error("NOT_FOUND");

  let userIds: string[];

  if (viewer.role === "EMPLOYEE") {
    userIds = [viewer.id];
  } else if (viewer.role === "MANAGER") {
    // Same rule as Live Team and the task queue: teams they run + direct reports (plus themselves).
    const team = await visibleUserIds(viewer);
    userIds = await onlyPinnedCompany(Array.from(new Set([viewer.id, ...team])));
  } else {
    // HR and Admin: every company they act on (company access), not only their own.
    const everyone = await prisma.user.findMany({
      where: { ...scopeWhere(await accessFor(viewer.id)) },
      select: { id: true, status: true },
    });
    userIds = everyone
      .filter((u) => !EXCLUDED_STATUSES.has(String(u.status)))
      .map((u) => u.id);
  }

  return { viewer, userIds };
}

// --- the report -------------------------------------------------------------

export async function getTeamReport(
  viewerId: string,
  fromStr: string,
  toStr: string,
  groupBy: GroupBy = "person",
  onlyUserId?: string,
  filters?: HrFilters
) {
  const from = parseDay(fromStr);
  const to = parseDay(toStr);
  if (to.getTime() < from.getTime()) throw new Error("BAD_RANGE");

  const { viewer, userIds: scopeIds } = await resolveScope(viewerId);
  // The HR filters (company, project, reporting manager, name/ID search) narrow what the viewer may already see; every figure below is built from this list.
  const narrowed = await narrowIds(scopeIds, filters);
  const visibleIds = narrowed.ids;

  // Optional single-person view. It can only NARROW the list the viewer is
  // already allowed to see; an id outside that list yields an empty report,
  // never someone else's data.
  const userIds = onlyUserId
    ? visibleIds.filter((id) => id === onlyUserId)
    : visibleIds;

  if (userIds.length === 0) {
    return emptyReport(fromStr, toStr, groupBy);
  }

  const dateFilter = { gte: from, lte: to };

  // Targets, working days and holidays belong to a COMPANY. HR/Admin may be looking at several, so those are read for every company in view and
  // applied per person below; for anyone else this is exactly the viewer's own company, as before.
  const staffView = viewer.role === "HR" || viewer.role === "ADMIN";
  const companyScope = staffView ? scopeWhere(await accessFor(viewer.id)) : { platformId: viewer.platformId };

  // Seven reads, one round trip of latency. Not seven sequential awaits.
  const [users, sessions, leaveDays, tasks, alerts, config, shifts, holidays] =
    await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          employeeCode: true,
          role: true,
          platformId: true,
          designation: true,
          shiftId: true,
          dateOfJoining: true,
          exitDate: true,
        },
        orderBy: [{ firstName: "asc" }],
      }),

      prisma.workSession.findMany({
        where: { userId: { in: userIds }, date: dateFilter },
        select: {
          userId: true,
          date: true,
          status: true,
          logoutAt: true,
          productiveSeconds: true,
          breakSeconds: true,
          // the rows themselves: Break and Washroom are worked out from them, for old and new days alike
          breaks: { select: { breakType: true, reason: true, startedAt: true, endedAt: true } },
          meetingSeconds: true,
          wasLateLogin: true,
          lateByMinutes: true,
          autoClosed: true,
        },
      }),

      prisma.leaveDay.findMany({
        where: { userId: { in: userIds }, date: dateFilter },
        select: { userId: true, date: true, isHalfDay: true },
      }),

      prisma.dailyTask.findMany({
        where: { userId: { in: userIds }, date: dateFilter },
        select: { userId: true, date: true, weight: true, status: true, approvalStatus: true, outcome: true },
      }),

      prisma.alert.findMany({
        where: { userId: { in: userIds }, date: dateFilter },
        select: { userId: true, date: true, alertType: true, severity: true },
      }),

      prisma.teamConfig.findMany({
        where: { team: companyScope },
        select: { productiveHours: true, breakBudgetMinutes: true, team: { select: { platformId: true } } },
      }),

      prisma.shift.findMany({
        where: companyScope,
        select: { id: true, workingDays: true, isDefault: true, platformId: true },
      }),

      prisma.holiday.findMany({
        where: { ...companyScope, date: dateFilter },
        select: { date: true, dayType: true, platformId: true },
      }),
    ]);

  // The first team configuration of each company (the same one the single-company report always used), and the viewer's own as the headline target.
  const configOf = new Map<string, { productiveHours: unknown; breakBudgetMinutes: number }>();
  for (const c of config) if (!configOf.has(c.team.platformId)) configOf.set(c.team.platformId, c);
  const own = configOf.get(viewer.platformId) ?? config[0];
  const productiveHours = Number(own?.productiveHours ?? DEFAULT_PRODUCTIVE_HOURS);
  const breakBudgetMinutes = own?.breakBudgetMinutes ?? DEFAULT_BREAK_BUDGET_MINUTES;
  const targetSecondsOf = (platformId: string) => Math.round(Number(configOf.get(platformId)?.productiveHours ?? productiveHours) * 3600);

  // --- lookups --------------------------------------------------------------

  const shiftDays = new Map<string, number[]>();
  const defaultDaysOf = new Map<string, number[]>(); // each company's default shift
  for (const s of shifts) {
    shiftDays.set(s.id, s.workingDays);
    if (s.isDefault) defaultDaysOf.set(s.platformId, s.workingDays);
  }

  const holidayDaysOf = new Map<string, Set<string>>(); // each company's own holidays
  for (const h of holidays) {
    if (!NON_WORKING_DAY_TYPES.has(String(h.dayType))) continue;
    const set = holidayDaysOf.get(h.platformId) ?? new Set<string>();
    set.add(toKey(h.date));
    holidayDaysOf.set(h.platformId, set);
  }

  // userId|YYYY-MM-DD -> isHalfDay
  const leaveMap = new Map<string, boolean>();
  for (const l of leaveDays) {
    leaveMap.set(`${l.userId}|${toKey(l.date)}`, l.isHalfDay);
  }

  // Days each company was actually using the tracker. SAME rule as payroll (attendance.service): a day on which NOBODY in
  // the whole company clocked in is "Not tracked", not a day everyone was absent. It is paid and owes no target, so it
  // is neither "Absent" nor an expected day here either. Company-wide, not just the people this viewer can see.
  const platformIds = Array.from(new Set(users.map((u) => u.platformId)));
  const [trackedRows, memberships] = await Promise.all([
    prisma.workSession.groupBy({
      by: ["platformId", "date"],
      where: { platformId: { in: platformIds }, date: dateFilter },
      _count: { id: true },
    }),
    prisma.teamMember.findMany({
      where: { userId: { in: userIds }, isActive: true },
      select: { userId: true, team: { select: { name: true } } },
    }),
  ]);
  const trackedDays = new Set(trackedRows.map((r) => `${r.platformId}|${toKey(r.date)}`));
  // A person in several teams is listed under the first one alphabetically, so grouping is stable.
  const teamOf = new Map<string, string>();
  for (const m of memberships) {
    const cur = teamOf.get(m.userId);
    if (!cur || m.team.name.localeCompare(cur) < 0) teamOf.set(m.userId, m.team.name);
  }
  // Managers' attendance is shown, but they are left out of the productivity figures (totals, buckets).
  const managerIds = new Set(users.filter((u) => String(u.role) === "MANAGER").map((u) => u.id));

  // --- accumulators ---------------------------------------------------------

  const byPerson = new Map<string, PersonRow>();
  for (const u of users) {
    byPerson.set(u.id, {
      userId: u.id,
      name: `${u.firstName} ${u.lastName}`.trim(),
      email: u.email,
      employeeCode: u.employeeCode,
      role: String(u.role),
      designation: u.designation ?? null,
      teamName: teamOf.get(u.id) ?? null,
      huddleSeconds: 0,
      daysNotTracked: 0,
      daysExpected: 0,
      daysPresent: 0,
      daysOnLeave: 0,
      daysAbsent: 0,
      lateDays: 0,
      lateMinutes: 0,
      autoClosedDays: 0,
      productiveSeconds: 0,
      breakSeconds: 0,
      washroomSeconds: 0,
      meetingSeconds: 0,
      targetSeconds: 0,
      attainment: 0,
      taskScore: 0,
      tasksTotal: 0,
      tasksDone: 0,
      tasksCompleted: 0,
      tasksPending: 0,
      taskCompletion: 0,
      alertCount: 0,
    });
  }

  const byBucket = new Map<string, BucketRow>();
  function bucket(key: string): BucketRow {
    let row = byBucket.get(key);
    if (!row) {
      row = {
        key,
        peopleSeen: new Set<string>(),
        huddleSeconds: 0,
        daysNotTracked: 0,
        daysExpected: 0,
        daysPresent: 0,
        daysOnLeave: 0,
        lateDays: 0,
        productiveSeconds: 0,
        breakSeconds: 0,
      washroomSeconds: 0,
        meetingSeconds: 0,
        targetSeconds: 0,
        tasksCompleted: 0,
        tasksPending: 0,
        alertCount: 0,
      };
      byBucket.set(key, row);
    }
    return row;
  }

  // --- expected days --------------------------------------------------------
  // The range is capped at today in the PLATFORM's timezone. Without this, a
  // month-to-date report run on the 15th would count sixteen future days as
  // days the person failed to work.

  const today = platformToday(viewer.platform?.timezone ?? "Asia/Kolkata");
  const lastDay = to.getTime() > today.getTime() ? today : to;

  const attendedDays = new Set<string>();
  for (const s of sessions) attendedDays.add(`${s.userId}|${toKey(s.date)}`);

  for (const u of users) {
    const person = byPerson.get(u.id)!;
    const days = (u.shiftId ? shiftDays.get(u.shiftId) : undefined) ?? defaultDaysOf.get(u.platformId) ?? DEFAULT_WORKING_DAYS;
    const holidayDays = holidayDaysOf.get(u.platformId) ?? new Set<string>();
    const dailyTargetSeconds = targetSecondsOf(u.platformId);
    const mgr = managerIds.has(u.id);

    const joined = u.dateOfJoining ? u.dateOfJoining.getTime() : -Infinity;
    const left = u.exitDate ? u.exitDate.getTime() : Infinity;

    for (
      let t = from.getTime();
      t <= lastDay.getTime();
      t += 86400000
    ) {
      const date = new Date(t);
      const key = toKey(date);

      // Not employed on this date — no target can be owed.
      if (t < joined || t > left) continue;

      // Not a working day on this person's shift.
      const dow = date.getUTCDay() || 7;
      if (!days.includes(dow)) continue;

      // Public holiday or declared weekly off.
      if (holidayDays.has(key)) continue;

      const b = bucket(bucketKey(date, groupBy));

      const leave = leaveMap.get(`${u.id}|${key}`);
      if (leave === true) {
        // Half day — half the target still applies.
        person.daysExpected += 0.5;
        person.daysOnLeave += 0.5;
        person.targetSeconds += dailyTargetSeconds / 2;
        b.daysExpected += 0.5;
        b.daysOnLeave += 0.5;
        if (!mgr) b.targetSeconds += dailyTargetSeconds / 2;
        continue;
      }
      if (leave === false) {
        // Full leave day — no target accrues, so leave cannot hurt anyone.
        person.daysOnLeave += 1;
        b.daysOnLeave += 1;
        continue;
      }

      // Nobody in the company clocked in that day, and this person did not either: the tracker was not in use.
      if (!attendedDays.has(`${u.id}|${key}`) && !trackedDays.has(`${u.platformId}|${key}`)) {
        person.daysNotTracked += 1;
        b.daysNotTracked += 1;
        continue;
      }

      person.daysExpected += 1;
      person.targetSeconds += dailyTargetSeconds;
      b.daysExpected += 1;
      if (!mgr) b.targetSeconds += dailyTargetSeconds;

      if (!attendedDays.has(`${u.id}|${key}`)) person.daysAbsent += 1;
    }
  }

  // --- actuals from sessions ------------------------------------------------

  let hasOpenSessions = false;
  // Team Huddle time that counted, per person and day. A LABEL inside productive time (never added on top): the productive totals
  // below are unchanged. Same calculation as the employee and manager screens.
  const huddleMap = await huddleSecondsByDay(userIds, from, lastDay);
  const nowDate = new Date();

  for (const s of sessions) {
    if (String(s.status) === "ACTIVE" && !s.logoutAt) hasOpenSessions = true;

    const person = byPerson.get(s.userId);
    const b = bucket(bucketKey(s.date, groupBy));
    const away = awayOf(s, nowDate);

    if (person) {
      person.daysPresent += 1;
      person.productiveSeconds += s.productiveSeconds;
      person.huddleSeconds += huddleMap.get(`${s.userId}|${toKey(s.date)}`) ?? 0;
      person.breakSeconds += away.breakSeconds;
      person.washroomSeconds += away.washroomSeconds;
      person.meetingSeconds += s.meetingSeconds;
      person.lateMinutes += s.lateByMinutes;
      if (s.wasLateLogin) person.lateDays += 1;
      if (s.autoClosed) person.autoClosedDays += 1;
    }

    b.daysPresent += 1;
    if (!managerIds.has(s.userId)) {
      b.huddleSeconds += huddleMap.get(`${s.userId}|${toKey(s.date)}`) ?? 0;
      b.productiveSeconds += s.productiveSeconds;
      b.breakSeconds += away.breakSeconds;
      b.washroomSeconds += away.washroomSeconds;
      b.meetingSeconds += s.meetingSeconds;
    }
    if (s.wasLateLogin) b.lateDays += 1;
    b.peopleSeen.add(s.userId);
  }

  // --- tasks ----------------------------------------------------------------

  for (const t of tasks) {
    const person = byPerson.get(t.userId);
    if (!person) continue;
    const weight = WEIGHT_VALUES[String(t.weight)] ?? 1;
    person.tasksTotal += weight;
    if (String(t.status) === "COMPLETED") person.tasksDone += weight;

    // Counts (not weights). Only APPROVED work counts, and "completed" follows the same rule as the daily target
    // (finished and accepted in full). Approved work that is not fully done yet - still open, partly done or sent
    // back - is "pending". Cancelled tasks and proposals nobody approved are in neither.
    if (String(t.approvalStatus) === "APPROVED" && String(t.status) !== "CANCELLED") {
      const fullyDone = String(t.status) === "COMPLETED" && (t.outcome === null || String(t.outcome) === "COMPLETED");
      const b = bucket(bucketKey(t.date, groupBy));
      if (fullyDone) {
        person.tasksCompleted += 1;
        if (!managerIds.has(t.userId)) b.tasksCompleted += 1;
      } else {
        person.tasksPending += 1;
        if (!managerIds.has(t.userId)) b.tasksPending += 1;
      }
    }
  }

  // --- alerts ---------------------------------------------------------------

  const alertCounts = new Map<string, number>();
  for (const a of alerts) {
    const person = byPerson.get(a.userId);
    if (person) person.alertCount += 1;
    bucket(bucketKey(a.date, groupBy)).alertCount += 1;
    const key = String(a.alertType);
    alertCounts.set(key, (alertCounts.get(key) ?? 0) + 1);
  }

  // --- derived --------------------------------------------------------------

  for (const person of byPerson.values()) {
    person.attainment =
      person.targetSeconds > 0 ? person.productiveSeconds / person.targetSeconds : 0;
    person.taskScore = person.tasksTotal > 0 ? person.tasksDone / person.tasksTotal : 0;
    const counted = person.tasksCompleted + person.tasksPending;
    person.taskCompletion = counted > 0 ? person.tasksCompleted / counted : 0;
  }

  const buckets = Array.from(byBucket.values())
    .map((b) => ({
      key: b.key,
      headcount: b.peopleSeen.size,
      daysExpected: b.daysExpected,
      daysPresent: b.daysPresent,
      daysOnLeave: b.daysOnLeave,
      daysNotTracked: b.daysNotTracked,
      lateDays: b.lateDays,
      productiveSeconds: b.productiveSeconds,
      huddleSeconds: b.huddleSeconds,
      breakSeconds: b.breakSeconds,
      washroomSeconds: b.washroomSeconds,
      meetingSeconds: b.meetingSeconds,
      targetSeconds: b.targetSeconds,
      attainment: b.targetSeconds > 0 ? b.productiveSeconds / b.targetSeconds : 0,
      tasksCompleted: b.tasksCompleted,
      tasksPending: b.tasksPending,
      taskCompletion: b.tasksCompleted + b.tasksPending > 0 ? b.tasksCompleted / (b.tasksCompleted + b.tasksPending) : 0,
      alertCount: b.alertCount,
    }))
    .sort((a, z) => a.key.localeCompare(z.key));

  const people = Array.from(byPerson.values()).sort((a, z) => z.attainment - a.attainment);

  const totals = blankTotals();
  for (const p of people) {
    totals.daysExpected += p.daysExpected;
    totals.daysPresent += p.daysPresent;
    totals.daysOnLeave += p.daysOnLeave;
    totals.daysAbsent += p.daysAbsent;
    totals.lateDays += p.lateDays;
    totals.daysNotTracked += p.daysNotTracked;
    if (p.role === "MANAGER") {
      totals.managersExcluded += 1; // their attendance counts above; their productivity is left out below
    } else {
      totals.productiveSeconds += p.productiveSeconds;
      totals.huddleSeconds += p.huddleSeconds;
      totals.breakSeconds += p.breakSeconds;
      totals.washroomSeconds += p.washroomSeconds;
      totals.meetingSeconds += p.meetingSeconds;
      totals.targetSeconds += p.targetSeconds;
    }
    totals.alertCount += p.alertCount;
    if (p.role !== "MANAGER") {
      totals.tasksTotal += p.tasksTotal;
      totals.tasksDone += p.tasksDone;
      totals.tasksCompleted += p.tasksCompleted;
      totals.tasksPending += p.tasksPending;
    }
  }
  totals.headcount = people.filter((p) => p.daysExpected > 0 || p.daysPresent > 0).length;
  totals.attainment =
    totals.targetSeconds > 0 ? totals.productiveSeconds / totals.targetSeconds : 0;
  totals.taskScore = totals.tasksTotal > 0 ? totals.tasksDone / totals.tasksTotal : 0;
  totals.taskCompletion =
    totals.tasksCompleted + totals.tasksPending > 0 ? totals.tasksCompleted / (totals.tasksCompleted + totals.tasksPending) : 0;

  return {
    range: { from: fromStr, to: toStr },
    groupBy,
    platform: viewer.platform?.name ?? null,
    peopleScope: narrowed.scope,
    scope:
      viewer.role === "EMPLOYEE" ? "self" : viewer.role === "MANAGER" ? "team" : "platform",
    target: { productiveHours, breakBudgetMinutes },
    // Warns the UI that expected days may be overstated because no holiday
    // calendar exists yet — every public holiday would count as a working day.
    holidaysConfigured: holidays.length > 0,
    totals,
    people,
    buckets: groupBy === "person" ? [] : buckets,
    alertBreakdown: Array.from(alertCounts.entries())
      .map(([alertType, count]) => ({ alertType, count }))
      .sort((a, z) => z.count - a.count),
    hasOpenSessions,
  };
}

// --- types ------------------------------------------------------------------

type PersonRow = {
  userId: string;
  name: string;
  email: string;
  employeeCode: string | null;
  role: string;
  designation: string | null;
  teamName: string | null;
  huddleSeconds: number;
  daysNotTracked: number;
  daysExpected: number;
  daysPresent: number;
  daysOnLeave: number;
  daysAbsent: number;
  lateDays: number;
  lateMinutes: number;
  autoClosedDays: number;
  productiveSeconds: number;
  breakSeconds: number;
  washroomSeconds: number;
  meetingSeconds: number;
  targetSeconds: number;
  attainment: number;
  taskScore: number;
  tasksTotal: number;
  tasksDone: number;
  tasksCompleted: number;
  tasksPending: number;
  taskCompletion: number;
  alertCount: number;
};

type BucketRow = {
  key: string;
  peopleSeen: Set<string>;
  huddleSeconds: number;
  daysNotTracked: number;
  daysExpected: number;
  daysPresent: number;
  daysOnLeave: number;
  lateDays: number;
  productiveSeconds: number;
  breakSeconds: number;
  washroomSeconds: number;
  meetingSeconds: number;
  targetSeconds: number;
  tasksCompleted: number;
  tasksPending: number;
  alertCount: number;
};

function blankTotals() {
  return {
    headcount: 0,
    managersExcluded: 0,
    huddleSeconds: 0,
    daysNotTracked: 0,
    daysExpected: 0,
    daysPresent: 0,
    daysOnLeave: 0,
    daysAbsent: 0,
    lateDays: 0,
    productiveSeconds: 0,
    breakSeconds: 0,
      washroomSeconds: 0,
    meetingSeconds: 0,
    targetSeconds: 0,
    attainment: 0,
    taskScore: 0,
    tasksTotal: 0,
    tasksDone: 0,
    tasksCompleted: 0,
    tasksPending: 0,
    taskCompletion: 0,
    alertCount: 0,
  };
}

function emptyReport(fromStr: string, toStr: string, groupBy: GroupBy) {
  return {
    range: { from: fromStr, to: toStr },
    groupBy,
    platform: null,
    scope: "platform",
    target: {
      productiveHours: DEFAULT_PRODUCTIVE_HOURS,
      breakBudgetMinutes: DEFAULT_BREAK_BUDGET_MINUTES,
    },
    holidaysConfigured: false,
    totals: blankTotals(),
    people: [] as PersonRow[],
    buckets: [] as unknown[],
    alertBreakdown: [] as { alertType: string; count: number }[],
    hasOpenSessions: false,
  };
}