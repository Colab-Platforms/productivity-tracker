import { prisma } from "../../lib/prisma.js";
import { accessFor, scopeWhere } from "../../lib/companyAccess.js";
import { platformToday } from "../../lib/dates.js";
import { getAttendanceCalendar } from "../team-attendance/attendanceCalendar.service.js";
import { overview as leaveOverview } from "../leave/leave.service.js";
import { listLogs } from "../audit/audit.service.js";
import { entryReady } from "../tasks/tasks.entry.js";
import { needsManualMapping } from "../admin/hierarchy.logic.js";

// ---------------------------------------------------------------------------
// ADMIN CONSOLE OVERVIEW (read-only). One answer for the Admin dashboard: people and distribution, attendance and leave, productivity and
// tasks, recent activity. Nothing is stored or recomputed here: attendance comes from the same calendar engine the Calendar page uses, leave from
// the same overview the Leave page uses, activity from the audit log, productive time from the stored work-session columns.
// Only an ADMIN may ask, and only for the companies they act on (company access).
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function overview(adminId: string) {
  const me = await prisma.user.findUnique({ where: { id: adminId }, select: { id: true, role: true, platform: { select: { timezone: true } } } });
  if (!me || String(me.role) !== "ADMIN") throw new Error("NOT_ALLOWED");
  const access = await accessFor(adminId);
  const scope = scopeWhere(access);
  const today = platformToday(me.platform.timezone);
  const from = new Date(today.getTime() - 6 * DAY_MS);
  const soon = new Date(today.getTime() + 13 * DAY_MS);

  const [people, teamCount, companies, calendar, leave, awayRows, sessions, tasks, activity] = await Promise.all([
    prisma.user.findMany({
      where: { ...scope, status: { in: ["ACTIVE", "INVITED"] } },
      select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true, status: true, platformId: true, platform: { select: { name: true } }, reportsTo: { select: { id: true, role: true, status: true } } },
    }),
    prisma.team.count({ where: { ...scope, isActive: true } }),
    prisma.platform.findMany({ where: access.all ? {} : { id: { in: access.ids } }, select: { id: true, name: true } }),
    getAttendanceCalendar(adminId, { from: iso(from), to: iso(today) }),
    leaveOverview(adminId),
    prisma.leaveDay.groupBy({ by: ["date"], where: { ...scope, date: { gte: today, lte: soon }, user: { status: { not: "EXITED" } } }, _count: { _all: true } }),
    prisma.workSession.findMany({ where: { ...scope, date: { gte: from, lte: today } }, select: { userId: true, date: true, productiveSeconds: true } }),
    prisma.dailyTask.findMany({ where: { ...scope, date: { gte: from, lte: today }, status: { not: "CANCELLED" } }, select: { id: true, date: true, status: true, approvalStatus: true, outcome: true } }),
    listLogs(adminId, { pageSize: 25 }).then((r) => r.items.slice(0, 8)).catch(() => []),
  ]);

  // ---- people and distribution
  const byRole = { ADMIN: 0, HR: 0, MANAGER: 0, EMPLOYEE: 0 } as Record<string, number>;
  for (const p of people) byRole[String(p.role)] = (byRole[String(p.role)] ?? 0) + 1;
  const byCompany = companies.map((c) => ({ id: c.id, name: c.name, people: people.filter((p) => p.platformId === c.id).length })).sort((a, b) => b.people - a.people);
  const managers = people
    .filter((p) => String(p.role) === "MANAGER")
    .map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}`.trim(), employeeCode: m.employeeCode, employees: people.filter((p) => String(p.role) === "EMPLOYEE" && p.reportsTo?.id === m.id).length }))
    .sort((a, b) => b.employees - a.employees);
  const unmapped = people.filter((p) => needsManualMapping({ role: String(p.role), status: String(p.status) }, p.reportsTo ? { role: String(p.reportsTo.role), status: String(p.reportsTo.status) } : null)).length;

  // ---- attendance: today's counts and the last 7 days (the calendar's own classification)
  const todayIso = iso(today);
  const days: string[] = [];
  for (let d = new Date(from); d.getTime() <= today.getTime(); d = new Date(d.getTime() + DAY_MS)) days.push(iso(d));
  const rows = (calendar.rows ?? []) as { date: string; status: string }[];
  const trend = days.map((date) => {
    const c: Record<string, number> = {};
    for (const r of rows) if (r.date === date) c[r.status] = (c[r.status] ?? 0) + 1;
    return { date, counts: c };
  });
  const todayCounts = (trend.find((t) => t.date === todayIso)?.counts ?? {}) as Record<string, number>;

  // ---- productive time: the stored session totals, average per person who worked that day
  const prod = days.map((date) => {
    const day = sessions.filter((s) => iso(s.date) === date);
    const who = new Set(day.map((s) => s.userId));
    const seconds = day.reduce((n, s) => n + s.productiveSeconds, 0);
    return { date, people: who.size, avgHours: who.size ? Math.round((seconds / who.size / 3600) * 10) / 10 : 0 };
  });

  // ---- tasks: counts of task entries and the hours people recorded on them
  const ids = tasks.map((t) => t.id);
  let hours = 0;
  if (ids.length && (await entryReady())) {
    const d = await prisma.taskEntryDetail.aggregate({ where: { taskId: { in: ids } }, _sum: { hoursSpent: true } });
    hours = Math.round((d._sum.hoursSpent ?? 0) * 10) / 10;
  }
  const todayTasks = tasks.filter((t) => iso(t.date) === todayIso);
  const taskCounts = (list: typeof tasks) => ({
    planned: list.filter((t) => String(t.approvalStatus) !== "REJECTED").length,
    approved: list.filter((t) => String(t.approvalStatus) === "APPROVED").length,
    pendingApproval: list.filter((t) => String(t.approvalStatus) === "PENDING").length,
    completed: list.filter((t) => String(t.approvalStatus) === "APPROVED" && String(t.status) === "COMPLETED").length,
  });

  return {
    today: todayIso,
    timezone: me.platform.timezone,
    people: { total: people.length, byRole, byCompany, projects: teamCount, companies: companies.length, managers, unmappedCount: unmapped },
    attendance: { today: todayCounts, trend, peopleTracked: (calendar.people ?? []).length },
    leave: {
      awaitingHr: leave.awaitingHr ?? 0,
      awaitingFirstLevel: leave.awaitingFirstLevel ?? 0,
      awaitingMyApproval: leave.awaitingMyLeaveApproval ?? 0,
      onLeaveNext14Days: awayRows.map((r) => ({ date: iso(r.date), people: r._count._all })),
    },
    productivity: { trend: prod, todayAvgHours: prod.find((p) => p.date === todayIso)?.avgHours ?? 0 },
    tasks: { today: taskCounts(todayTasks), week: { ...taskCounts(tasks), hoursSpent: hours } },
    activity,
  };
}
