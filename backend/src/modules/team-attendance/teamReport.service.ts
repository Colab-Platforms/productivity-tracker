// The complete team productivity report (Manager > Reports & Analytics > Export reports). READ-ONLY.
//
// One call returns everything for ONE period and ONE list of people, so every sheet of the download agrees:
//   * the people and their per-day attendance, working / productive / break / washroom / Team Huddle hours, late remarks, corrections:
//       from getAttendanceReport (the same engine Reports, payroll and the Attendance report read; nothing is recalculated here);
//   * the tasks with project, progress, approval, ratings and feedback: from getProductivityTasks (same rules as the Task productivity report);
//   * what those two do not carry is read here, for the SAME people and dates: every break row, meetings and Team Huddle participation,
//     leave requests (all statuses) and leave days taken, attendance correction requests.
// Who is included is decided ONCE, by the attendance report (the viewer's authorised people narrowed by the shared filters); every other read
// is limited to those ids, so a manager can never receive somebody who does not report to them. Nothing here changes any figure: rows carry the
// stored or engine values, and meeting time is a label inside productive time (never added on top).

import { prisma } from "../../lib/prisma.js";
import { parseIsoDay, platformToday, zonedToUtc } from "../../lib/dates.js";
import type { HrFilters } from "../hr-filters/hrFilters.logic.js";
import { getAttendanceReport } from "./teamAttendance.service.js";
import { getProductivityTasks } from "./productivity.service.js";
import { projectsAndManagers } from "./peopleDetails.js";
import { classOfRow, discussionRemark } from "../tracker/activityClass.js";
import { participationReady } from "../meetings/participation.service.js";

const MAX_RANGE_DAYS = 93;
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/relation|table/i.test(msg) && /does not exist/i.test(msg));
};
/** A table that may not exist on an older database: answer "nothing" instead of failing the whole report. */
async function orNone<T>(run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run();
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
}
const nameOf = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);

