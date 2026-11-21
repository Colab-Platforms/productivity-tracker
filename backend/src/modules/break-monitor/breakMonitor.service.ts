import { prisma } from "../../lib/prisma.js";
import { parseIsoDay, platformToday } from "../../lib/dates.js";
import { narrowIds } from "../hr-filters/hrFilters.service.js";
import type { HrFilters } from "../hr-filters/hrFilters.logic.js";
import { visibleUserIds } from "../tracker/tracker.service.js";
import { isCountedBreak } from "../tracker/activityClass.js";
import { aggregate, computeDays, monthOf, weekOf, type BreakIn, type BreakRow, type DayRow, type PersonAgg, type Policy } from "./breakMonitor.logic.js";

// ---------------------------------------------------------------------------
// BREAK MANAGEMENT (Admin only, read-only). Reads the EXISTING break rows (tracker_breaks) and work sessions; writes nothing, adds no table.
// People = the Admin's own reach (visibleUserIds: every company they act on, Admin accounts left out), narrowed by the shared HR filters.
// Rules in breakMonitor.logic.ts. One answer feeds the cards, the table, the defaulter tabs, the employee drawer and the exports.
// ---------------------------------------------------------------------------

const MAX_DAYS = 93;
const MAX_ROWS = 5000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const nameOf = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

export type Query = { from?: unknown; to?: unknown; filters?: HrFilters; breakType?: unknown; status?: unknown; defaulter?: unknown; userId?: unknown };

export async function overview(viewerId: string, q: Query) {
  const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: { id: true, role: true, platformId: true, platform: { select: { timezone: true } } } });
  if (!viewer || String(viewer.role) !== "ADMIN") throw new Error("NOT_ALLOWED");
  const tz = viewer.platform.timezone;
  const today = iso(platformToday(tz));
  const from = q.from ? iso(parseIsoDay(q.from)) : today;
  const to = q.to ? iso(parseIsoDay(q.to)) : from;
  if (to < from) throw new Error("BAD_RANGE");
  if ((Date.parse(to) - Date.parse(from)) / 864e5 + 1 > MAX_DAYS) throw new Error("RANGE_TOO_LONG");

  // the people: the Admin's reach, narrowed by the filters (company, project, reporting manager, department, name / ID)
  const reach = await visibleUserIds({ id: viewer.id, role: "ADMIN", platformId: viewer.platformId });
  const narrowed = await narrowIds(reach, q.filters, { activeOnly: true });
  let ids = narrowed.ids;
  if (q.userId) {
    const one = String(q.userId);
    if (!reach.includes(one)) throw new Error("NOT_FOUND");
    ids = [one];
  }

  // the week and the month that contain the end of the range (for the defaulter cards and tabs)
  const week = weekOf(to), month = monthOf(to);
  const spanFrom = [from, week.from, month.from].sort()[0];
  const spanTo = [to, week.to, month.to].sort().reverse()[0];

  const empty = { generatedAt: new Date().toISOString(), timezone: tz, today, from, to, week, month, scope: narrowed.scope, people: {}, breaks: [], days: [], range: [], weekly: [], monthly: [], summary: emptySummary(), capped: false };
  if (ids.length === 0) return empty;

  const [people, rawBreaks, sessions] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, firstName: true, lastName: true, employeeCode: true, designation: true, status: true,
        platform: { select: { name: true, defaultBreakBudgetMins: true } },
        reportsTo: { select: { firstName: true, lastName: true } },
        teamMemberships: { where: { isActive: true }, orderBy: [{ isPrimary: "desc" }, { joinedAt: "asc" }], take: 1, select: { team: { select: { name: true, config: { select: { breakBudgetMinutes: true } } } } } },
      },
    }),
    prisma.trackerBreak.findMany({
      where: { workSession: { userId: { in: ids }, date: { gte: parseIsoDay(spanFrom), lte: parseIsoDay(spanTo) } } },
      select: { id: true, breakType: true, reason: true, startedAt: true, endedAt: true, correctedDurationSeconds: true, workSession: { select: { userId: true, date: true } } },
      orderBy: { startedAt: "desc" },
      take: MAX_ROWS * 3,
    }),
    prisma.workSession.findMany({ where: { userId: { in: ids }, date: { gte: parseIsoDay(spanFrom), lte: parseIsoDay(spanTo) } }, select: { userId: true, date: true } }),
  ]);

  // Break Time: the team's setting, else the company's setting (a daily allowance; no tolerance is added).
  const policies = new Map<string, Policy>();
  const info: Record<string, { name: string; employeeCode: string | null; company: string; department: string | null; designation: string | null; manager: string | null; allowanceMinutes: number | null; allowanceSource: "TEAM" | "COMPANY" | null }> = {};
  for (const p of people) {
    const cfg = p.teamMemberships[0]?.team?.config ?? null;
    const team = cfg?.breakBudgetMinutes ?? null;
    const company = p.platform.defaultBreakBudgetMins ?? null;
    const allowance = team ?? company;
    const valid = allowance !== null && allowance > 0;
    policies.set(p.id, { allowanceSeconds: valid ? (allowance as number) * 60 : null });
    info[p.id] = {
      name: nameOf(p), employeeCode: p.employeeCode, company: p.platform.name, department: p.teamMemberships[0]?.team?.name ?? null, designation: p.designation,
      manager: p.reportsTo ? nameOf(p.reportsTo) : null, allowanceMinutes: valid ? allowance : null,
      allowanceSource: !valid ? null : team !== null ? "TEAM" : "COMPANY",
    };
  }
  const policyOf = (u: string) => policies.get(u) ?? { allowanceSeconds: null };

  const now = new Date();
  const rows: BreakIn[] = rawBreaks
    .filter((b) => isCountedBreak({ breakType: String(b.breakType), reason: b.reason }))
    .map((b) => ({ id: b.id, userId: b.workSession.userId, day: iso(b.workSession.date), breakType: String(b.breakType), reason: b.reason, startedAt: b.startedAt, endedAt: b.endedAt, correctedDurationSeconds: b.correctedDurationSeconds }));
  const all = computeDays(rows, policyOf, now);

  const present = (a: string, b: string) => {
    const m = new Map<string, Set<string>>();
    for (const s of sessions) { const d = iso(s.date); if (d < a || d > b) continue; const set = m.get(s.userId) ?? new Set(); set.add(d); m.set(s.userId, set); }
    return m;
  };
  const inSpan = (a: string, b: string) => ({ breaks: all.breaks.filter((x) => x.day >= a && x.day <= b), days: all.days.filter((x) => x.day >= a && x.day <= b) });
  const R = inSpan(from, to), W = inSpan(week.from, week.to), M = inSpan(month.from, month.to);
  const rangeAgg = aggregate(R.days, R.breaks, present(from, to), policyOf);
  const weekAgg = aggregate(W.days, W.breaks, present(week.from, week.to), policyOf);
  const monthAgg = aggregate(M.days, M.breaks, present(month.from, month.to), policyOf);

  // the record filters: break type, break status, defaulter (a person with an exceeded day in the range)
  const defaulters = new Set(rangeAgg.filter((p) => p.defaulter).map((p) => p.userId));
  const type = typeof q.breakType === "string" && q.breakType ? q.breakType : null;
  const status = ["ACTIVE", "COMPLETED", "EXCEEDED"].find((s) => s === q.status) ?? null;
  const dflt = q.defaulter === "yes" ? true : q.defaulter === "no" ? false : null;
  const keepUser = (u: string) => dflt === null || defaulters.has(u) === dflt;
  const breaks = R.breaks.filter((b) => keepUser(b.userId) && (!type || b.breakType === type) && (!status || b.status === status));
  const shownUsers = new Set(breaks.map((b) => b.userId));
  const days = R.days.filter((d) => keepUser(d.userId) && (!type && !status ? true : shownUsers.has(d.userId)));
  const keepAgg = (list: PersonAgg[]) => list.filter((p) => keepUser(p.userId) && (!type && !status ? true : shownUsers.has(p.userId)));
  const range = keepAgg(rangeAgg), weekly = keepAgg(weekAgg), monthly = keepAgg(monthAgg);

  return {
    ...empty,
    people: info,
    breaks: breaks.slice(0, MAX_ROWS),
    capped: breaks.length > MAX_ROWS,
    days,
    range,
    weekly,
    monthly,
    summary: summaryOf(breaks, days, range, weekly, monthly, today),
  };
}

