import { prisma } from "../../lib/prisma.js";
import { isOverdue } from "./tasks.self.logic.js";
import { localDayOf, parseIsoDay } from "../../lib/dates.js";
import { taskWorkSeconds } from "../tracker/productiveBreakdown.js";
import { activeTasks } from "./tasks.deleted.js";

// ---------------------------------------------------------------------------
// MANAGER SELF-MANAGED TASKS (database side)
// A manager's OWN tasks need no approval: they are approved when created, never reach anyone's review queue, never
// notify anyone, and carry a start time, a deadline, work updates and a history. A row in task_self_details marks one.
// Safe before the migration: if the tables are not there, nothing is self-managed and every task behaves as it always did.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/task_(self_details|events)/.test(msg) && /does not exist|relation/.test(msg));
};

let readyValue = false;
let readyCheckedAt = 0;
export async function selfTasksReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await Promise.all([prisma.taskSelfDetail.findFirst({ select: { taskId: true } }), prisma.taskEvent.findFirst({ select: { id: true } })]);
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

export type SelfDetail = { taskId: string; startedAt: Date | null; dueDate: Date | null };

/** task id -> details, for the tasks that ARE self-managed. Empty before the migration. */
export async function detailsFor(taskIds: string[]): Promise<Map<string, SelfDetail>> {
  const out = new Map<string, SelfDetail>();
  if (taskIds.length === 0 || !(await selfTasksReady())) return out;
  const rows = await prisma.taskSelfDetail.findMany({ where: { taskId: { in: taskIds } }, select: { taskId: true, startedAt: true, dueDate: true } });
  for (const r of rows) out.set(r.taskId, r);
  return out;
}

/** All self-managed task ids among these (used to keep them out of review queues and team figures). */
export async function selfManagedIds(taskIds: string[]): Promise<Set<string>> {
  return new Set((await detailsFor(taskIds)).keys());
}

export async function recordEvent(o: { taskId: string; platformId: string; actorId: string; kind: "CREATED" | "STARTED" | "COMPLETED" | "REOPENED" | "EDITED" | "UPDATE"; note?: string | null }) {
  try {
    await prisma.taskEvent.create({ data: { taskId: o.taskId, platformId: o.platformId, actorId: o.actorId, kind: o.kind, note: o.note ?? null } });
  } catch (e) {
    if (!isMissingTable(e)) console.error("[tasks] history write failed:", e instanceof Error ? e.message : e);
  }
}

/** The extra fields the Daily Tasks screen needs for a self-managed task. */
export function shapeSelf(d: SelfDetail | undefined, status: string, now: Date, tz: string) {
  if (!d) return { selfManaged: false as const };
  return {
    selfManaged: true as const,
    startedAt: d.startedAt,
    dueDate: d.dueDate ? d.dueDate.toISOString().slice(0, 10) : null,
    overdue: isOverdue({ dueDate: d.dueDate, status }, now, tz),
  };
}

export async function historyOf(taskId: string) {
  if (!(await selfTasksReady())) return [];
  const rows = await prisma.taskEvent.findMany({ where: { taskId }, orderBy: { createdAt: "asc" }, select: { id: true, kind: true, note: true, createdAt: true, actorId: true } });
  return rows;
}

/** Ids of the self-managed tasks owned by these people. Used to keep a manager's own tasks out of TEAM figures. Empty before the migration. */
export async function selfManagedTaskIdsOf(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0 || !(await selfTasksReady())) return [];
  return (await prisma.taskSelfDetail.findMany({ where: { userId: { in: userIds } }, select: { taskId: true } })).map((r) => r.taskId);
}

const weekStart = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  return new Date(d.getTime() - (dow - 1) * 86_400_000).toISOString().slice(0, 10);
};

/**
 * A manager's OWN task picture for a period (Not started / In progress / Completed / Overdue, completion per day and per week, and
 * the actual time spent where start and completion are both recorded). Only self-managed tasks, only his own. It does not touch
 * team figures, and "time spent" is a label on each task, never added to productive time.
 */