export async function getTeamReport(viewerId: string, q: { from?: string; to?: string; filters?: HrFilters }) {
  const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: { id: true, role: true, platform: { select: { timezone: true } } } });
  if (!viewer) throw new Error("USER_NOT_FOUND");
  if (!["MANAGER", "HR", "ADMIN"].includes(String(viewer.role))) throw new Error("NOT_ALLOWED");
  const tz = viewer.platform.timezone;
  const today = platformToday(tz).toISOString().slice(0, 10);
  const fromIso = q.from ? parseIsoDay(q.from).toISOString().slice(0, 10) : today;
  const toRaw = q.to ? parseIsoDay(q.to).toISOString().slice(0, 10) : fromIso;
  if (toRaw < fromIso) throw new Error("BAD_RANGE");
  const days = (Date.parse(toRaw) - Date.parse(fromIso)) / 86400000 + 1;
  if (days > MAX_RANGE_DAYS) throw new Error("RANGE_TOO_LONG");
  const toIso = toRaw > today ? today : toRaw; // nothing exists for a day that has not happened
  const startUtc = zonedToUtc(fromIso, "00:00", tz);
  const endUtc = zonedToUtc(addDays(toIso, 1), "00:00", tz);
  const dayFrom = parseIsoDay(fromIso);
  const dayTo = parseIsoDay(toIso);

  // ---- 1. the people, decided once ----
  const attendance = await getAttendanceReport(viewerId, { from: fromIso, to: toIso, filters: q.filters });
  const opt = attendance.options.people as { id: string; name: string; code: string | null }[];
  const ids = opt.map((p) => p.id);
  const idSet = new Set(ids);
  const empty = {
    generatedAt: new Date().toISOString(), timezone: tz, today, from: fromIso, to: toRaw, days, scope: attendance.scope,
    people: [] as unknown[], attendance: [] as unknown[], tasks: [] as unknown[], breaks: [] as unknown[], meetings: [] as unknown[], liveMeetings: [] as unknown[],
    leave: [] as unknown[], leaveDays: [] as unknown[], corrections: [] as unknown[],
  };
  if (ids.length === 0 || toIso < fromIso) return empty;

  // ---- 2. the same tasks the Task productivity report uses (ratings and feedback included) ----
  const tasksRes = await getProductivityTasks(viewerId, { from: fromIso, to: toIso, filters: q.filters });
  const tasks = (tasksRes.tasks as { userId: string }[]).filter((t) => idSet.has(t.userId));

  // ---- 3. the rest, limited to those ids ----
  const [details, users, breaks, live, leave, leaveDays, corrections, attendees, participation] = await Promise.all([
    projectsAndManagers(ids),
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, designation: true, platform: { select: { name: true } } } }),
    prisma.trackerBreak.findMany({
      where: { workSession: { userId: { in: ids }, date: { gte: dayFrom, lte: dayTo } } },
      select: { id: true, breakType: true, reason: true, startedAt: true, endedAt: true, durationSeconds: true, autoClosed: true, workSession: { select: { userId: true, date: true } } },
      orderBy: [{ startedAt: "asc" }],
    }),
    prisma.trackerMeeting.findMany({
      where: { workSession: { userId: { in: ids }, date: { gte: dayFrom, lte: dayTo } } },
      select: { id: true, meetingType: true, title: true, approvalStatus: true, startedAt: true, endedAt: true, durationSeconds: true, workSession: { select: { userId: true, date: true } } },
      orderBy: [{ requestedAt: "asc" }],
    }),
    prisma.leaveRequest.findMany({
      where: { userId: { in: ids }, fromDate: { lte: dayTo }, toDate: { gte: dayFrom } },
      select: { id: true, userId: true, fromDate: true, toDate: true, leaveType: true, isHalfDay: true, isFirstHalf: true, dayCount: true, reason: true, status: true, decidedAt: true, decisionNote: true, createdAt: true, decidedBy: { select: { firstName: true, lastName: true } } },
      orderBy: [{ fromDate: "asc" }],
    }),
    prisma.leaveDay.findMany({ where: { userId: { in: ids }, date: { gte: dayFrom, lte: dayTo } }, select: { userId: true, date: true, leaveType: true, isHalfDay: true } }),
    orNone(() =>
      prisma.attendanceCorrectionRequest.findMany({
        where: { userId: { in: ids }, date: { gte: dayFrom, lte: dayTo } },
        select: { id: true, userId: true, date: true, correctionType: true, originalLoginAt: true, originalLogoutAt: true, requestedLoginAt: true, requestedLogoutAt: true, reason: true, status: true, reviewedAt: true, reviewComment: true, reviewedBy: { select: { firstName: true, lastName: true } } },
        orderBy: [{ date: "asc" }],
      })
    ),
    // scheduled meetings the people were invited to (or joined), starting inside the period
    orNone(() => prisma.meetingAttendee.findMany({ where: { userId: { in: ids }, meeting: { startsAt: { gte: startUtc, lt: endUtc } } }, select: { meetingId: true, userId: true } })),
    (await participationReady())
      ? orNone(() => prisma.meetingParticipation.findMany({ where: { userId: { in: ids }, joinedAt: { gte: new Date(startUtc.getTime() - 86_400_000), lt: new Date(endUtc.getTime() + 86_400_000) } }, select: { meetingId: true, userId: true, joinedAt: true, leftAt: true, durationSeconds: true, source: true, endedBy: true } }))
      : Promise.resolve([] as { meetingId: string; userId: string; joinedAt: Date; leftAt: Date | null; durationSeconds: number | null; source: string; endedBy: string | null }[]),
  ]);

  // ---- meetings: one row per person per scheduled meeting; never two rows for the same pair ----
  const meetingIds = [...new Set([...attendees.map((a) => a.meetingId), ...participation.map((p) => p.meetingId)])];
  const meetingRows = meetingIds.length
    ? await prisma.meeting.findMany({ where: { id: { in: meetingIds }, startsAt: { gte: startUtc, lt: endUtc } }, select: { id: true, title: true, startsAt: true, endsAt: true, status: true, organizer: { select: { firstName: true, lastName: true } } } })
    : [];
  const meetingById = new Map(meetingRows.map((m) => [m.id, m]));
  const [tracked, responses] = await Promise.all([
    (await participationReady()) && meetingRows.length ? orNone(() => prisma.meetingTracking.findMany({ where: { meetingId: { in: meetingRows.map((m) => m.id) } }, select: { meetingId: true } })) : Promise.resolve([] as { meetingId: string }[]),
    meetingRows.length ? orNone(() => prisma.meetingResponse.findMany({ where: { meetingId: { in: meetingRows.map((m) => m.id) }, userId: { in: ids } }, select: { meetingId: true, userId: true, response: true } })) : Promise.resolve([] as { meetingId: string; userId: string; response: string }[]),
  ]);
  const trackedSet = new Set(tracked.map((t) => t.meetingId));
  const responseOf = new Map(responses.map((r) => [`${r.meetingId}|${r.userId}`, r.response]));
  const partOf = new Map(participation.map((p) => [`${p.meetingId}|${p.userId}`, p]));
  const pairs = new Map<string, { meetingId: string; userId: string }>();
  for (const a of attendees) pairs.set(`${a.meetingId}|${a.userId}`, a);
  for (const p of participation) if (meetingById.has(p.meetingId)) pairs.set(`${p.meetingId}|${p.userId}`, { meetingId: p.meetingId, userId: p.userId });
  const now = new Date();
  const meetings = [...pairs.values()]
    .map((pr) => {
      const m = meetingById.get(pr.meetingId);
      if (!m || String(m.status) === "CANCELLED") return null;
      const p = partOf.get(`${pr.meetingId}|${pr.userId}`);
      const isHuddle = trackedSet.has(m.id);
      const response = responseOf.get(`${m.id}|${pr.userId}`) ?? null;
      // Same rule as the rest of the HRMS: an open record counts only up to the scheduled end and is flagged; nothing is closed here.
      const endForCount = p ? (p.leftAt ?? (m.endsAt < now ? m.endsAt : now)) : null;
      const seconds = p ? (p.durationSeconds ?? Math.max(0, Math.floor((endForCount!.getTime() - p.joinedAt.getTime()) / 1000))) : null;
      const status = p ? (p.leftAt ? "Joined" : "Joined, not ended") : response === "DECLINED" ? "Declined" : isHuddle && m.endsAt < now ? "Not joined" : m.endsAt < now ? "Did not record joining" : "Invited";
      return {
        meetingId: m.id, userId: pr.userId, title: m.title, kind: isHuddle ? "Team Huddle" : "Meeting", organizer: nameOf(m.organizer),
        scheduledStart: m.startsAt.toISOString(), scheduledEnd: m.endsAt.toISOString(), scheduledSeconds: Math.max(0, Math.floor((m.endsAt.getTime() - m.startsAt.getTime()) / 1000)),
        response, status, joinedAt: p ? p.joinedAt.toISOString() : null, leftAt: p?.leftAt ? p.leftAt.toISOString() : null, participationSeconds: seconds,
        openPastEnd: !!p && !p.leftAt && m.endsAt < now, source: p?.source ?? null,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));

  const day = (d: Date) => d.toISOString().slice(0, 10);
  return {
    generatedAt: new Date().toISOString(), timezone: tz, today, from: fromIso, to: toRaw, days, scope: attendance.scope,
    people: opt.map((p) => ({ id: p.id, name: p.name, employeeCode: p.code, designation: users.find((u) => u.id === p.id)?.designation ?? null, company: users.find((u) => u.id === p.id)?.platform.name ?? null, reportingManager: details.get(p.id)?.reportingManager ?? null, projects: details.get(p.id)?.projects ?? [] })),
    attendance: attendance.rows,
    tasks,
    breaks: breaks.map((b) => {
      const c = classOfRow(b);
      const secs = b.durationSeconds ?? (b.endedAt ? Math.max(0, Math.floor((b.endedAt.getTime() - b.startedAt.getTime()) / 1000)) : null);
      return {
        userId: b.workSession.userId, date: day(b.workSession.date), type: String(b.breakType), category: c === "BREAK" ? "Break" : c === "NEUTRAL" ? "Washroom (not a break)" : "Discussion (productive time)",
        countsAsBreak: c === "BREAK", startedAt: b.startedAt.toISOString(), endedAt: b.endedAt ? b.endedAt.toISOString() : null, seconds: secs, running: b.endedAt === null,
        autoClosed: b.autoClosed, remark: discussionRemark(b) ?? (b.reason ?? null),
      };
    }),
    meetings,
    liveMeetings: live.map((m) => ({
      userId: m.workSession.userId, date: day(m.workSession.date), type: String(m.meetingType), title: m.title, approvalStatus: String(m.approvalStatus),
      startedAt: m.startedAt ? m.startedAt.toISOString() : null, endedAt: m.endedAt ? m.endedAt.toISOString() : null, seconds: m.durationSeconds,
      countsInProductive: String(m.approvalStatus) === "APPROVED",
    })),
    leave: leave.map((l) => ({
      id: l.id, userId: l.userId, from: day(l.fromDate), to: day(l.toDate), leaveType: String(l.leaveType), halfDay: l.isHalfDay, firstHalf: l.isFirstHalf, dayCount: l.dayCount, reason: l.reason,
      status: String(l.status), appliedOn: l.createdAt.toISOString(), decidedAt: l.decidedAt ? l.decidedAt.toISOString() : null, decidedBy: nameOf(l.decidedBy), decisionNote: l.decisionNote,
    })),
    leaveDays: leaveDays.map((d) => ({ userId: d.userId, date: day(d.date), leaveType: String(d.leaveType), halfDay: d.isHalfDay })),
    corrections: corrections.map((c) => ({
      userId: c.userId, date: day(c.date), type: String(c.correctionType), originalLoginAt: c.originalLoginAt?.toISOString() ?? null, originalLogoutAt: c.originalLogoutAt?.toISOString() ?? null,
      requestedLoginAt: c.requestedLoginAt?.toISOString() ?? null, requestedLogoutAt: c.requestedLogoutAt?.toISOString() ?? null, reason: c.reason, status: String(c.status),
      reviewedBy: nameOf(c.reviewedBy), reviewedAt: c.reviewedAt ? c.reviewedAt.toISOString() : null, reviewComment: c.reviewComment,
    })),
  };
}
