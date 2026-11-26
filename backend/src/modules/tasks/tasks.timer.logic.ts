// AUTOMATIC TASK TIMER: the pure rules (no database), so they can be tested on their own. The sessions themselves are written by database triggers (migration
// 20261124120000_task_work_timer) from the task's STATUS; this file only turns sessions + the person's attendance into the figures people see.
//
//   Active working time  = the task's In-Progress sessions, counted only while the person was CLOCKED IN and NOT on a break/washroom row.
//                          (Attendance and break records are read, never changed: a break or a clock-out simply takes its minutes out of the task time.)
//   Total elapsed time   = from the first moment the task entered In Progress to its final submission (or to now while it is not submitted).
//   Paused time          = elapsed time minus active time (time outside active work sessions between the start and the end).
//   Not tracked          = the task has no session (it was already In Progress before timing existed, or it never was): nothing is invented.

export type Interval = [number, number]; // [start, end) in epoch milliseconds

/** Sort and merge overlapping or touching intervals (an overlap is counted once). */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).map((x) => [x[0], x[1]] as Interval).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The parts of A that are inside B (both merged). */
export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]);
    const e = Math.min(a[i][1], b[j][1]);
    if (e > s) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return out;
}

/** The parts of A that are NOT inside R (both merged). */
export function subtractIntervals(a: Interval[], r: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [s0, e0] of a) {
    let s = s0;
    for (const [rs, re] of r) {
      if (re <= s || rs >= e0) continue;
      if (rs > s) out.push([s, rs]);
      s = Math.max(s, re);
      if (s >= e0) break;
    }
    if (s < e0) out.push([s, e0]);
  }
  return out;
}

export const secondsIn = (list: Interval[]): number => Math.floor(list.reduce((n, [a, b]) => n + (b - a), 0) / 1000);

export type TimerInput = {
  /** the task's work sessions; endedAt null = running now */
  sessions: { startedAt: number; endedAt: number | null }[];
  /** when the person was clocked in (loginAt .. logoutAt, or now while still clocked in) */
  clockedIn: Interval[];
  /** break / washroom rows (the gap between a clock-out and the next clock-in is one of these rows) */
  away: Interval[];
  now: number;
  /** the moment the task was completed (submitted), if it is */
  completedAt: number | null;
  status: string; // PENDING | IN_PROGRESS | COMPLETED | CANCELLED
};
export type TimerFigures = {
  tracked: boolean;
  /** true while the clock is really running: a session is open AND the person is clocked in AND not on a break */
  running: boolean;
  /** why an open session is not accumulating right now */
  pausedReason: "BREAK" | "CLOCKED_OUT" | null;
  firstStartedAt: number | null;
  lastSubmittedAt: number | null;
  activeSeconds: number;
  elapsedSeconds: number;
  pausedSeconds: number;
  sessionCount: number;
  /** the active working intervals (for a per-person union, so overlapping tasks are never double counted) */
  intervals: Interval[];
};

export function computeTimer(f: TimerInput): TimerFigures {
  if (f.sessions.length === 0) {
    return { tracked: false, running: false, pausedReason: null, firstStartedAt: null, lastSubmittedAt: f.completedAt, activeSeconds: 0, elapsedSeconds: 0, pausedSeconds: 0, sessionCount: 0, intervals: [] };
  }
  const raw = mergeIntervals(f.sessions.map((s) => [s.startedAt, s.endedAt ?? f.now] as Interval));
  const active = subtractIntervals(intersectIntervals(raw, mergeIntervals(f.clockedIn)), mergeIntervals(f.away));
  const activeSeconds = secondsIn(active);
  const firstStartedAt = Math.min(...f.sessions.map((s) => s.startedAt));
  const open = f.sessions.some((s) => s.endedAt === null);
  const lastEnd = Math.max(...f.sessions.map((s) => s.endedAt ?? f.now));
  // final submission: while the task is submitted, the end is where its last session closed; otherwise the figure keeps growing to now
  const end = f.status === "COMPLETED" && !open ? (f.completedAt ?? lastEnd) : f.now;
  const elapsedSeconds = Math.max(activeSeconds, Math.floor((Math.max(end, firstStartedAt) - firstStartedAt) / 1000));
  // inclusive at both ends: a person still clocked in (or still on a break) has an interval that ends exactly at "now"
  const nowClockedIn = mergeIntervals(f.clockedIn).some(([a, b]) => f.now >= a && f.now <= b);
  const nowAway = mergeIntervals(f.away).some(([a, b]) => f.now >= a && f.now <= b);
  const running = open && nowClockedIn && !nowAway;
  return {
    tracked: true,
    running,
    pausedReason: open && !running ? (nowClockedIn ? "BREAK" : "CLOCKED_OUT") : null,
    firstStartedAt,
    lastSubmittedAt: f.completedAt,
    activeSeconds,
    elapsedSeconds,
    pausedSeconds: Math.max(0, elapsedSeconds - activeSeconds),
    sessionCount: f.sessions.length,
    intervals: active,
  };
}

/** One person's total working time across several tasks: overlapping tasks are counted ONCE (a person cannot work more than the clock allows). */
export function unionSeconds(perTask: Interval[][]): number {
  return secondsIn(mergeIntervals(perTask.flat()));
}

/** "02h 14m 35s" (the way every screen writes a duration). */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}h ${p(m)}m ${p(sec)}s`;
}

// ---------------------------------------------------------------------------
// BREAK PAUSES (derived, nothing is stored): each break or washroom row that overlaps a time the task was running is one pause. "Paused" = the later of the
// break start and the task session start; "Resumed" = the earlier of the break end and the session end (null while the break is still running).
// Discussions are productive time, so they never appear here. The break rows are the source of truth, so a break correction, a refresh or a second tab can never
// make the pause list disagree with attendance, and a pause can never be duplicated or overlap another.
// ---------------------------------------------------------------------------
export type AwayRow = { start: number; end: number; open: boolean; kind: "BREAK" | "WASHROOM" };
export type Pause = { pausedAt: number; resumedAt: number | null; seconds: number; kind: "BREAK" | "WASHROOM" };

export function breakPauses(sessions: { startedAt: number; endedAt: number | null }[], away: AwayRow[], now: number, max = 30): Pause[] {
  const out: Pause[] = [];
  const seen = new Set<string>();
  for (const a of away) {
    for (const s of sessions) {
      const sEnd = s.endedAt ?? now;
      const start = Math.max(a.start, s.startedAt);
      const end = Math.min(a.end, sEnd);
      if (end <= start) continue; // the task was not running during this break
      const resumed = a.open && sEnd >= now ? null : end; // still on break and the task is still running = not resumed yet
      const key = `${start}|${resumed ?? "open"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pausedAt: start, resumedAt: resumed, seconds: Math.round((end - start) / 1000), kind: a.kind });
    }
  }
  return out.sort((x, y) => x.pausedAt - y.pausedAt).slice(-max);
}
