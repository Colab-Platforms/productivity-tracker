// ===========================================================================
// MY TIMESHEET
//
// Read-only. For one person and one date range: the schedule they work to and,
// for each day, the actual clock-in / clock-out and every break and meeting
// interval, so the screen can draw a timeline.
//
// Nothing here is recalculated. Totals come from the columns the tracker
// already writes on every break/meeting/clock-out (recompute-on-write), and the
// "expected days / planned hours" come from the SAME function the Reports page
// uses (getTeamReport, narrowed to this one person), so the timesheet, the
// dashboard and the reports always agree.
//
// Late and overtime are never invented here. Late is the flag the tracker
// stored when the person clocked in (shift start + grace). Overtime is
// described as the existing rule: time on site beyond the configured work day,
// with the same alert threshold the scheduler uses. The screen applies it.
// ===========================================================================

import { prisma } from "../../lib/prisma.js";
import { parseIsoDay, platformToday } from "../../lib/dates.js";
import { awayOf } from "./activityClass.js";
import { getTeamReport } from "../reports/reports.service.js";
import { getContext } from "./tracker.service.js";
import { remarksBySession } from "./lateRemarks.js";
import { computeBreakdown } from "./productiveBreakdown.js";
import { huddlesForSession } from "../meetings/participation.service.js";

const MAX_DAYS = 93;
const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

// The person's OWN planned time for the period: their row in the report, never the report's totals. The totals leave managers out
// of productivity (so the team's figures are not skewed), which made a manager's own planned hours 0 while his days were 6.
export function plannedSecondsOf(people: { userId: string; targetSeconds: number }[], userId: string): number {
  return people.find((p) => p.userId === userId)?.targetSeconds ?? 0;
}

