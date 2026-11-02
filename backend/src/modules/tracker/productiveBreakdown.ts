// ---------------------------------------------------------------------------
// PRODUCTIVE-TIME BREAKDOWN: how much of a day's productive time was regular work, Team Huddle, and other eligible time.
//
// IMPORTANT: this never ADDS time. The app already counts every minute a person is clocked in and not on a break as
// productive (tracker.service recompute). A huddle that happens inside that time is therefore ALREADY part of the total;
// this module only splits the same total, so it can be shown ("6h regular + 30m huddle = 6h 30m"). A huddle minute outside
// clock-in, or during a break, counts as zero. Employee and manager screens both call this ONE function, so they cannot
// disagree.
//
// Pure functions of times: no database, no clock (the caller passes `now`), so every rule is testable.
// ---------------------------------------------------------------------------

export type Iv = { start: number; end: number }; // milliseconds

/** Sort and join overlapping or touching intervals, dropping empty ones. */
export function merge(list: Iv[]): Iv[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Iv[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** The parts present in BOTH lists (each list must already be merged). */
export function intersect(a: Iv[], b: Iv[]): Iv[] {
  const out: Iv[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start) out.push({ start, end });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

/** `a` with everything in `b` taken out (each list must already be merged). */
export function subtract(a: Iv[], b: Iv[]): Iv[] {
  const out: Iv[] = [];
  for (const x of a) {
    let cur = x.start;
    for (const y of b) {
      if (y.end <= cur) continue;
      if (y.start >= x.end) break;
      if (y.start > cur) out.push({ start: cur, end: y.start });
      cur = Math.max(cur, y.end);
    }
    if (cur < x.end) out.push({ start: cur, end: x.end });
  }
  return out;
}

export const totalSeconds = (list: Iv[]): number => Math.floor(list.reduce((n, i) => n + (i.end - i.start), 0) / 1000);

export type BreakdownInput = {
  loginAt: Date;
  logoutAt: Date | null; // null while still clocked in
  breaks: { startedAt: Date; endedAt: Date | null }[];
  /** Approved live (manager-invited) meetings, already part of productive time. Unapproved ones count for nothing. */
  liveMeetings: { approvalStatus: string; startedAt: Date | null; endedAt: Date | null }[];
  /** The person's Team Huddle participation for the day. `expectedEnd` is the scheduled end of that huddle. */
  huddles: { id: string; joinedAt: Date; leftAt: Date | null; expectedEnd: Date }[];
  now: Date;
};

export type HuddleCount = {
  id: string;
  rawSeconds: number; // joined to left (or to the cap), whatever the clock-in said
  countedSeconds: number; // the part inside clock-in and outside breaks
  openPastEnd: boolean; // never ended and the expected end has passed: counted only up to the expected end
};

export type Breakdown = {
  productiveSeconds: number; // clocked in, minus breaks: the same figure the app already uses
  regularSeconds: number;
  huddleSeconds: number;
  otherEligibleSeconds: number;
  huddles: HuddleCount[];
};

/**
 * Rules (all applied here and nowhere else):
 *  - Start counting at the recorded join, stop at the recorded leave. Still joined and not ended: count to `now`, but never
 *    past the huddle's expected end (a forgotten "End Huddle" cannot keep adding time). The record itself is left
 *    open and flagged for the manager to correct.
 *  - Only time inside the clocked-in period counts, and never time on a break.
 *  - Overlapping huddles, or a huddle overlapping an approved live meeting, are never counted twice: the huddle gets the
 *    overlap, "other eligible" gets the rest of the meeting.
 *  - Not joined = no record = zero.
 *  - regular + huddle + other always equals productive, by construction.
 */
export function computeBreakdown(input: BreakdownInput): Breakdown {
  const nowMs = input.now.getTime();
  const clockEnd = (input.logoutAt ?? input.now).getTime();
  const clocked = merge([{ start: input.loginAt.getTime(), end: clockEnd }]);
  const breaks = merge(input.breaks.map((b) => ({ start: b.startedAt.getTime(), end: (b.endedAt ?? input.now).getTime() })));
  const working = subtract(clocked, breaks); // the productive time itself
  const productiveSeconds = totalSeconds(working);

  const segmentOf = (h: BreakdownInput["huddles"][number]): Iv => {
    const cap = Math.min(nowMs, h.expectedEnd.getTime());
    const end = h.leftAt ? h.leftAt.getTime() : Math.max(h.joinedAt.getTime(), cap);
    return { start: h.joinedAt.getTime(), end };
  };

  const segments = input.huddles.map(segmentOf);
  const huddleTime = intersect(merge(segments), working);
  const huddleSeconds = totalSeconds(huddleTime);

  const meetings = merge(
    input.liveMeetings
      .filter((m) => m.approvalStatus === "APPROVED" && m.startedAt)
      .map((m) => ({ start: (m.startedAt as Date).getTime(), end: (m.endedAt ?? input.now).getTime() }))
  );
  const otherEligibleSeconds = totalSeconds(subtract(intersect(meetings, working), huddleTime));

  return {
    productiveSeconds,
    regularSeconds: Math.max(0, productiveSeconds - huddleSeconds - otherEligibleSeconds),
    huddleSeconds,
    otherEligibleSeconds,
    huddles: input.huddles.map((h, i) => ({
      id: h.id,
      rawSeconds: Math.max(0, Math.floor((segments[i].end - segments[i].start) / 1000)),
      countedSeconds: totalSeconds(intersect(merge([segments[i]]), working)),
      openPastEnd: h.leftAt === null && nowMs > h.expectedEnd.getTime(),
    })),
  };
}

/**
 * Actual time spent on a task: from the moment it was started to the moment it was completed, counting only time inside the
 * person's clocked-in period and outside their breaks (the same rule as everything else here). If the task was never started,
 * never completed, or there is no clocked-in session to measure against, there is no reliable figure and it returns null
 * (shown as "no timing", counted as zero). A LABEL on the task: never added to productive time.
 */
export function taskWorkSeconds(input: {
  startedAt: Date | null;
  completedAt: Date | null;
  loginAt: Date | null;
  logoutAt: Date | null;
  breaks: { startedAt: Date; endedAt: Date | null }[];
  now: Date;
}): number | null {
  if (!input.startedAt || !input.completedAt || !input.loginAt) return null;
  if (input.completedAt.getTime() <= input.startedAt.getTime()) return null;
  const clocked = merge([{ start: input.loginAt.getTime(), end: (input.logoutAt ?? input.now).getTime() }]);
  const breaks = merge(input.breaks.map((b) => ({ start: b.startedAt.getTime(), end: (b.endedAt ?? input.now).getTime() })));
  const working = subtract(clocked, breaks);
  return totalSeconds(intersect(merge([{ start: input.startedAt.getTime(), end: input.completedAt.getTime() }]), working));
}
