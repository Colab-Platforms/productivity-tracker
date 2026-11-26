import { prisma } from "../../lib/prisma.js";
import { notifyUsers } from "../../lib/notify.js";
import { platformToday } from "../../lib/dates.js";
import { managersOf } from "../tasks/tasks.notify.js";

// ---------------------------------------------------------------------------
// ATTENDANCE / BREAK / REMINDER NOTIFICATIONS (uses the one existing inbox, lib/notify.ts; no new table)
//
// Who hears what:
//   clock-in, clock-out, break started, break ended   -> the person themselves (a record + a confirmation)
//   late arrival, not clocked in, Break Time exceeded -> the person AND their reporting managers (problems only, never every normal break)
//   missing clock-out reminder                        -> the person
//   meeting starting soon                             -> the organizer and the invitees who did not decline
//   assigned task due soon / overdue, open tasks past their day -> the person; managers get ONE daily roll-up per employee
// Every notification carries a dedupeKey, so a double click, a retry or the scheduler running twice never repeats it.
// Nothing here can break the action that caused it: everything is caught and logged.
// ---------------------------------------------------------------------------

const clock = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).format(d);

async function whoIs(userId: string) {
  return prisma.user.findUnique({ where: { id: userId }, select: { id: true, firstName: true, lastName: true, platformId: true, platform: { select: { timezone: true } } } });
}

export type SelfEvent = "CLOCK_IN" | "CLOCK_OUT" | "BREAK_STARTED" | "BREAK_ENDED";
const SELF_TEXT: Record<SelfEvent, { type: string; title: string; link: string }> = {
  CLOCK_IN: { type: "ATTENDANCE_CLOCK_IN", title: "Clocked in", link: "/dashboard/today" },
  CLOCK_OUT: { type: "ATTENDANCE_CLOCK_OUT", title: "Clocked out", link: "/dashboard/history" },
  BREAK_STARTED: { type: "BREAK_STARTED", title: "Break started", link: "/dashboard/today" },
  BREAK_ENDED: { type: "BREAK_ENDED", title: "Break ended", link: "/dashboard/today" },
};

/** A confirmation for the person's own action. The key is bucketed to 10 seconds so a double click makes one. */
export async function selfNotice(event: SelfEvent, userId: string, detail?: string): Promise<void> {
  try {
    const u = await whoIs(userId);
    if (!u) return;
    const t = SELF_TEXT[event];
    const tz = u.platform?.timezone ?? "Asia/Kolkata";
    const at = clock(new Date(), tz);
    await notifyUsers({
      platformId: u.platformId,
      userIds: [userId],
      type: t.type,
      title: t.title,
      body: `${detail ? `${detail} · ` : ""}${at}`,
      link: t.link,
      dedupeKey: `${event}:${userId}:${Math.floor(Date.now() / 10_000)}`,
      data: { category: "ATTENDANCE" },
    });
  } catch (e) {
    console.error("[notify] self notice failed:", e);
  }
}

export type ProblemKind = "LATE_LOGIN" | "NO_LOGIN" | "BREAK_OVERAGE";
const PROBLEM: Record<ProblemKind, { type: string; title: (n: string) => string; mine: string; link: string }> = {
  LATE_LOGIN: { type: "ATTENDANCE_LATE", title: (n) => `${n} arrived late`, mine: "Late arrival noted", link: "/dashboard/team-attendance" },
  NO_LOGIN: { type: "ATTENDANCE_NOT_CLOCKED_IN", title: (n) => `${n} has not clocked in`, mine: "You have not clocked in", link: "/dashboard/team-attendance" },
  BREAK_OVERAGE: { type: "BREAK_EXCEEDED", title: (n) => `${n} exceeded Break Time`, mine: "Break Time exceeded", link: "/dashboard/team-attendance" },
};

