// Team Attendance & Performance (manager view): the live board and the per-day shift breakdown.
//
// Read-only. Nothing here writes. Everything is derived from the existing work sessions, breaks, meetings
// and leave days, so it can never disagree with Live Team, Reports or the timesheet.
//
// Who is on screen = visibleUserIds (teams the viewer runs + people who report to them; HR/Admin: their
// company) — the same function Live Team and Reports use, so the three can never disagree.
// "Today" and every calendar day are the VIEWER'S company day (platform timezone).

import { prisma } from "../../lib/prisma.js";
import { narrowIds, resolvePeople } from "../hr-filters/hrFilters.service.js";
import { NO_FILTERS, type HrFilters } from "../hr-filters/hrFilters.logic.js";
import { platformToday, parseIsoDay } from "../../lib/dates.js";
import { visibleUserIds } from "../tracker/tracker.service.js";
import { huddleBreakdowns } from "../meetings/participation.service.js";
import { awayRows, isDiscussion, splitAwayTime } from "../tracker/activityClass.js";
import { photoStamps } from "../photos/photos.service.js";
import { remarksBySession } from "../tracker/lateRemarks.js";
import { accessFor, scopeWhere } from "../../lib/companyAccess.js";
import { ARRIVAL_RULES, calendarStatus, minutesAfterLimit } from "./arrival.logic.js";
import { getMonthAttendanceBulk } from "../attendance/attendance.service.js";

// Where no team config exists these match what Live Team already assumes.
const DEFAULT_PRODUCTIVE_HOURS = 8;
const DEFAULT_BREAK_BUDGET_MINUTES = 60;

export type LiveStatus =
  | "WORKING"
  | "TEA"
  | "LUNCH"
  | "BIO"
  | "OTHER_BREAK"
  | "MEETING"
  | "CLOCKED_OUT"
  | "NOT_CLOCKED_IN"
  | "ON_LEAVE";

const BREAK_GROUP: Record<string, "TEA" | "LUNCH" | "BIO" | "OTHER"> = {
  TEA: "TEA",
  LUNCH: "LUNCH",
  WASHROOM: "BIO", // shown as "Bio break"
  PERSONAL: "OTHER",
  OTHER: "OTHER",
};

async function getViewer(viewerId: string) {
  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    select: { id: true, role: true, platformId: true, platform: { select: { timezone: true, name: true } } },
  });
  if (!viewer) throw new Error("USER_NOT_FOUND");
  if (!["MANAGER", "HR", "ADMIN"].includes(String(viewer.role))) throw new Error("NOT_ALLOWED");
  return viewer;
}

const secondsBetween = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));

type SessionWithParts = {
  id: string;
  userId: string;
  loginAt: Date;
  logoutAt: Date | null;
  status: string;
  productiveSeconds: number;
  breakSeconds: number;
  meetingSeconds: number;
  updatedAt: Date;
  wasLateLogin: boolean;
  lateRemark?: string | null;
  lateByMinutes: number;
  breaks: { breakType: string; startedAt: Date; endedAt: Date | null; durationSeconds: number | null }[];
  meetings: { approvalStatus: string; startedAt: Date | null; endedAt: Date | null; durationSeconds: number | null }[];
};

// Totals as of `now`. A finished session uses the stored columns; a running one adds the time since the last
// recompute (same adjustment Live Team makes), so the board is live without writing anything.
function totalsOf(s: SessionWithParts, now: Date) {
  // Break = Tea/Lunch/Personal/Other, Washroom is its own neutral figure; both come from the break rows (an open row runs to now).
  const away = splitAwayTime(s.breaks as never, now);
  let productive = s.productiveSeconds;
  const breakSec = away.breakSeconds;
  let meeting = s.meetingSeconds;
  // Away time only: an open discussion is working time (productive keeps running) and shows as "in meeting".
  const openBreak = awayRows(s.breaks).find((b) => !b.endedAt) ?? null;
  const openDiscussion = s.breaks.some((b) => !b.endedAt && isDiscussion(b));
  const openMeeting = s.meetings.find((m) => m.approvalStatus === "APPROVED" && m.startedAt && !m.endedAt) ?? null;

  if (s.status === "ACTIVE") {
    const since = secondsBetween(s.updatedAt, now);
    if (openBreak) {
      // already counted to now above; productive time does not run while someone is away
    } else {
      productive += since;
      if (openMeeting) meeting += since;
    }
  }
  return { productive, breakSec, washroomSec: away.washroomSeconds, meeting, openBreak, openMeeting, openDiscussion };
}

