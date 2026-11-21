// ---------------------------------------------------------------------------
// BREAK MANAGEMENT (Admin monitoring): pure rules, no database. Everything the page and the exports show is worked out here from the EXISTING
// break rows, so a card, a table and a download can never disagree.
//
//   Which rows       counted breaks only (activityClass: Lunch, Personal, Other, older Tea). Washroom and discussions are not breaks.
//   Duration         the time every total in the HRMS uses (breakRowSeconds: an Admin correction wins, else the recorded timestamps). A running
//                    break counts up to "now". If two recorded intervals of the same day overlap, the overlap is counted once.
//   Allowance        the DAILY Break Time: the person's team setting, else their company's setting; none = "Not configured" (never a defaulter).
//   Exceeded day     the day's break total is above that day's Break Time (owner rule 2026-11-21: no tolerance, even one minute over counts).
//   Excess           day: total minus Break Time (only on an exceeded day); break: the part of THAT break beyond the allowance, in time order.
//   Defaulter        at least ONE exceeded day in the chosen week / month / range (repeats are not required), checked day by day against
//                    the daily allowance, never against a weekly or monthly total. Each violation (date, allowed, actual, excess) is listed.
//                    Days without break records cannot be violations. Nothing is penalised; this only reports.
// ---------------------------------------------------------------------------

export type BreakIn = {
  id: string;
  userId: string;
  day: string; // the work session's day, YYYY-MM-DD
  breakType: string;
  reason?: string | null;
  startedAt: Date;
  endedAt: Date | null;
  correctedDurationSeconds?: number | null;
};
export type Policy = { allowanceSeconds: number | null };

export type BreakRow = BreakIn & { seconds: number; open: boolean; allowanceSeconds: number | null; excessSeconds: number | null; status: "ACTIVE" | "COMPLETED" | "EXCEEDED" };
export type DayRow = { userId: string; day: string; breaks: number; seconds: number; allowanceSeconds: number | null; excessSeconds: number | null; exceeded: boolean; open: boolean };
export type PersonAgg = {
  userId: string; breaks: number; seconds: number; daysPresent: number; daysWithBreaks: number;
  permittedSeconds: number | null; excessSeconds: number | null; daysExceeded: number; incidents: number; avgDailySeconds: number | null; configured: boolean; defaulter: boolean;
  /** every day over the allowance, oldest first: the date, the allowance, the actual break total and the excess */
  violations: { day: string; allowanceSeconds: number; actualSeconds: number; excessSeconds: number }[];
};

/** Per-break and per-day figures. `rows` must already be counted breaks only. */
export function computeDays(rows: BreakIn[], policyOf: (userId: string) => Policy, now: Date): { breaks: BreakRow[]; days: DayRow[] } {
  const byDay = new Map<string, BreakIn[]>();
  for (const r of rows) {
    const k = `${r.userId}|${r.day}`;
    const l = byDay.get(k) ?? [];
    if (!l.some((x) => x.id === r.id)) l.push(r); // the same row twice is counted once
    byDay.set(k, l);
  }
  const breaks: BreakRow[] = [];
  const days: DayRow[] = [];
  for (const [k, list] of byDay) {
    const [userId, day] = k.split("|");
    const pol = policyOf(userId);
    list.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    let lastEnd = 0;
    let total = 0;
    let open = false;
    for (const r of list) {
      const end = (r.endedAt ?? now).getTime();
      const start = r.startedAt.getTime();
      const corrected = r.endedAt && r.correctedDurationSeconds != null;
      const secs = corrected ? Math.max(0, r.correctedDurationSeconds as number) : Math.max(0, Math.floor((end - Math.max(start, lastEnd)) / 1000));
      lastEnd = Math.max(lastEnd, end);
      const before = total;
      total += secs;
      const excess = pol.allowanceSeconds === null ? null : Math.max(0, total - pol.allowanceSeconds) - Math.max(0, before - pol.allowanceSeconds);
      const isOpen = !r.endedAt;
      open = open || isOpen;
      breaks.push({ ...r, seconds: secs, open: isOpen, allowanceSeconds: pol.allowanceSeconds, excessSeconds: excess, status: isOpen ? "ACTIVE" : excess && excess > 0 ? "EXCEEDED" : "COMPLETED" });
    }
    const exceeded = pol.allowanceSeconds !== null && total > pol.allowanceSeconds;
    days.push({ userId, day, breaks: list.length, seconds: total, allowanceSeconds: pol.allowanceSeconds, excessSeconds: pol.allowanceSeconds === null ? null : exceeded ? total - pol.allowanceSeconds : 0, exceeded, open });
  }
  breaks.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  days.sort((a, b) => (a.day === b.day ? a.userId.localeCompare(b.userId) : b.day.localeCompare(a.day)));
  return { breaks, days };
}

/** One line per person for a period. `presentDays` = the days each person had a work session (the days Break Time applied). */
export function aggregate(days: DayRow[], breaks: BreakRow[], presentDays: Map<string, Set<string>>, policyOf: (userId: string) => Policy): PersonAgg[] {
  const users = new Set<string>([...days.map((d) => d.userId), ...presentDays.keys()]);
  const out: PersonAgg[] = [];
  for (const userId of users) {
    const pol = policyOf(userId);
    const mine = days.filter((d) => d.userId === userId);
    const present = new Set([...(presentDays.get(userId) ?? []), ...mine.map((d) => d.day)]);
    const seconds = mine.reduce((n, d) => n + d.seconds, 0);
    const configured = pol.allowanceSeconds !== null;
    const daysExceeded = mine.filter((d) => d.exceeded).length;
    out.push({
      userId,
      breaks: mine.reduce((n, d) => n + d.breaks, 0),
      seconds,
      daysPresent: present.size,
      daysWithBreaks: mine.length,
      permittedSeconds: configured ? (pol.allowanceSeconds as number) * present.size : null,
      excessSeconds: configured ? mine.reduce((n, d) => n + (d.excessSeconds ?? 0), 0) : null,
      daysExceeded,
      incidents: breaks.filter((b) => b.userId === userId && (b.excessSeconds ?? 0) > 0).length,
      avgDailySeconds: present.size ? Math.round(seconds / present.size) : null,
      configured,
      defaulter: configured && daysExceeded > 0,
      violations: mine.filter((d) => d.exceeded).sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ day: d.day, allowanceSeconds: d.allowanceSeconds as number, actualSeconds: d.seconds, excessSeconds: d.excessSeconds as number })),
    });
  }
  return out;
}

/** Monday..Sunday week and calendar month that contain `day` (YYYY-MM-DD), as YYYY-MM-DD bounds. */
export function weekOf(day: string): { from: string; to: string } {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  const from = new Date(d.getTime() - (dow - 1) * 864e5);
  return { from: from.toISOString().slice(0, 10), to: new Date(from.getTime() + 6 * 864e5).toISOString().slice(0, 10) };
}
export function monthOf(day: string): { from: string; to: string } {
  const [y, m] = day.split("-").map(Number);
  return { from: `${day.slice(0, 7)}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