/** A problem found by the scheduler: the person and their reporting managers are told once per day per kind. */
export async function problemNotice(kind: ProblemKind, userId: string, dateIso: string, message: string): Promise<void> {
  try {
    const u = await whoIs(userId);
    if (!u) return;
    const t = PROBLEM[kind];
    const name = `${u.firstName} ${u.lastName}`.trim();
    await notifyUsers({ platformId: u.platformId, userIds: [userId], type: t.type, title: t.mine, body: message, link: kind === "BREAK_OVERAGE" || kind === "LATE_LOGIN" ? "/dashboard/history" : "/dashboard/today", dedupeKey: `${kind}:${userId}:${dateIso}`, data: { category: "ATTENDANCE", severity: kind === "BREAK_OVERAGE" ? "warning" : "warning" } });
    const managers = await managersOf(userId, null, [userId]);
    if (managers.length === 0) return;
    const people = await prisma.user.findMany({ where: { id: { in: managers } }, select: { id: true, platformId: true, role: true } });
    const byPlatform = new Map<string, string[]>();
    // HR hears about attendance through its own screens; managers and Admins responsible for the person are told.
    for (const p of people) if (String(p.role) !== "HR") byPlatform.set(p.platformId, [...(byPlatform.get(p.platformId) ?? []), p.id]);
    for (const [platformId, userIds] of byPlatform) {
      await notifyUsers({ platformId, userIds, type: t.type, title: t.title(name), body: message, link: t.link, dedupeKey: `${kind}:${userId}:${dateIso}:mgr`, data: { category: "ATTENDANCE", severity: "warning", employeeId: userId } });
    }
  } catch (e) {
    console.error("[notify] problem notice failed:", e);
  }
}

/** Sessions still open far too long: remind the person to clock out (once per session). */
export async function remindMissingClockOut(): Promise<number> {
  let sent = 0;
  const cutoff = new Date(Date.now() - 10 * 3600_000);
  const open = await prisma.workSession.findMany({ where: { logoutAt: null, loginAt: { lt: cutoff } }, select: { id: true, userId: true, platformId: true, loginAt: true, user: { select: { status: true } } }, take: 500 });
  for (const s of open) {
    if (String(s.user.status) !== "ACTIVE") continue;
    sent += await notifyUsers({ platformId: s.platformId, userIds: [s.userId], type: "ATTENDANCE_MISSING_CLOCK_OUT", title: "Don't forget to clock out", body: "You are still clocked in after more than 10 hours. Clock out if you have finished for the day.", link: "/dashboard/today", dedupeKey: `missing-out:${s.id}`, data: { category: "ATTENDANCE", severity: "warning" } });
  }
  return sent;
}

/** Meetings starting within the next 15 minutes: organizer and invitees who have not declined are told once. */
export async function remindMeetingsSoon(): Promise<number> {
  let sent = 0;
  const now = new Date();
  const soon = new Date(now.getTime() + 15 * 60_000);
  const rows = await prisma.meeting.findMany({ where: { status: "SCHEDULED", startsAt: { gt: now, lte: soon } }, select: { id: true, title: true, startsAt: true, platformId: true, organizerId: true, attendees: { select: { userId: true } }, platform: { select: { timezone: true } } }, take: 200 });
  for (const m of rows) {
    const declined = new Set((await prisma.$queryRaw<{ u: string }[]>`select "userId"::text u from meeting_responses where "meetingId" = ${m.id}::uuid and response = 'DECLINED'`.catch(() => [])).map((r) => r.u));
    const ids = [m.organizerId, ...m.attendees.map((a) => a.userId)].filter((id) => !declined.has(id));
    sent += await notifyUsers({ platformId: m.platformId, userIds: ids, type: "MEETING_STARTING_SOON", title: `Starting soon: ${m.title}`, body: `Starts at ${clock(m.startsAt, m.platform?.timezone ?? "Asia/Kolkata")}.`, link: `/dashboard/meetings?id=${m.id}`, dedupeKey: `meeting-soon:${m.id}:${m.startsAt.getTime()}`, data: { category: "MEETING", meetingId: m.id } });
  }
  return sent;
}