// When the CURRENT status began.
function statusStartedAt(s: SessionWithParts, openBreak: { startedAt: Date } | null, openMeeting: { startedAt: Date | null } | null): Date {
  if (s.status === "COMPLETED" && s.logoutAt) return s.logoutAt;
  if (openBreak) return openBreak.startedAt;
  if (openMeeting?.startedAt) return openMeeting.startedAt;
  // working: since the latest of login or the end of the last break / meeting
  let latest = s.loginAt.getTime();
  for (const b of s.breaks) if (b.endedAt) latest = Math.max(latest, b.endedAt.getTime());
  for (const m of s.meetings) if (m.approvalStatus === "APPROVED" && m.endedAt) latest = Math.max(latest, m.endedAt.getTime());
  return new Date(latest);
}

async function loadPeople(userIds: string[]) {
  return prisma.user.findMany({
    where: { id: { in: userIds }, status: { notIn: ["SUSPENDED", "EXITED"] } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      designation: true,
      platform: { select: { name: true, timezone: true } },
      reportsTo: { select: { firstName: true, lastName: true } },
      shift: { select: { name: true, startTime: true, endTime: true } },
      teamMemberships: {
        where: { isActive: true },
        select: { team: { select: { name: true, config: { select: { productiveHours: true, breakBudgetMinutes: true } } } } },
        take: 1,
      },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
}

const targetsFor = (person: Awaited<ReturnType<typeof loadPeople>>[number]) => {
  const cfg = person.teamMemberships[0]?.team?.config ?? null;
  return {
    teamName: person.teamMemberships[0]?.team?.name ?? null,
    productiveTargetSeconds: Math.round((cfg?.productiveHours ?? DEFAULT_PRODUCTIVE_HOURS) * 3600),
    breakBudgetSeconds: (cfg?.breakBudgetMinutes ?? DEFAULT_BREAK_BUDGET_MINUTES) * 60,
  };
};

// ---------------------------------------------------------------------------------------------
// LIVE BOARD (today)
// ---------------------------------------------------------------------------------------------
// Who is on the board: HR and Admin see every company they act on (company access); a manager sees their own people. The HR filters (company,
// project, reporting manager, name or ID search) only narrow that list. The cards and the table are built from the SAME filtered people, and
// `scope` says how many of the people the viewer may see are shown.
export async function getLiveBoard(viewerId: string, filters: HrFilters = NO_FILTERS) {
  const viewer = await getViewer(viewerId);
  const timezone = viewer.platform.timezone;
  const date = platformToday(timezone);
  const now = new Date();

  const resolved = await resolvePeople(viewerId, filters);
  const userIds = resolved.ids;
  const scope = { orgTotal: resolved.orgTotal, filteredTotal: resolved.filteredTotal };
  const empty = { generatedAt: now.toISOString(), timezone, date: date.toISOString().slice(0, 10), scope, summary: { online: 0, clockedOut: 0, notClockedIn: 0, onLeave: 0, present: 0, total: 0 }, rows: [] as unknown[] };
  if (userIds.length === 0) return empty;

  const people = await loadPeople(userIds);
  const ids = people.map((p) => p.id);
  // Every project (active team) each person is on, for the Project column. One batched read, never one per person.
  const projectRows = await prisma.teamMember.findMany({ where: { userId: { in: ids }, isActive: true, team: { isActive: true } }, select: { userId: true, team: { select: { name: true } } } });
  const projectsOf = new Map<string, string[]>();
  for (const r of projectRows) projectsOf.set(r.userId, [...(projectsOf.get(r.userId) ?? []), r.team.name]);
  const [sessions, leaveDays] = await Promise.all([
    prisma.workSession.findMany({ where: { userId: { in: ids }, date }, include: { breaks: true, meetings: true } }),
    prisma.leaveDay.findMany({ where: { userId: { in: ids }, date }, select: { userId: true } }),
  ]);
  const byUser = new Map(sessions.map((s) => [s.userId, s]));
  const onLeave = new Set(leaveDays.map((l) => l.userId));
  const remarkOf = await remarksBySession(sessions.map((s) => s.id));
  // Team Huddle time (what people actually declared: join to leave) is part of "Meetings". Shown per person, only for the
  // people the viewer may see (managers, HR and Admin, each within their own reach). Durations only: join/leave clock times stay private.
  const huddle = await huddleBreakdowns(sessions as never, now);

  const stamps = await photoStamps(people.map((p) => p.id));
  const rows = people.map((p) => {
    const t = targetsFor(p);
    const s = byUser.get(p.id) ?? null;
    let status: LiveStatus;
    let startedAt: Date | null = null;
    let productive = 0;
    let breakSec = 0;
    let washroomSec = 0;
    let meeting = 0;
    let shiftSeconds: number | null = null;

    if (!s) {
      status = onLeave.has(p.id) ? "ON_LEAVE" : "NOT_CLOCKED_IN";
    } else {
      const tt = totalsOf(s as SessionWithParts, now);
      productive = tt.productive;
      breakSec = tt.breakSec;
      washroomSec = tt.washroomSec;
      // Live meetings and Team Huddle participation, merged so an overlap counts once; inside clock-in, outside breaks. A person with no
      // huddle record keeps exactly the figure they had before.
      const hb = huddle.get(p.id);
      meeting = hb ? hb.huddleSeconds + hb.otherSeconds : tt.meeting;
      startedAt = statusStartedAt(s as SessionWithParts, tt.openBreak, tt.openMeeting);
      shiftSeconds = secondsBetween(s.loginAt, s.logoutAt ?? now);
      if (s.status === "COMPLETED") status = "CLOCKED_OUT";
      else if (tt.openBreak) status = BREAK_GROUP[tt.openBreak.breakType] === "TEA" ? "TEA" : BREAK_GROUP[tt.openBreak.breakType] === "LUNCH" ? "LUNCH" : BREAK_GROUP[tt.openBreak.breakType] === "BIO" ? "BIO" : "OTHER_BREAK";
      else if (tt.openMeeting || tt.openDiscussion) status = "MEETING";
      else status = "WORKING";
    }

    return {
      userId: p.id,
      photoAt: stamps.get(p.id) ?? null,
      name: `${p.firstName} ${p.lastName}`.trim(),
      employeeCode: p.employeeCode,
      designation: p.designation,
      teamName: t.teamName,
      projects: (projectsOf.get(p.id) ?? []).sort((a, b) => a.localeCompare(b)),
      reportingManager: p.reportsTo ? `${p.reportsTo.firstName} ${p.reportsTo.lastName}`.trim() : null,
      status,
      // The attendance status the Calendar uses (leave, then Present / Late / Half day by the first clock-in, else not clocked in yet): the same rule, not a new one.
      attendanceStatus: calendarStatus({ engineStatus: onLeave.has(p.id) ? "LEAVE" : "ABSENT", loginAt: s ? s.loginAt : null, isToday: true, timezone: p.platform?.timezone ?? timezone }),
      statusStartedAt: startedAt ? startedAt.toISOString() : null,
      company: p.platform?.name ?? null,
      shiftName: p.shift?.name ?? null,
      shiftStart: p.shift?.startTime ?? null,
      shiftEnd: p.shift?.endTime ?? null,
      loginAt: s ? s.loginAt.toISOString() : null,
      logoutAt: s?.logoutAt ? s.logoutAt.toISOString() : null,
      pendingInvite: !!s?.meetings.some((m) => m.approvalStatus === "PENDING"),
      wasLateLogin: s?.wasLateLogin ?? false,
      lateByMinutes: s?.lateByMinutes ?? 0,
      lateRemark: s ? remarkOf.get(s.id) ?? null : null,
      shiftSeconds,
      productiveSeconds: s ? productive : null,
      breakSeconds: s ? breakSec : null,
      washroomSeconds: s ? washroomSec : null,
      meetingSeconds: s ? meeting : null,
      productiveTargetSeconds: t.productiveTargetSeconds,
      breakBudgetSeconds: t.breakBudgetSeconds,
    };
  });

  const online = rows.filter((r) => ["WORKING", "TEA", "LUNCH", "BIO", "OTHER_BREAK", "MEETING"].includes(r.status)).length;
  const clockedOut = rows.filter((r) => r.status === "CLOCKED_OUT").length;
  const summary = {
    online,
    clockedOut,
    notClockedIn: rows.filter((r) => r.status === "NOT_CLOCKED_IN").length,
    onLeave: rows.filter((r) => r.status === "ON_LEAVE").length,
    present: online + clockedOut,
    total: rows.length,
  };

  return { generatedAt: now.toISOString(), timezone, date: date.toISOString().slice(0, 10), scope, summary, rows };
}

// ---------------------------------------------------------------------------------------------
// SHIFT BREAKDOWN (one day)
// ---------------------------------------------------------------------------------------------
export async function getShiftBreakdown(viewerId: string, dateStr?: string, filters?: HrFilters) {
  const viewer = await getViewer(viewerId);
  const timezone = viewer.platform.timezone;
  const today = platformToday(timezone);
  const date = dateStr ? parseIsoDay(dateStr) : today;
  const isToday = date.getTime() === today.getTime();
  const now = new Date();

  const narrowed = await narrowIds(await visibleUserIds({ id: viewer.id, role: String(viewer.role), platformId: viewer.platformId }), filters);
  const userIds = narrowed.ids;
  const base = { generatedAt: now.toISOString(), timezone, date: date.toISOString().slice(0, 10), isToday, scope: narrowed.scope, rows: [] as unknown[] };
  if (userIds.length === 0) return base;

  const people = await loadPeople(userIds);
  const ids = people.map((p) => p.id);
  const [sessions, leaveDays] = await Promise.all([
    prisma.workSession.findMany({ where: { userId: { in: ids }, date }, include: { breaks: true, meetings: true } }),
    prisma.leaveDay.findMany({ where: { userId: { in: ids }, date }, select: { userId: true } }),
  ]);
  const byUser = new Map(sessions.map((s) => [s.userId, s]));
  const onLeave = new Set(leaveDays.map((l) => l.userId));
  const huddle = await huddleBreakdowns(sessions as never, now);

  const rows = people.map((p) => {
    const t = targetsFor(p);
    const s = byUser.get(p.id) ?? null;
    if (!s) {
      return {
        userId: p.id, name: `${p.firstName} ${p.lastName}`.trim(), employeeCode: p.employeeCode, teamName: t.teamName,
        hasSession: false, dayState: onLeave.has(p.id) ? "ON_LEAVE" : isToday ? "NOT_CLOCKED_IN" : "NO_RECORD",
        loginAt: null, logoutAt: null, working: false, shiftSeconds: null,
        teaSeconds: null, lunchSeconds: null, bioSeconds: null, huddleSeconds: null, otherSeconds: null, breakSeconds: null, washroomSeconds: null,
        productiveSeconds: null, productiveTargetSeconds: t.productiveTargetSeconds, breakBudgetSeconds: t.breakBudgetSeconds,
      };
    }
    const sess = s as SessionWithParts;
    const tt = totalsOf(sess, isToday ? now : (s.logoutAt ?? s.updatedAt));
    const end = s.logoutAt ?? (s.status === "ACTIVE" && isToday ? now : s.updatedAt);

    const per = { TEA: 0, LUNCH: 0, BIO: 0, OTHER: 0 };
    for (const b of awayRows(s.breaks)) {
      const secs = b.endedAt ? (b.durationSeconds ?? secondsBetween(b.startedAt, b.endedAt)) : s.status === "ACTIVE" && isToday ? secondsBetween(b.startedAt, now) : 0;
      per[BREAK_GROUP[b.breakType] ?? "OTHER"] += secs;
    }

    return {
      userId: p.id, name: `${p.firstName} ${p.lastName}`.trim(), employeeCode: p.employeeCode, teamName: t.teamName,
      hasSession: true, dayState: s.status === "COMPLETED" ? "CLOCKED_OUT" : "WORKING",
      loginAt: s.loginAt.toISOString(), logoutAt: s.logoutAt ? s.logoutAt.toISOString() : null,
      working: s.status === "ACTIVE",
      shiftSeconds: secondsBetween(s.loginAt, end),
      teaSeconds: per.TEA, lunchSeconds: per.LUNCH, bioSeconds: per.BIO, otherSeconds: per.OTHER,
      // Meeting time: live meetings plus actual Team Huddle participation, merged (never counted twice).
      huddleSeconds: huddle.get(p.id) ? (huddle.get(p.id)!.huddleSeconds + huddle.get(p.id)!.otherSeconds) : tt.meeting,
      breakSeconds: tt.breakSec, washroomSeconds: tt.washroomSec,
      productiveSeconds: tt.productive, productiveTargetSeconds: t.productiveTargetSeconds, breakBudgetSeconds: t.breakBudgetSeconds,
    };
  });

  return { ...base, rows };
}

// ---------------------------------------------------------------------------------------------
// ATTENDANCE REPORT (a date range)
//
// One row per person per day. Status, worked and break hours, login/logout and lateness come from the SAME
// attendance engine that salary and Reports use, so this report can never disagree with them.
// The engine works a month at a time, so a range is read month by month and trimmed to the range.
// ---------------------------------------------------------------------------------------------
const MAX_RANGE_DAYS = 93;
// The "Late Remark" filter. LATE_OR_HALF = Late and Half Day together.
const ARRIVAL_FILTERS = new Set(["ON_TIME", "LATE", "HALF_DAY", "LATE_OR_HALF", "ABSENT"]);
const STATUS_VALUES = new Set(["PRESENT", "HALF_DAY", "ABSENT", "LEAVE", "HOLIDAY", "WEEK_OFF", "NOT_TRACKED", "NOT_CLOCKED_IN"]);
const IST_OFFSET_MS = 330 * 60 * 1000;

const round1 = (n: number) => Math.round(n * 10) / 10;

// "19:00" in IST on `dateIso`, as an instant. Used only for early departure (companies here run on IST).
function istInstant(dateIso: string, hhmm: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const [y, mo, d] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, Number(m[1]), Number(m[2])) - IST_OFFSET_MS);
}

export async function getAttendanceReport(
  viewerId: string,
  q: { from?: string; to?: string; userId?: string; teamId?: string; shift?: string; status?: string; arrival?: string; filters?: HrFilters }
) {
  const viewer = await getViewer(viewerId);
  const timezone = viewer.platform.timezone;
  const today = platformToday(timezone);
  const from = q.from ? parseIsoDay(q.from) : today;
  const to = q.to ? parseIsoDay(q.to) : from;
  if (to.getTime() < from.getTime()) throw new Error("BAD_RANGE");
  if ((to.getTime() - from.getTime()) / 86400000 + 1 > MAX_RANGE_DAYS) throw new Error("RANGE_TOO_LONG");
  if (q.status && !STATUS_VALUES.has(q.status)) throw new Error("BAD_STATUS");
  if (q.arrival && !ARRIVAL_FILTERS.has(q.arrival)) throw new Error("BAD_ARRIVAL");
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);

  // HR/Admin see the companies they are authorized for (assigned ones included); a manager sees the people who report to them.
  const role = String(viewer.role);
  const allowed =
    role === "HR" || role === "ADMIN"
      ? (await prisma.user.findMany({ where: { ...scopeWhere(await accessFor(viewerId)), status: { in: ["ACTIVE", "INVITED"] } }, select: { id: true } })).map((u) => u.id)
      : await visibleUserIds({ id: viewer.id, role, platformId: viewer.platformId });
  // The HR filters (company, project, reporting manager, name/ID search) narrow what the viewer may already see; the KPIs, the table and the exports are
  // all built from this one list.
  const narrowed = await narrowIds(allowed, q.filters);
  const people = narrowed.ids.length
    ? await prisma.user.findMany({
        where: { id: { in: narrowed.ids }, status: { notIn: ["SUSPENDED", "EXITED"] } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeCode: true,
          platform: { select: { timezone: true } },
          shift: { select: { name: true, startTime: true, endTime: true, spansMidnight: true } },
          teamMemberships: {
            where: { isActive: true },
            select: { team: { select: { id: true, name: true, config: { select: { breakBudgetMinutes: true } }, shift: { select: { name: true, startTime: true, endTime: true, spansMidnight: true } } } } },
            take: 1,
          },
        },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      })
    : [];

  // Narrowing filters can only shrink the list the viewer is already allowed to see.
  const meta = people.map((p) => {
    const team = p.teamMemberships[0]?.team ?? null;
    const shift = p.shift ?? team?.shift ?? null;
    return { id: p.id, tz: p.platform.timezone, name: `${p.firstName} ${p.lastName}`.trim(), code: p.employeeCode, teamId: team?.id ?? null, teamName: team?.name ?? null, shift, breakBudgetSeconds: (team?.config?.breakBudgetMinutes ?? DEFAULT_BREAK_BUDGET_MINUTES) * 60 };
  });
  const options = {
    people: meta.map((m) => ({ id: m.id, name: m.name, code: m.code })),
    teams: Array.from(new Map(meta.filter((m) => m.teamId).map((m) => [m.teamId as string, m.teamName as string])).entries()).map(([id, name]) => ({ id, name })),
    shifts: Array.from(new Set(meta.map((m) => m.shift?.name).filter((n): n is string => !!n))).sort(),
  };

  const chosen = meta.filter(
    (m) => (!q.userId || m.id === q.userId) && (!q.teamId || m.teamId === q.teamId) && (!q.shift || m.shift?.name === q.shift)
  );
  const base = { generatedAt: new Date().toISOString(), timezone, today: today.toISOString().slice(0, 10), from: fromIso, to: toIso, options, scope: narrowed.scope };
  if (chosen.length === 0) {
    return { ...base, kpis: { employees: 0, present: 0, halfDay: 0, absent: 0, notYet: 0, workingDays: 0, attendancePct: null as number | null, totalWorkedHours: 0, avgWorkedHours: null as number | null }, rows: [] as unknown[] };
  }

  // Months the range touches.
  const months: [number, number][] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth() + 1;
  while (y < to.getUTCFullYear() || (y === to.getUTCFullYear() && m <= to.getUTCMonth() + 1)) {
    months.push([y, m]);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  const ids = chosen.map((c) => c.id);
  const [monthly, tasks] = await Promise.all([
    Promise.all(months.map(([yy, mm]) => getMonthAttendanceBulk(ids, yy, mm))),
    // Every task of the day that still stands (not cancelled), counted by status, so completed / approved / planned
    // all come from the same rows.
    prisma.dailyTask.groupBy({
      by: ["userId", "date", "status", "approvalStatus"],
      where: { userId: { in: ids }, date: { gte: from, lte: to }, status: { not: "CANCELLED" } },
      _count: { _all: true },
    }),
  ]);
  // What explains a late arrival: the reason the person typed at clock-in, and whether HR corrected the day. Batched, optional tables degrade to nothing.
  const sessionRows = await prisma.workSession.findMany({ where: { userId: { in: ids }, date: { gte: from, lte: to } }, select: { id: true, userId: true, date: true } });
  const sessionKey = new Map(sessionRows.map((s) => [`${s.userId}|${s.date.toISOString().slice(0, 10)}`, s.id]));
  const lateReasonOf = await remarksBySession(sessionRows.map((s) => s.id));
  const correctedByOf = new Map<string, string>();
  if (sessionRows.length) {
    const audits = await prisma.attendanceCorrectionAudit
      .findMany({
        where: { workSessionId: { in: sessionRows.map((s) => s.id) }, action: "APPLIED" },
        orderBy: { createdAt: "desc" },
        select: { workSessionId: true, actedBy: { select: { firstName: true, lastName: true } } },
      })
      .catch(() => [] as { workSessionId: string | null; actedBy: { firstName: string; lastName: string } }[]);
    for (const a of audits) if (a.workSessionId && !correctedByOf.has(a.workSessionId)) correctedByOf.set(a.workSessionId, `${a.actedBy.firstName} ${a.actedBy.lastName}`.trim());
  }
  const taskCount = new Map<string, number>(); // finished and approved (the existing "Tasks completed")
  const taskApproved = new Map<string, number>(); // approved by a manager
  const taskPlanned = new Map<string, number>(); // planned for the day: approved or still waiting for approval
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const t of tasks) {
    const k = `${t.userId}|${t.date.toISOString().slice(0, 10)}`;
    const n = t._count._all;
    const approval = String(t.approvalStatus);
    if (approval === "APPROVED") {
      bump(taskApproved, k, n);
      if (String(t.status) === "COMPLETED") bump(taskCount, k, n);
    }
    if (approval === "APPROVED" || approval === "PENDING") bump(taskPlanned, k, n); // rejected proposals were never planned work
  }
  const byId = new Map(chosen.map((c) => [c.id, c]));

  // Sessions still running today. The engine decides present/half/absent by hours worked, which is right for a
  // FINISHED day but wrong for someone who clocked in an hour ago: they are present and still working. Their hours
  // are topped up with the time since the last recompute (the same adjustment the live board makes).
  const todayIso = today.toISOString().slice(0, 10);
  const nowMs = Date.now();
  const running =
    fromIso <= todayIso && toIso >= todayIso
      ? await prisma.workSession.findMany({
          where: { userId: { in: ids }, date: today, status: "ACTIVE" },
          select: { userId: true, updatedAt: true, breaks: { where: { endedAt: null }, select: { id: true } } },
        })
      : [];
  const runningBy = new Map(running.map((r) => [r.userId, r]));

  const rows: Array<Record<string, unknown>> = [];
  for (const month of monthly.flat()) {
    const who = byId.get(month.userId);
    if (!who) continue;
    for (const d of month.days) {
      if (d.date < fromIso || d.date > toIso) continue;
      if (d.status === "FUTURE" || d.status === "NOT_EMPLOYED") continue;

      // What this row shows. Finished days keep the engine's answer (so this report agrees with payroll); two
      // cases about TODAY are shown honestly instead of as a provisional hours-based verdict.
      const live = d.date === todayIso ? runningBy.get(month.userId) : undefined;
      let status: string = d.status;
      let label: string = d.label;
      let note: string | null = d.note;
      let worked = d.workedHours;
      let productive = d.productiveHours;
      const breakH = d.breakHours;
      const washroomH = d.washroomHours;
      if (live) {
        const since = Math.max(0, nowMs - live.updatedAt.getTime()) / 3_600_000;
        // An open break or washroom is already counted up to now (the engine reads the break rows); only running work time is topped up.
        if (live.breaks.length === 0) {
          worked += since;
          productive += since;
        }
        if (status === "ABSENT" || status === "HALF_DAY") {
          status = "PRESENT";
          label = "Present";
          note = null;
        }
      } else if (d.date === todayIso && status === "ABSENT" && d.loginAt === null) {
        // Nobody can be called absent while the day is still going: a later clock-in makes them present.
        status = "NOT_CLOCKED_IN";
        label = "Not clocked in yet";
        note = null;
      }
      if (q.status && status !== q.status) continue;

      // "Late Remark": the first check-in against the 09:45 / 10:15 arrival rule (the calendar's rule), in the person's company time. A view only:
      // the existing Status and Late columns above keep their own rules. Absent only after the day is over; today is "Not in yet".
      const arrivalAt = d.loginAt ? new Date(d.loginAt) : null;
      const arrivalCode = calendarStatus({ engineStatus: d.status, loginAt: arrivalAt, isToday: d.date === todayIso, timezone: who.tz, halfDayLeave: d.leaveHalfDay !== null });
      const arrival = arrivalCode === "PRESENT" ? "ON_TIME" : arrivalCode;
      if (q.arrival) {
        const want = q.arrival === "LATE_OR_HALF" ? arrival === "LATE" || arrival === "HALF_DAY" : arrival === q.arrival;
        if (!want) continue;
      }
      const sid = sessionKey.get(`${month.userId}|${d.date}`);

      // Early departure: only for a finished day on a shift that ends the same day.
      let earlyMinutes: number | null = null;
      if (d.logoutAt && who.shift && !who.shift.spansMidnight) {
        const end = istInstant(d.date, who.shift.endTime);
        if (end) earlyMinutes = Math.max(0, Math.round((end.getTime() - new Date(d.logoutAt).getTime()) / 60000));
      }
      const hasWork = d.loginAt !== null;
      rows.push({
        userId: month.userId,
        name: who.name,
        employeeCode: who.code,
        teamName: who.teamName,
        date: d.date,
        shiftName: who.shift?.name ?? null,
        shiftStart: who.shift?.startTime ?? null,
        shiftEnd: who.shift?.endTime ?? null,
        loginAt: d.loginAt,
        logoutAt: d.logoutAt,
        workedHours: hasWork ? worked : null,
        productiveHours: hasWork ? productive : null,
        breakHours: hasWork ? breakH : null,
        washroomHours: hasWork ? washroomH : null,
        arrival, // ON_TIME | LATE | HALF_DAY | ABSENT | LEAVE | HOLIDAY | WEEK_OFF | NOT_TRACKED | NOT_CLOCKED_IN
        arrivalMinutes: arrivalAt ? minutesAfterLimit(arrivalAt, who.tz) : null, // minutes after the Present limit
        arrivalLimit: ARRIVAL_RULES.presentUntil,
        lateReason: sid ? lateReasonOf.get(sid) ?? null : null,
        correctedBy: sid ? correctedByOf.get(sid) ?? null : null,
        breakBudgetSeconds: who.breakBudgetSeconds,
        stillWorking: !!live,
        autoClosed: d.autoClosed,
        note,
        status,
        statusLabel: label,
        leaveType: d.leaveType,
        holidayName: d.holidayName,
        lateMinutes: hasWork ? d.lateByMinutes : null,
        earlyDepartureMinutes: earlyMinutes,
        tasksCompleted: taskCount.get(`${month.userId}|${d.date}`) ?? 0,
        // null (blank in the export) when the person had no tasks that day: nothing is assumed
        tasksPlanned: taskPlanned.get(`${month.userId}|${d.date}`) ?? null,
        tasksApproved: taskPlanned.has(`${month.userId}|${d.date}`) ? taskApproved.get(`${month.userId}|${d.date}`) ?? 0 : null,
      });
    }
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.name).localeCompare(String(b.name)));

  const present = rows.filter((r) => r.status === "PRESENT").length;
  const halfDay = rows.filter((r) => r.status === "HALF_DAY").length;
  const absent = rows.filter((r) => r.status === "ABSENT").length;
  const counted = present + halfDay + absent; // working days only: leave, holidays and week-offs are not "attendance"
  const workedRows = rows.filter((r) => r.status === "PRESENT" || r.status === "HALF_DAY");
  const totalWorked = workedRows.reduce((sum, r) => sum + Number(r.workedHours ?? 0), 0);

  return {
    ...base,
    kpis: {
      employees: new Set(rows.map((r) => r.userId)).size,
      present,
      halfDay,
      absent,
      notYet: rows.filter((r) => r.status === "NOT_CLOCKED_IN").length,
      workingDays: counted,
      attendancePct: counted > 0 ? round1(((present + halfDay * 0.5) / counted) * 100) : null,
      totalWorkedHours: round1(totalWorked),
      avgWorkedHours: workedRows.length > 0 ? round1(totalWorked / workedRows.length) : null,
    },
    rows,
  };
}