export async function summary(userId: string, fromIso: string, toIso: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, platform: { select: { timezone: true } } } });
  if (!user) throw new Error("USER_NOT_FOUND");
  if (String(user.role) !== "MANAGER") throw new Error("NOT_ALLOWED");
  const tz = user.platform.timezone;
  const from = parseIsoDay(fromIso);
  const to = parseIsoDay(toIso);
  if (to.getTime() < from.getTime()) throw new Error("BAD_RANGE");
  if ((to.getTime() - from.getTime()) / 86_400_000 + 1 > 93) throw new Error("RANGE_TOO_LONG");

  const empty = { ready: false, from: fromIso, to: toIso, totals: { total: 0, notStarted: 0, inProgress: 0, completed: 0, overdue: 0, completionRate: null as number | null }, daily: [] as { date: string; completed: number }[], weekly: [] as { weekStart: string; completed: number }[], timeSpent: { seconds: 0, timedTasks: 0, untimedTasks: 0 }, open: [] as unknown[] };
  if (!(await selfTasksReady())) return empty;

  const rows = await prisma.dailyTask.findMany({
    where: { userId, date: { gte: from, lte: to }, status: { not: "CANCELLED" }, ...(await activeTasks()) },
    select: { id: true, title: true, date: true, status: true, weight: true, completedAt: true },
    orderBy: { date: "asc" },
  });
  const details = await detailsFor(rows.map((r) => r.id));
  const mine = rows.filter((r) => details.has(r.id));
  const now = new Date();

  const completed = mine.filter((r) => String(r.status) === "COMPLETED");
  const overdueRows = mine.filter((r) => isOverdue({ dueDate: details.get(r.id)!.dueDate, status: String(r.status) }, now, tz));

  const daily = new Map<string, number>();
  for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) daily.set(new Date(t).toISOString().slice(0, 10), 0);
  const weekly = new Map<string, number>();
  for (const r of completed) {
    if (!r.completedAt) continue;
    const day = localDayOf(r.completedAt, tz);
    if (daily.has(day)) daily.set(day, (daily.get(day) ?? 0) + 1);
    const w = weekStart(day);
    weekly.set(w, (weekly.get(w) ?? 0) + 1);
  }

  // time spent: only for tasks with BOTH a start and a completion time, measured inside clock-in and outside breaks that day
  const sessions = await prisma.workSession.findMany({ where: { userId, date: { gte: new Date(from.getTime() - 86_400_000), lte: new Date(to.getTime() + 86_400_000) } }, select: { date: true, loginAt: true, logoutAt: true, breaks: { select: { startedAt: true, endedAt: true } } } });
  const sessionOn = new Map(sessions.map((s) => [s.date.toISOString().slice(0, 10), s]));
  let seconds = 0, timed = 0, untimed = 0;
  for (const r of completed) {
    const s = r.completedAt ? sessionOn.get(localDayOf(r.completedAt, tz)) : undefined;
    const secs = taskWorkSeconds({ startedAt: details.get(r.id)!.startedAt, completedAt: r.completedAt, loginAt: s?.loginAt ?? null, logoutAt: s?.logoutAt ?? null, breaks: s?.breaks ?? [], now });
    if (secs === null) untimed++;
    else { seconds += secs; timed++; }
  }

  const counted = mine.length;
  return {
    ready: true, from: fromIso, to: toIso,
    totals: {
      total: counted,
      notStarted: mine.filter((r) => String(r.status) === "PENDING").length,
      inProgress: mine.filter((r) => String(r.status) === "IN_PROGRESS").length,
      completed: completed.length,
      overdue: overdueRows.length,
      completionRate: counted > 0 ? completed.length / counted : null,
    },
    daily: [...daily.entries()].map(([date, c]) => ({ date, completed: c })),
    weekly: [...weekly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([w, c]) => ({ weekStart: w, completed: c })),
    timeSpent: { seconds, timedTasks: timed, untimedTasks: untimed },
    open: mine
      .filter((r) => String(r.status) !== "COMPLETED")
      .slice(0, 20)
      .map((r) => ({ id: r.id, title: r.title, status: String(r.status), dueDate: details.get(r.id)!.dueDate?.toISOString().slice(0, 10) ?? null, overdue: overdueRows.some((o) => o.id === r.id) })),
  };
}