function emptySummary() {
  return { employeesWithBreaks: [] as string[], currentlyOnBreak: [] as string[], breaksToday: 0, breaksTodayIds: [] as string[], avgBreakSeconds: null as number | null, completedBreaks: 0, exceeding: [] as string[], weeklyDefaulters: [] as string[], monthlyDefaulters: [] as string[] };
}

/** Every card's number is the length of its own list (ids of people or of breaks), so a click shows exactly what was counted. */
function summaryOf(breaks: BreakRow[], days: DayRow[], range: PersonAgg[], weekly: PersonAgg[], monthly: PersonAgg[], today: string) {
  const completed = breaks.filter((b) => !b.open);
  return {
    employeesWithBreaks: [...new Set(breaks.map((b) => b.userId))],
    currentlyOnBreak: [...new Set(breaks.filter((b) => b.open && b.day === today).map((b) => b.userId))],
    breaksToday: breaks.filter((b) => b.day === today).length,
    breaksTodayIds: breaks.filter((b) => b.day === today).map((b) => b.id),
    avgBreakSeconds: completed.length ? Math.round(completed.reduce((n, b) => n + b.seconds, 0) / completed.length) : null,
    completedBreaks: completed.length,
    exceeding: [...new Set(days.filter((d) => d.exceeded).map((d) => d.userId))],
    weeklyDefaulters: weekly.filter((p) => p.defaulter).map((p) => p.userId),
    monthlyDefaulters: monthly.filter((p) => p.defaulter).map((p) => p.userId),
  };
}
