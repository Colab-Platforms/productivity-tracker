import { prisma } from "../../lib/prisma.js";
import { accessFor, scopeWhere } from "../../lib/companyAccess.js";
import { parseIsoDay, platformToday } from "../../lib/dates.js";
import { getMonthAttendanceBulk } from "../attendance/attendance.service.js";
import { visibleUserIds } from "../tracker/tracker.service.js";
import { remarksBySession } from "../tracker/lateRemarks.js";
import { ARRIVAL_RULES, calendarStatus, minutesAfterLimit } from "./arrival.logic.js";

// ---------------------------------------------------------------------------
// ATTENDANCE CALENDAR (read-only, no schema change)
// One row per person per day, built on the existing month engine (the same one Reports and payroll read), so working time, break time and
// the original clock-in/clock-out stamps are exactly the stored values. Only the STATUS shown is the arrival-time classification.
// Who may be seen: an employee only themselves; a manager their reporting people (and themselves); HR/Admin the companies they act on.
// ---------------------------------------------------------------------------

const MAX_RANGE_DAYS = 93;

async function peopleFor(viewerId: string) {
  const access = await accessFor(viewerId);
  const role = String(access.role);
  let where: Record<string, unknown>;
  if (role === "HR" || role === "ADMIN") {
    where = { ...scopeWhere(access), status: { in: ["ACTIVE", "INVITED"] } };
  } else if (role === "MANAGER") {
    const ids = await visibleUserIds({ id: viewerId, role, platformId: access.ownPlatformId });
    where = { id: { in: [...new Set([...ids, viewerId])] }, platformId: access.ownPlatformId, status: { in: ["ACTIVE", "INVITED"] } };
  } else {
    where = { id: viewerId };
  }
  return prisma.user.findMany({
    where,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      designation: true,
      platformId: true,
      platform: { select: { name: true, timezone: true } },
      teamMemberships: { where: { isActive: true }, orderBy: [{ isPrimary: "desc" }, { joinedAt: "asc" }], take: 1, select: { team: { select: { id: true, name: true } } } },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
}

export async function getAttendanceCalendar(viewerId: string, q: { from?: string; to?: string; userId?: string; teamId?: string }) {
  const people = await peopleFor(viewerId);
  const own = people.find((p) => p.id === viewerId) ?? (await prisma.user.findUnique({ where: { id: viewerId }, select: { platform: { select: { timezone: true } } } }).then((u) => (u ? { platform: u.platform } : null)));
  const viewerTz = own?.platform.timezone ?? "Asia/Kolkata";
  const today = platformToday(viewerTz);
  const todayIso = today.toISOString().slice(0, 10);
  // Default window: the current month in the viewer's company timezone.
  const firstOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const lastOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const from = q.from ? parseIsoDay(q.from) : firstOfMonth;
  const to = q.to ? parseIsoDay(q.to) : q.from ? from : lastOfMonth;
  if (to.getTime() < from.getTime()) throw new Error("BAD_RANGE");
  if ((to.getTime() - from.getTime()) / 86_400_000 + 1 > MAX_RANGE_DAYS) throw new Error("RANGE_TOO_LONG");
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);

  const meta = people.map((p) => ({
    id: p.id,
    name: `${p.firstName} ${p.lastName}`.trim(),
    code: p.employeeCode,
    designation: p.designation,
    company: p.platform.name,
    timezone: p.platform.timezone,
    teamId: p.teamMemberships[0]?.team.id ?? null,
    teamName: p.teamMemberships[0]?.team.name ?? null,
  }));
  const options = {
    people: meta.map((m) => ({ id: m.id, name: m.name, code: m.code })),
    teams: Array.from(new Map(meta.filter((m) => m.teamId).map((m) => [m.teamId as string, m.teamName as string])).entries()).map(([id, name]) => ({ id, name })),
  };
  // Filters only narrow what the viewer may already see.
  const chosen = meta.filter((m) => (!q.userId || m.id === q.userId) && (!q.teamId || m.teamId === q.teamId));
  const base = { timezone: viewerTz, today: todayIso, from: fromIso, to: toIso, rules: ARRIVAL_RULES, options };
  if (chosen.length === 0) return { ...base, people: [] as typeof chosen, rows: [] as unknown[], counts: emptyCounts() };

  // Every month the window touches, batched (one call per month, never one per person).
  const months: [number, number][] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth() + 1;
  while (y < to.getUTCFullYear() || (y === to.getUTCFullYear() && m <= to.getUTCMonth() + 1)) {
    months.push([y, m]);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  const ids = chosen.map((c) => c.id);
  const monthly = (await Promise.all(months.map(([yy, mm]) => getMonthAttendanceBulk(ids, yy, mm)))).flat();
  const byId = new Map(chosen.map((c) => [c.id, c]));

  // Everything that explains a day, read in a few batched queries (never one per person). Each optional source degrades to "nothing" when its
  // table is not available, so the calendar always loads.
  const [sessions, leaveDays, taskGroups] = await Promise.all([
    prisma.workSession.findMany({ where: { userId: { in: ids }, date: { gte: from, lte: to } }, select: { id: true, userId: true, date: true, autoClosed: true } }),
    prisma.leaveDay
      .findMany({
        where: { userId: { in: ids }, date: { gte: from, lte: to } },
        select: { userId: true, date: true, isHalfDay: true, isFirstHalf: true, leaveRequest: { select: { reason: true } } },
      })
      .catch(() => [] as { userId: string; date: Date; isHalfDay: boolean; isFirstHalf: boolean; leaveRequest: { reason: string } | null }[]),
    prisma.dailyTask
      .groupBy({
        by: ["userId", "date", "status", "approvalStatus"],
        where: { userId: { in: ids }, date: { gte: from, lte: to }, status: { not: "CANCELLED" } },
        _count: { _all: true },
      })
      .catch(() => [] as { userId: string; date: Date; status: string; approvalStatus: string; _count: { _all: number } }[]),
  ]);
  const sessionOf = new Map(sessions.map((s) => [`${s.userId}|${s.date.toISOString().slice(0, 10)}`, s]));
  const lateReason = await remarksBySession(sessions.map((s) => s.id));
  const correctedBy = new Map<string, string>(); // session id -> who corrected it
  if (sessions.length) {
    const audits = await prisma.attendanceCorrectionAudit
      .findMany({
        where: { workSessionId: { in: sessions.map((s) => s.id) }, action: "APPLIED" },
        orderBy: { createdAt: "desc" },
        select: { workSessionId: true, actedBy: { select: { firstName: true, lastName: true } } },
      })
      .catch(() => [] as { workSessionId: string | null; actedBy: { firstName: string; lastName: string } }[]);
    for (const a of audits) if (a.workSessionId && !correctedBy.has(a.workSessionId)) correctedBy.set(a.workSessionId, `${a.actedBy.firstName} ${a.actedBy.lastName}`.trim());
  }
  const leaveOf = new Map(leaveDays.map((l) => [`${l.userId}|${l.date.toISOString().slice(0, 10)}`, l]));
  const tasksOf = new Map<string, { planned: number; completed: number }>();
  for (const t of taskGroups) {
    const k = `${t.userId}|${t.date.toISOString().slice(0, 10)}`;
    const cur = tasksOf.get(k) ?? { planned: 0, completed: 0 };
    const approval = String(t.approvalStatus);
    if (approval === "APPROVED" || approval === "PENDING") cur.planned += t._count._all; // rejected proposals were never planned
    if (approval === "APPROVED" && String(t.status) === "COMPLETED") cur.completed += t._count._all;
    tasksOf.set(k, cur);
  }

  const rows: Array<Record<string, unknown>> = [];
  const counts = emptyCounts();
  for (const month of monthly) {
    const who = byId.get(month.userId);
    if (!who) continue;
    for (const d of month.days) {
      if (d.date < fromIso || d.date > toIso) continue;
      const loginAt = d.loginAt ? new Date(d.loginAt) : null;
      const status = calendarStatus({ engineStatus: d.status, loginAt, isToday: d.date === todayIso, timezone: who.timezone });
      if (!status) continue;
      counts[status] = (counts[status] ?? 0) + 1;
      const key = `${month.userId}|${d.date}`;
      const session = sessionOf.get(key);
      const lateText = session ? lateReason.get(session.id) ?? null : null;
      const fixedBy = session ? correctedBy.get(session.id) ?? null : null;
      const leave = leaveOf.get(key);
      const task = tasksOf.get(key);
      const lateBy = loginAt ? minutesAfterLimit(loginAt, who.timezone) : 0;
      const running = !!loginAt && !d.logoutAt && d.date === todayIso;
      // One plain line built only from what was recorded; the structured fields below carry the same facts.
      const remarkParts: string[] = [];
      if (running) remarkParts.push("Still working");
      if (session?.autoClosed) remarkParts.push("Auto clocked out");
      if (status === "LEAVE") remarkParts.push(`${d.leaveType ? `${d.leaveType.toLowerCase()} leave` : "On leave"}${leave?.isHalfDay ? " (half day)" : ""}`);
      if (status === "HOLIDAY" && d.holidayName) remarkParts.push(d.holidayName);
      if (lateBy > 0) remarkParts.push(`Arrived ${lateBy} min after ${ARRIVAL_RULES.presentUntil}`);
      if (lateText) remarkParts.push(`Reason: ${lateText}`);
      if (fixedBy) remarkParts.push(`Corrected by ${fixedBy}`);
      if (task && task.completed > 0) remarkParts.push(`${task.completed} task${task.completed === 1 ? "" : "s"} done`);
      rows.push({
        userId: month.userId,
        date: d.date,
        status,
        // The original stamps, untouched. The page formats them in the company timezone.
        firstCheckIn: d.loginAt,
        lastCheckOut: d.logoutAt,
        lateByMinutes: loginAt ? minutesAfterLimit(loginAt, who.timezone) : null,
        workedSeconds: loginAt ? Math.round(d.workedHours * 3600) : null,
        breakSeconds: loginAt ? Math.round(d.breakHours * 3600) : null,
        stillWorking: !!loginAt && !d.logoutAt && d.date === todayIso,
        // What payroll/Reports call this same day (hours-based), shown for transparency; it is not changed by the calendar.
        payrollStatus: d.label,
        leaveType: d.leaveType,
        holidayName: d.holidayName,
        note: d.note,
        // What explains the day
        lateRemark: lateText,
        correctedBy: fixedBy,
        autoClosed: !!session?.autoClosed,
        leaveHalfDay: leave?.isHalfDay ? (leave.isFirstHalf ? "first half" : "second half") : null,
        leaveReason: leave?.leaveRequest?.reason ?? null,
        tasksPlanned: task ? task.planned : null,
        tasksCompleted: task ? task.completed : null,
        remarks: remarkParts.join(" · "),
      });
    }
  }
  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { ...base, people: chosen, rows, counts };
}

function emptyCounts(): Record<string, number> {
  return { PRESENT: 0, LATE: 0, HALF_DAY: 0, ABSENT: 0, LEAVE: 0, HOLIDAY: 0, WEEK_OFF: 0, NOT_TRACKED: 0, NOT_CLOCKED_IN: 0 };
}
