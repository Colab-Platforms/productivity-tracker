// AUTOMATIC TASK TIMER (database side). The work sessions are written by triggers on daily_tasks / task_entry_details (migration 20261124120000_task_work_timer),
// so the timer follows the task's STATUS whichever route changed it. This file READS them, takes the person's break and clock-out time out (attendance and break
// records are only read, never changed) and returns the figures every screen shows. The rules are pure and tested in tasks.timer.logic.ts.
//
// Before the migration the table does not exist: nothing is timed, every task reads "Not tracked" and the rest of the app is unaffected.
import { prisma } from "../../lib/prisma.js";
import { breakRowSeconds, classOfRow } from "../tracker/activityClass.js";
import { computeTimer, unionSeconds, type Interval } from "./tasks.timer.logic.js";

let ready: boolean | null = null;
let checkedAt = 0;
let checking: Promise<boolean> | null = null;
export async function timerReady(): Promise<boolean> {
  if (ready === true) return true;
  if (checking) return checking; // share an in-flight check (a second caller is never told "not ready" while the first is still looking)
  if (ready === false && Date.now() - checkedAt < 15_000) return false;
  checking = (async () => {
    try {
      const r = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from pg_class where relname = 'task_work_sessions' and relkind = 'r'`;
      ready = (r[0]?.n ?? 0) === 1;
    } catch { ready = false; }
    checkedAt = Date.now();
    return ready;
  })().finally(() => { checking = null; });
  return checking;
}

export type TaskTimer = {
  /** false = no work session exists for this task: "Not tracked" (older tasks and tasks never started; nothing is invented) */
  tracked: boolean;
  /** the clock is really running right now */
  running: boolean;
  /** an open session that is NOT accumulating, and why */
  pausedReason: "BREAK" | "CLOCKED_OUT" | null;
  firstStartedAt: string | null;
  lastSubmittedAt: string | null;
  activeSeconds: number;
  elapsedSeconds: number;
  pausedSeconds: number;
  sessionCount: number;
  /** the server's clock when this was worked out, so a screen can tick from a trustworthy base */
  serverNow: string;
};

export const notTracked = (now = new Date()): TaskTimer => ({ tracked: false, running: false, pausedReason: null, firstStartedAt: null, lastSubmittedAt: null, activeSeconds: 0, elapsedSeconds: 0, pausedSeconds: 0, sessionCount: 0, serverNow: now.toISOString() });

type Row = { id: string; userId: string; status: unknown; completedAt?: Date | null };

async function compute(rows: Row[], now: Date): Promise<{ byTask: Map<string, TaskTimer>; intervals: Map<string, Interval[]> }> {
  const byTask = new Map<string, TaskTimer>();
  const intervals = new Map<string, Interval[]>();
  if (rows.length === 0 || !(await timerReady())) return { byTask, intervals };
  const ids = [...new Set(rows.map((r) => r.id))];
  let sess: { taskId: string; startedAt: Date; endedAt: Date | null }[] = [];
  try {
    sess = await prisma.$queryRaw<{ taskId: string; startedAt: Date; endedAt: Date | null }[]>`select "taskId", "startedAt", "endedAt" from task_work_sessions where "taskId" = ANY(${ids}::uuid[]) order by "startedAt"`;
  } catch { ready = false; checkedAt = Date.now(); return { byTask, intervals }; } // the table vanished (a rolled-back migration): nothing is timed
  const sessionsOf = new Map<string, { startedAt: number; endedAt: number | null }[]>();
  for (const s of sess) sessionsOf.set(s.taskId, [...(sessionsOf.get(s.taskId) ?? []), { startedAt: s.startedAt.getTime(), endedAt: s.endedAt ? s.endedAt.getTime() : null }]);

  // the people who have sessions: when they were clocked in, and their break rows
  const users = [...new Set(rows.filter((r) => sessionsOf.has(r.id)).map((r) => r.userId))];
  const clockedIn = new Map<string, Interval[]>();
  const away = new Map<string, Interval[]>();
  if (users.length > 0) {
    const first = Math.min(...sess.map((s) => s.startedAt.getTime())) - 36 * 3600_000;
    const works = await prisma.workSession.findMany({
      where: { userId: { in: users }, loginAt: { lte: now }, OR: [{ logoutAt: null }, { logoutAt: { gte: new Date(first) } }] },
      select: { userId: true, loginAt: true, logoutAt: true, breaks: { select: { breakType: true, reason: true, startedAt: true, endedAt: true, correctedDurationSeconds: true } } },
    });
    for (const w of works) {
      clockedIn.set(w.userId, [...(clockedIn.get(w.userId) ?? []), [w.loginAt.getTime(), (w.logoutAt ?? now).getTime()]]);
      for (const b of w.breaks) {
        if (classOfRow(b) === "PRODUCTIVE") continue; // a discussion is productive time, not time away
        const start = b.startedAt.getTime();
        const end = b.endedAt ? start + breakRowSeconds(b, now) * 1000 : now.getTime();
        away.set(w.userId, [...(away.get(w.userId) ?? []), [start, end]]);
      }
    }
  }

  for (const r of rows) {
    const f = computeTimer({
      sessions: sessionsOf.get(r.id) ?? [],
      clockedIn: clockedIn.get(r.userId) ?? [],
      away: away.get(r.userId) ?? [],
      now: now.getTime(),
      completedAt: r.completedAt ? r.completedAt.getTime() : null,
      status: String(r.status),
    });
    intervals.set(r.id, f.intervals);
    byTask.set(r.id, {
      tracked: f.tracked, running: f.running, pausedReason: f.pausedReason,
      firstStartedAt: f.firstStartedAt === null ? null : new Date(f.firstStartedAt).toISOString(),
      lastSubmittedAt: f.lastSubmittedAt === null ? null : new Date(f.lastSubmittedAt).toISOString(),
      activeSeconds: f.activeSeconds, elapsedSeconds: f.elapsedSeconds, pausedSeconds: f.pausedSeconds, sessionCount: f.sessionCount, serverNow: now.toISOString(),
    });
  }
  return { byTask, intervals };
}

/** The timer of each task (a task with no session is "Not tracked"). */
export async function timersFor(rows: Row[], now = new Date()): Promise<Map<string, TaskTimer>> {
  return (await compute(rows, now)).byTask;
}

/** Rows with their timer attached under `timer` (older rows and a missing table read as Not tracked). */
export async function attachTimers<T extends Row>(rows: T[], now = new Date()): Promise<(T & { timer: TaskTimer })[]> {
  const m = await timersFor(rows, now);
  return rows.map((r) => ({ ...r, timer: m.get(r.id) ?? notTracked(now) }));
}

/** Each person's total tracked working time over a set of tasks: tasks that overlap in time are counted ONCE. Keyed by user id. */
export async function trackedSecondsByUser(rows: Row[], now = new Date()): Promise<Map<string, { seconds: number; tasks: number }>> {
  const { byTask, intervals } = await compute(rows, now);
  const perUser = new Map<string, Interval[][]>();
  const tracked = new Map<string, number>();
  for (const r of rows) {
    if (!byTask.get(r.id)?.tracked) continue;
    perUser.set(r.userId, [...(perUser.get(r.userId) ?? []), intervals.get(r.id) ?? []]);
    tracked.set(r.userId, (tracked.get(r.userId) ?? 0) + 1);
  }
  return new Map([...perUser].map(([u, list]) => [u, { seconds: unionSeconds(list), tasks: tracked.get(u) ?? 0 }]));
}