/** Open approved tasks from an earlier day: ONE roll-up per employee per day, and one per manager per day. */
export async function remindOverdueTasks(): Promise<number> {
  let sent = 0;
  const platforms = await prisma.platform.findMany({ where: { isActive: true }, select: { id: true, timezone: true } });
  for (const p of platforms) {
    const today = platformToday(p.timezone);
    const todayIso = today.toISOString().slice(0, 10);
    const rows = await prisma.dailyTask.groupBy({
      by: ["userId"],
      where: { platformId: p.id, date: { lt: today }, approvalStatus: "APPROVED" as never, status: { in: ["PENDING", "IN_PROGRESS"] as never }, assignedById: null, carryCount: { gte: 0 }, user: { status: "ACTIVE" } },
      _count: { _all: true },
    }).catch(() => []);
    const perManager = new Map<string, number>();
    for (const r of rows) {
      const n = r._count._all;
      sent += await notifyUsers({ platformId: p.id, userIds: [r.userId], type: "TASK_OVERDUE", title: "Tasks still open from earlier days", body: `${n} task${n === 1 ? " is" : "s are"} still open from a previous day. Update their progress or complete them.`, link: "/dashboard/tasks", dedupeKey: `overdue:${r.userId}:${todayIso}`, data: { category: "TASK", severity: "warning" } });
      for (const m of await managersOf(r.userId, null, [r.userId])) perManager.set(m, (perManager.get(m) ?? 0) + 1);
    }
    for (const [mid, people] of perManager) {
      const u = await prisma.user.findUnique({ where: { id: mid }, select: { role: true, platformId: true } });
      if (!u || String(u.role) === "HR") continue;
      sent += await notifyUsers({ platformId: u.platformId, userIds: [mid], type: "TASK_OVERDUE_TEAM", title: "Team tasks overdue", body: `${people} team member${people === 1 ? " has" : "s have"} tasks still open from earlier days.`, link: "/dashboard/tasks?tab=submitted", dedupeKey: `overdue-team:${mid}:${todayIso}`, data: { category: "TASK", severity: "warning" } });
    }
  }
  return sent;
}

/** Assigned tasks (tasks.assigned.ts): due tomorrow / today, or past their due day and still open. Once per task per kind. */
export async function remindAssignedDue(): Promise<number> {
  let sent = 0;
  const { decodeAssigned, dueOf } = await import("../tasks/tasks.assigned.logic.js");
  const open = await prisma.dailyTask.findMany({ where: { assignedById: { not: null }, status: { in: ["PENDING", "IN_PROGRESS"] as never }, user: { status: "ACTIVE" } }, select: { id: true, title: true, userId: true, assignedById: true, platformId: true, platform: { select: { timezone: true } } }, take: 1000 });
  if (open.length === 0) return 0;
  const events = await prisma.taskEvent.findMany({ where: { taskId: { in: open.map((t) => t.id) } }, orderBy: { createdAt: "asc" }, select: { taskId: true, note: true } });
  const by = new Map<string, { payload: NonNullable<ReturnType<typeof decodeAssigned>> }[]>();
  for (const e of events) { const payload = decodeAssigned(e.note); if (payload) by.set(e.taskId, [...(by.get(e.taskId) ?? []), { payload }]); }
  for (const t of open) {
    const due = dueOf(by.get(t.id) ?? []);
    if (!due) continue;
    const today = platformToday(t.platform?.timezone ?? "Asia/Kolkata");
    const todayIso = today.toISOString().slice(0, 10);
    const tomorrow = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
    const kind = due < todayIso ? "overdue" : due === todayIso ? "today" : due === tomorrow ? "tomorrow" : null;
    if (!kind) continue;
    const title = kind === "overdue" ? "Assigned task overdue" : kind === "today" ? "Assigned task due today" : "Assigned task due tomorrow";
    const link = "/dashboard/tasks?tab=assigned";
    sent += await notifyUsers({ platformId: t.platformId, userIds: [t.userId], type: kind === "overdue" ? "TASK_OVERDUE" : "TASK_DUE_SOON", title, body: `“${t.title}” is due ${due}.`, link, dedupeKey: `asg-due:${t.id}:${kind}`, data: { category: "TASK", severity: kind === "overdue" ? "urgent" : "warning", taskId: t.id } });
    if (kind === "overdue" && t.assignedById) sent += await notifyUsers({ platformId: t.platformId, userIds: [t.assignedById], type: "TASK_OVERDUE_TEAM", title: "A task you assigned is overdue", body: `“${t.title}” was due ${due} and is not finished.`, link: "/dashboard/tasks?tab=assigned", dedupeKey: `asg-due-mgr:${t.id}`, data: { category: "TASK", severity: "warning", taskId: t.id } });
  }
  return sent;
}