export async function getTimesheet(userId: string, fromStr?: string, toStr?: string) {
  const ctx = await getContext(userId);
  const today = platformToday(ctx.timezone);
  const nowDate = new Date();

  const to = toStr ? parseIsoDay(toStr) : today;
  const from = fromStr ? parseIsoDay(fromStr) : new Date(to.getTime() - 6 * DAY_MS);
  if (to.getTime() < from.getTime()) throw new Error("BAD_RANGE");
  if ((to.getTime() - from.getTime()) / DAY_MS + 1 > MAX_DAYS) throw new Error("RANGE_TOO_LONG");

  // Batched reads, joined in memory.
  const [sessions, holidays, report, corrections] = await Promise.all([
    prisma.workSession.findMany({
      where: { userId, date: { gte: from, lte: to } },
      include: {
        team: { select: { id: true, name: true } },
        breaks: { orderBy: { startedAt: "asc" } },
        // Only meetings that actually ran: an unanswered or declined invite
        // was never work.
        meetings: { where: { approvalStatus: "APPROVED", startedAt: { not: null } }, orderBy: { startedAt: "asc" } },
      },
    }),
    prisma.holiday.findMany({ where: { platformId: ctx.platformId, date: { gte: from, lte: to } }, select: { date: true, name: true, dayType: true } }),
    getTeamReport(userId, iso(from), iso(to), "day", userId),
    // Days HR corrected: the latest applied correction per session, for the "Corrected" marker.
    prisma.attendanceCorrectionAudit.findMany({
      where: { userId, action: "APPLIED", createdAt: { gte: new Date(from.getTime() - 40 * 86_400_000) } },
      orderBy: { createdAt: "desc" },
      select: { workSessionId: true, createdAt: true, actedBy: { select: { firstName: true, lastName: true } } },
    }).catch((e) => {
      // The "Corrected by HR" marker is optional. If the corrections table is not there yet (migration not applied), the timesheet must still load.
      console.error("[timesheet] corrections marker unavailable:", String((e as Error).message).slice(-120));
      return [] as { workSessionId: string | null; createdAt: Date; actedBy: { firstName: string; lastName: string } }[];
    }),
  ]);
  const correctedBy = new Map<string, { at: Date; by: string }>();
  for (const c of corrections) {
    if (c.workSessionId && !correctedBy.has(c.workSessionId)) correctedBy.set(c.workSessionId, { at: c.createdAt, by: `${c.actedBy.firstName} ${c.actedBy.lastName}`.trim() });
  }

  const sessionByDay = new Map(sessions.map((s) => [iso(s.date), s]));
  const remarkOf = await remarksBySession(sessions.map((s) => s.id));
  // The split of each day's productive time (regular / Team Huddle / other eligible). One shared function, so the manager
  // screens show exactly the same numbers. It never changes the productive total.
  const nowForSplit = new Date();
  const splitOf = new Map<string, { breakdown: ReturnType<typeof computeBreakdown>; huddles: Awaited<ReturnType<typeof huddlesForSession>> }>();
  for (const s of sessions) {
    const huddles = await huddlesForSession(userId, s.loginAt, s.logoutAt, nowForSplit);
    const breakdown = computeBreakdown({
      loginAt: s.loginAt, logoutAt: s.logoutAt,
      breaks: s.breaks.map((b) => ({ startedAt: b.startedAt, endedAt: b.endedAt })),
      liveMeetings: s.meetings.map((m) => ({ approvalStatus: String(m.approvalStatus), startedAt: m.startedAt, endedAt: m.endedAt })),
      huddles: huddles.map((h) => ({ id: h.id, joinedAt: h.joinedAt, leftAt: h.leftAt, expectedEnd: h.expectedEnd })),
      now: nowForSplit,
    });
    if (String(s.status) === "COMPLETED") {
      breakdown.productiveSeconds = s.productiveSeconds;
      breakdown.huddleSeconds = Math.min(breakdown.huddleSeconds, s.productiveSeconds);
      breakdown.otherEligibleSeconds = Math.min(breakdown.otherEligibleSeconds, Math.max(0, s.productiveSeconds - breakdown.huddleSeconds));
      breakdown.regularSeconds = Math.max(0, s.productiveSeconds - breakdown.huddleSeconds - breakdown.otherEligibleSeconds);
    }
    splitOf.set(s.id, { breakdown, huddles });
  }
  const holidayByDay = new Map(holidays.map((h) => [iso(h.date), h]));
  // One entry per day, as the Reports page computes expected days and leave.
  type Bucket = { key: string; daysExpected: number; daysOnLeave: number };
  const bucketByDay = new Map((report.buckets as Bucket[]).map((b) => [b.key, b]));

  const team = ctx.user.teamMemberships[0]?.team ?? null;
  const overtimeAlertMinutes = team?.config?.overtimeAlertMinutes ?? 15;

  const days = [];
  for (let t = to.getTime(); t >= from.getTime(); t -= DAY_MS) {
    const key = iso(new Date(t));
    const s = sessionByDay.get(key) ?? null;
    const bucket = bucketByDay.get(key);
    const holiday = holidayByDay.get(key) ?? null;
    const expected = (bucket?.daysExpected ?? 0) > 0;
    const onLeave = (bucket?.daysOnLeave ?? 0) > 0;

    days.push({
      date: key,
      isFuture: t > today.getTime(),
      expected,
      onLeave,
      holiday: holiday ? { name: holiday.name, dayType: String(holiday.dayType) } : null,
      session: s
        ? {
            id: s.id,
            status: s.status,
            loginAt: s.loginAt,
            logoutAt: s.logoutAt,
            autoClosed: s.autoClosed,
            productiveSeconds: s.productiveSeconds,
            breakSeconds: awayOf(s, nowDate).breakSeconds,
            washroomSeconds: awayOf(s, nowDate).washroomSeconds,
            meetingSeconds: s.meetingSeconds,
            wasLateLogin: s.wasLateLogin,
            lateByMinutes: s.lateByMinutes,
            lateRemark: remarkOf.get(s.id) ?? null,
            shiftStartTime: s.shiftStartTime,
            correction: correctedBy.get(s.id) ?? null,
            breakdown: (() => {
              const x = splitOf.get(s.id);
              if (!x) return null;
              const b = x.breakdown;
              return {
                regularSeconds: b.regularSeconds, huddleSeconds: b.huddleSeconds, otherEligibleSeconds: b.otherEligibleSeconds, totalSeconds: b.productiveSeconds,
                huddles: x.huddles.map((h, i) => ({
                  id: h.id, meetingId: h.meetingId, title: h.title, scheduledStart: h.startsAt, scheduledEnd: h.expectedEnd, joinedAt: h.joinedAt, leftAt: h.leftAt,
                  countedSeconds: b.huddles[i].countedSeconds, rawSeconds: b.huddles[i].rawSeconds, openPastEnd: b.huddles[i].openPastEnd, addedByManager: h.source === "MANAGER_ADDED",
                })),
              };
            })(),
            project: s.team ? { id: s.team.id, name: s.team.name } : null,
            breaks: s.breaks.map((b) => ({
              id: b.id,
              breakType: String(b.breakType),
              startedAt: b.startedAt,
              endedAt: b.endedAt,
              durationSeconds: b.durationSeconds,
              autoClosed: b.autoClosed,
              reason: b.reason,
            })),
            meetings: s.meetings.map((m) => ({
              id: m.id,
              meetingType: String(m.meetingType),
              title: m.title,
              startedAt: m.startedAt,
              endedAt: m.endedAt,
            })),
          }
        : null,
    });
  }

  const productiveSeconds = sessions.reduce((n, s) => n + s.productiveSeconds, 0);
  const breakSeconds = sessions.reduce((n, s) => n + awayOf(s, nowDate).breakSeconds, 0);
  const washroomSeconds = sessions.reduce((n, s) => n + awayOf(s, nowDate).washroomSeconds, 0);
  const meetingSeconds = sessions.reduce((n, s) => n + s.meetingSeconds, 0);
  const huddleSecondsTotal = [...splitOf.values()].reduce((n, x) => n + x.breakdown.huddleSeconds, 0);
  const otherEligibleTotal = [...splitOf.values()].reduce((n, x) => n + x.breakdown.otherEligibleSeconds, 0);

  const shift = ctx.shift;
  return {
    range: { from: iso(from), to: iso(to) },
    today: iso(today),
    timezone: ctx.timezone,
    schedule: {
      shift: shift
        ? { name: shift.name, startTime: shift.startTime, endTime: shift.endTime, workingDays: shift.workingDays, spansMidnight: shift.spansMidnight }
        : null,
      dailyWorkHours: ctx.config.dailyWorkHours,
      productiveHours: ctx.config.productiveHours,
      breakBudgetMinutes: ctx.config.breakBudgetMinutes,
      lateLoginGraceMinutes: ctx.config.lateLoginGraceMinutes,
      overtimeAlertMinutes,
    },
    totals: {
      expectedDays: report.totals.daysExpected,
      onLeaveDays: report.totals.daysOnLeave,
      // The planned (target) time for the period, as the Reports page defines it:
      // productive hours for each scheduled working day.
      plannedSeconds: plannedSecondsOf(report.people as { userId: string; targetSeconds: number }[], userId),
      daysWorked: sessions.length,
      productiveSeconds,
      breakSeconds,
      washroomSeconds,
      meetingSeconds,
      huddleSeconds: huddleSecondsTotal,
      otherEligibleSeconds: otherEligibleTotal,
      regularSeconds: Math.max(0, productiveSeconds - huddleSecondsTotal - otherEligibleTotal),
      // Productive + counted break + washroom: the whole time on site. Away time is never added to
      // productive time, and meetings sit inside productive time.
      elapsedSeconds: productiveSeconds + breakSeconds + washroomSeconds,
      lateDays: sessions.filter((s) => s.wasLateLogin).length,
    },
    days,
  };
}