// ---------------------------------------------------------------------------
// LONG BREAK ALARM: a person ON a break who is 50 minutes past their daily Break Time.
// Checked every minute (the 15-minute alert job is too slow for "immediately"). The allowance is the same one the BREAK_OVERAGE alert uses
// (the person's team Break Time, else 60 minutes). ONE alert per break row (dedupe key). It never ends the break or clocks anyone out.
// Told: the employee (the screen plays an alarm for this type), their reporting managers, HR and Admin of the company.
// ---------------------------------------------------------------------------
export const LONG_BREAK_OVER_MINUTES = 50;

const mins = (s: number) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
};

async function hrAndAdminsOf(platformId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    select u.id::text from users u
    where u.role in ('HR','ADMIN') and u.status = 'ACTIVE'
      and (u."platformId" = ${platformId}::uuid
        or exists (select 1 from company_access c where c."userId" = u.id and (c."platformId" is null or c."platformId" = ${platformId}::uuid)))`;
  return rows.map((r) => r.id);
}

export async function watchLongBreaks(): Promise<number> {
  const { awayOf, isCountedBreak } = await import("./activityClass.js");
  let sent = 0;
  const now = new Date();
  // Sessions with a break running right now (a counted break: lunch, personal, other; discussions and washroom are not breaks).
  const sessions = await prisma.workSession.findMany({
    where: { logoutAt: null, breaks: { some: { endedAt: null } }, user: { status: "ACTIVE", role: { not: "ADMIN" } } },
    include: {
      breaks: true,
      platform: { select: { timezone: true, defaultBreakBudgetMins: true } },
      user: { select: { id: true, firstName: true, lastName: true, platformId: true, teamMemberships: { where: { isActive: true, team: { isActive: true } }, select: { team: { select: { config: { select: { breakBudgetMinutes: true } } } } } } } },
    },
    take: 500,
  });
  for (const s of sessions) {
    const running = s.breaks.find((b) => b.endedAt === null && isCountedBreak({ breakType: b.breakType as never, reason: b.reason }));
    if (!running) continue;
    // same allowance as the BREAK_OVERAGE alert: the team's Break Time, else the company default
    const cfg = s.user.teamMemberships[0]?.team.config;
    const allowed = (cfg?.breakBudgetMinutes ?? s.platform?.defaultBreakBudgetMins ?? 60) * 60;
    if (allowed <= 0) continue;
    const used = awayOf(s, now).breakSeconds;
    const over = used - allowed;
    if (over < LONG_BREAK_OVER_MINUTES * 60) continue;
    const u = s.user;
    const name = `${u.firstName} ${u.lastName}`.trim();
    const key = `break-over50:${running.id}`;
    const data = { category: "BREAK", severity: "urgent", alarm: true, usedSeconds: used, allowedSeconds: allowed, overSeconds: over, breakId: running.id };
    sent += await notifyUsers({
      platformId: u.platformId,
      userIds: [u.id],
      type: "BREAK_LIMIT_EXCEEDED",
      title: "Break Time exceeded: please resume work",
      body: `Your break time has exceeded the permitted limit by ${LONG_BREAK_OVER_MINUTES} minutes. Please end your break and resume work. Break so far: ${mins(used)} (allowed ${mins(allowed)}, over by ${mins(over)}).`,
      link: "/dashboard/today",
      dedupeKey: key,
      data,
    });
    // reporting managers (not HR), then HR and Admin of the company: one notice each, once per break
    const managers = (await managersOf(u.id, null, [u.id])).filter(Boolean);
    const staff = await hrAndAdminsOf(u.platformId);
    const ids = [...new Set([...managers, ...staff])].filter((x) => x !== u.id);
    if (ids.length) {
      const people = await prisma.user.findMany({ where: { id: { in: ids }, status: "ACTIVE" }, select: { id: true, platformId: true } });
      const byPlatform = new Map<string, string[]>();
      for (const p of people) byPlatform.set(p.platformId, [...(byPlatform.get(p.platformId) ?? []), p.id]);
      for (const [platformId, userIds] of byPlatform) {
        sent += await notifyUsers({ platformId, userIds, type: "BREAK_LIMIT_EXCEEDED_TEAM", title: `${name} is ${mins(over)} over Break Time`, body: `${name} is still on a break: ${mins(used)} used of ${mins(allowed)} allowed (over by ${mins(over)}).`, link: "/dashboard/team-attendance", dedupeKey: `${key}:staff`, data: { ...data, alarm: false, employeeId: u.id } });
      }
    }
  }
  return sent;
}
