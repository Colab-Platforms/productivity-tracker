// Task-based productivity (manager view) and the daily targets that HR/Admin set.
//
// Productivity = tasks completed ÷ the daily target, per person per day. Nothing here uses attendance time as a
// proxy for output, and nothing is invented:
//   * a task counts once, in the company-timezone day and hour it was actually COMPLETED (its completion time);
//   * it must be completed AND approved, with a completion time, and not graded partial/failed;
//   * it belongs to the person it was created for;
//   * no target set      -> "Target not configured"      (the count is still shown, the % is not);
//   * no completion data -> "No task data available"      (never shown as 0%).
// Target priority: person  >  team  >  company default.
//
// Who is on screen is the same list as everywhere else in the manager views (visibleUserIds).

import { prisma } from "../../lib/prisma.js";
import { narrowIds } from "../hr-filters/hrFilters.service.js";
import { starsFor } from "../tasks/tasks.rating.js";
import { isCompleteRating } from "../tasks/tasks.rating.logic.js";
import type { HrFilters } from "../hr-filters/hrFilters.logic.js";
import { selfManagedTaskIdsOf } from "../tasks/tasks.self.js";
import { auditNote } from "../../lib/auditContext.js";
import { localDayOf, parseIsoDay, platformToday, zonedToUtc } from "../../lib/dates.js";
import { visibleUserIds } from "../tracker/tracker.service.js";

const MAX_RANGE_DAYS = 93;
const MAX_TARGET = 1000;

export type TargetSource = "PERSON" | "TEAM" | "COMPANY" | null;

async function getViewer(viewerId: string) {
  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    select: { id: true, role: true, platformId: true, platform: { select: { timezone: true } } },
  });
  if (!viewer) throw new Error("USER_NOT_FOUND");
  if (!["MANAGER", "HR", "ADMIN"].includes(String(viewer.role))) throw new Error("NOT_ALLOWED");
  return viewer;
}

// The targets table is new. Until its migration has been applied the app must keep working and say so.
const isMissingTable = (e: unknown) => {
  const msg = e instanceof Error ? e.message : "";
  return (typeof (e as { code?: unknown })?.code === "string" && (e as { code: string }).code === "P2021") || /daily_task_targets/.test(msg) && /does not exist|relation/.test(msg);
};

type TargetRow = { id: string; platformId: string; teamId: string | null; userId: string | null; tasksPerDay: number };

async function loadTargets(platformIds: string[]): Promise<{ ready: boolean; rows: TargetRow[] }> {
  try {
    const rows = await prisma.dailyTaskTarget.findMany({ where: { platformId: { in: platformIds } } });
    return { ready: true, rows };
  } catch (e) {
    if (isMissingTable(e)) return { ready: false, rows: [] };
    throw e;
  }
}

function resolveTarget(rows: TargetRow[], platformId: string, userId: string, teamId: string | null): { perDay: number | null; source: TargetSource } {
  const mine = rows.filter((r) => r.platformId === platformId);
  const person = mine.find((r) => r.userId === userId);
  if (person) return { perDay: person.tasksPerDay, source: "PERSON" };
  const team = teamId ? mine.find((r) => r.teamId === teamId && !r.userId) : undefined;
  if (team) return { perDay: team.tasksPerDay, source: "TEAM" };
  const company = mine.find((r) => !r.teamId && !r.userId);
  if (company) return { perDay: company.tasksPerDay, source: "COMPANY" };
  return { perDay: null, source: null };
}

const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const hourIn = (instant: Date, tz: string) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(instant));

// A task counts only when it is really finished: completed, approved, timestamped, and not rated below the "completed" star
// threshold (unrated finished work counts). The star check happens after the read (keepFullyDone), because ratings live in their own table.
// (The completion time is required too: every query below filters on completedAt being inside a day.)
const COUNTED = {
  status: "COMPLETED" as const,
  approvalStatus: "APPROVED" as const,
};

async function keepFullyDone<T extends { id: string; outcome: unknown }>(rows: T[]): Promise<T[]> {
  const stars = await starsFor(rows);
  return rows.filter((r) => isCompleteRating(stars.get(r.id) ?? null));
}

type ScopedPerson = { id: string; name: string; code: string | null; platformId: string; teamId: string | null; teamName: string | null };

async function scopedPeople(viewer: Awaited<ReturnType<typeof getViewer>>, q: { userId?: string; teamId?: string; filters?: HrFilters }): Promise<{ people: ScopedPerson[]; scope: { orgTotal: number; filteredTotal: number } }> {
  // The HR filters narrow what the viewer may already see; scope reports how many are left next to how many the viewer may see.
  const narrowed = await narrowIds(await visibleUserIds({ id: viewer.id, role: String(viewer.role), platformId: viewer.platformId }), q.filters);
  const allowed = narrowed.ids;
  const scope = narrowed.scope;
  if (allowed.length === 0) return { people: [], scope };
  const people = await prisma.user.findMany({
    where: { id: { in: allowed }, status: { notIn: ["SUSPENDED", "EXITED"] } },
    select: {
      id: true, firstName: true, lastName: true, employeeCode: true, platformId: true,
      teamMemberships: { where: { isActive: true }, select: { team: { select: { id: true, name: true } } }, take: 1 },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  // Filters can only narrow what the viewer may already see.
  const list = people
    .map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`.trim(), code: p.employeeCode, platformId: p.platformId, teamId: p.teamMemberships[0]?.team.id ?? null, teamName: p.teamMemberships[0]?.team.name ?? null }))
    .filter((p) => (!q.userId || p.id === q.userId) && (!q.teamId || p.teamId === q.teamId));
  return { people: list, scope };
}

// ---------------------------------------------------------------------------------------------
// PRODUCTIVITY OVER A RANGE (per person, per day)
// ---------------------------------------------------------------------------------------------
export async function getProductivity(viewerId: string, q: { from?: string; to?: string; userId?: string; teamId?: string; filters?: HrFilters }) {
  const viewer = await getViewer(viewerId);
  const tz = viewer.platform.timezone;
  const today = platformToday(tz).toISOString().slice(0, 10);
  const fromIso = q.from ? parseIsoDay(q.from).toISOString().slice(0, 10) : today;
  const toIsoRaw = q.to ? parseIsoDay(q.to).toISOString().slice(0, 10) : fromIso;
  if (toIsoRaw < fromIso) throw new Error("BAD_RANGE");
  const dayCount = (Date.parse(toIsoRaw) - Date.parse(fromIso)) / 86400000 + 1;
  if (dayCount > MAX_RANGE_DAYS) throw new Error("RANGE_TOO_LONG");
  const toIso = toIsoRaw > today ? today : toIsoRaw; // no future days
  const base = { generatedAt: new Date().toISOString(), timezone: tz, today, from: fromIso, to: toIso };

  const { people, scope } = await scopedPeople(viewer, q);
  const platformIds = Array.from(new Set(people.map((p) => p.platformId)));
  const targets = people.length ? await loadTargets(platformIds) : { ready: true, rows: [] as TargetRow[] };
  if (people.length === 0 || toIso < fromIso) return { ...base, scope, targetsReady: targets.ready, people: [] as unknown[] };

  const ids = people.map((p) => p.id);
  const startUtc = zonedToUtc(fromIso, "00:00", tz);
  const endUtc = zonedToUtc(addDays(toIso, 1), "00:00", tz);
  const rangeDay = (d: Date) => d.toISOString().slice(0, 10);

  // A manager's own (self-managed) tasks are his personal productivity: they never count in TEAM figures.
  const selfIds = await selfManagedTaskIdsOf(ids);
  const [counted, planned, legacy] = await Promise.all([
    prisma.dailyTask.findMany({ where: { userId: { in: ids }, id: { notIn: selfIds }, ...COUNTED, completedAt: { gte: startUtc, lt: endUtc } }, select: { id: true, userId: true, completedAt: true, outcome: true } }).then(keepFullyDone),
    prisma.dailyTask.groupBy({ by: ["userId", "date"], where: { userId: { in: ids }, id: { notIn: selfIds }, approvalStatus: "APPROVED", date: { gte: parseIsoDay(fromIso), lte: parseIsoDay(toIso) } }, _count: { _all: true } }),
    prisma.dailyTask.groupBy({ by: ["userId", "date"], where: { userId: { in: ids }, id: { notIn: selfIds }, approvalStatus: "APPROVED", status: "COMPLETED", completedAt: null, date: { gte: parseIsoDay(fromIso), lte: parseIsoDay(toIso) } }, _count: { _all: true } }),
  ]);

  const doneBy = new Map<string, number>(); // "userId|day" -> tasks finished that day (each task once)
  const seen = new Set<string>();
  for (const t of counted) {
    if (seen.has(t.id) || !t.completedAt) continue;
    seen.add(t.id);
    const k = `${t.userId}|${localDayOf(t.completedAt, tz)}`;
    doneBy.set(k, (doneBy.get(k) ?? 0) + 1);
  }
  const plannedBy = new Map(planned.map((r) => [`${r.userId}|${rangeDay(r.date)}`, r._count._all]));
  const legacyBy = new Map(legacy.map((r) => [`${r.userId}|${rangeDay(r.date)}`, r._count._all]));

  const out = people.map((p) => {
    const t = resolveTarget(targets.rows, p.platformId, p.id, p.teamId);
    const days: { date: string; completed: number | null; percent: number | null; state: "DATA" | "NO_TASK_DATA" }[] = [];
    let completedTotal = 0;
    let dataDays = 0;
    for (let d = fromIso; d <= toIso; d = addDays(d, 1)) {
      const key = `${p.id}|${d}`;
      const done = doneBy.get(key) ?? 0;
      let state: "DATA" | "NO_TASK_DATA";
      if (done > 0) state = "DATA";
      else if ((legacyBy.get(key) ?? 0) > 0) state = "NO_TASK_DATA"; // finished before completion times were recorded
      else if ((plannedBy.get(key) ?? 0) > 0) state = "DATA"; // tasks existed, none finished: a real zero
      else state = "NO_TASK_DATA"; // no tasks recorded that day
      if (state === "DATA") {
        completedTotal += done;
        dataDays += 1;
      }
      days.push({
        date: d,
        completed: state === "DATA" ? done : null,
        percent: state === "DATA" && t.perDay ? Math.round((done / t.perDay) * 1000) / 10 : null,
        state,
      });
    }
    const targetTotal = t.perDay ? t.perDay * dataDays : null;
    return {
      userId: p.id, name: p.name, employeeCode: p.code, teamName: p.teamName,
      targetPerDay: t.perDay, targetSource: t.source,
      daysWithData: dataDays,
      completedTotal: dataDays > 0 ? completedTotal : null,
      targetTotal,
      overallPercent: targetTotal && dataDays > 0 ? Math.round((completedTotal / targetTotal) * 1000) / 10 : null,
      days,
    };
  });

  return { ...base, scope, targetsReady: targets.ready, people: out };
}

// ---------------------------------------------------------------------------------------------
// HOURLY TASKS FOR ONE DAY
// Counts only: how many tasks each person finished in each clock hour. There is no hourly target.
// ---------------------------------------------------------------------------------------------
export async function getHourly(viewerId: string, q: { date?: string; userId?: string; teamId?: string; filters?: HrFilters }) {
  const viewer = await getViewer(viewerId);
  const tz = viewer.platform.timezone;
  const today = platformToday(tz).toISOString().slice(0, 10);
  const day = q.date ? parseIsoDay(q.date).toISOString().slice(0, 10) : today;
  const base = { generatedAt: new Date().toISOString(), timezone: tz, today, date: day };

  const { people, scope } = await scopedPeople(viewer, q);
  if (people.length === 0) return { ...base, scope, people: [] as unknown[] };
  const ids = people.map((p) => p.id);
  const selfIds = await selfManagedTaskIdsOf(ids); // a manager's own tasks are not team productivity
  const tasks = await keepFullyDone(await prisma.dailyTask.findMany({
    where: { userId: { in: ids }, id: { notIn: selfIds }, ...COUNTED, completedAt: { gte: zonedToUtc(day, "00:00", tz), lt: zonedToUtc(addDays(day, 1), "00:00", tz) } },
    select: { id: true, userId: true, completedAt: true, outcome: true },
  }));
  const grid = new Map<string, number[]>();
  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id) || !t.completedAt) continue;
    seen.add(t.id);
    const h = hourIn(t.completedAt, tz);
    const row = grid.get(t.userId) ?? new Array(24).fill(0);
    row[h] += 1;
    grid.set(t.userId, row);
  }
  return {
    ...base,
    scope,
    people: people.map((p) => {
      const hours = grid.get(p.id) ?? new Array(24).fill(0);
      return { userId: p.id, name: p.name, employeeCode: p.code, teamName: p.teamName, hours, total: hours.reduce((a, b) => a + b, 0) };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// TARGETS (HR / Admin only)
// ---------------------------------------------------------------------------------------------
async function getAdmin(viewerId: string) {
  const viewer = await prisma.user.findUnique({ where: { id: viewerId }, select: { id: true, role: true, platformId: true } });
  if (!viewer) throw new Error("USER_NOT_FOUND");
  if (!["HR", "ADMIN"].includes(String(viewer.role))) throw new Error("NOT_ALLOWED");
  return viewer;
}

export async function listTargets(viewerId: string) {
  const viewer = await getAdmin(viewerId);
  const [teams, people, t] = await Promise.all([
    prisma.team.findMany({ where: { platformId: viewer.platformId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { platformId: viewer.platformId, status: { notIn: ["SUSPENDED", "EXITED"] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    loadTargets([viewer.platformId]),
  ]);
  return {
    ready: t.ready,
    company: t.rows.find((r) => !r.teamId && !r.userId)?.tasksPerDay ?? null,
    teams: teams.map((x) => ({ teamId: x.id, name: x.name, tasksPerDay: t.rows.find((r) => r.teamId === x.id)?.tasksPerDay ?? null })),
    people: people.map((x) => ({ userId: x.id, name: `${x.firstName} ${x.lastName}`.trim(), employeeCode: x.employeeCode, tasksPerDay: t.rows.find((r) => r.userId === x.id)?.tasksPerDay ?? null })),
  };
}

// scope "company" | "team" | "user". tasksPerDay null removes that target.
export async function setTarget(viewerId: string, body: { scope?: unknown; id?: unknown; tasksPerDay?: unknown }) {
  const viewer = await getAdmin(viewerId);
  const scope = String(body.scope ?? "");
  if (!["company", "team", "user"].includes(scope)) throw new Error("BAD_SCOPE");
  let tasksPerDay: number | null = null;
  if (body.tasksPerDay !== null && body.tasksPerDay !== undefined && body.tasksPerDay !== "") {
    const n = Number(body.tasksPerDay);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TARGET) throw new Error("BAD_TARGET");
    tasksPerDay = n;
  }

  // Ownership: a team or person must belong to the HR/Admin's own company.
  let teamId: string | null = null;
  let userId: string | null = null;
  let label = "the company";
  if (scope === "team") {
    teamId = String(body.id ?? "");
    const team = await prisma.team.findFirst({ where: { id: teamId, platformId: viewer.platformId }, select: { name: true } });
    if (!team) throw new Error("NOT_FOUND");
    label = `team ${team.name}`;
  } else if (scope === "user") {
    userId = String(body.id ?? "");
    const person = await prisma.user.findFirst({ where: { id: userId, platformId: viewer.platformId }, select: { firstName: true, lastName: true } });
    if (!person) throw new Error("NOT_FOUND");
    label = `${person.firstName} ${person.lastName}`.trim();
  }

  try {
    const where = { platformId: viewer.platformId, teamId, userId };
    const existing = await prisma.dailyTaskTarget.findFirst({ where });
    const before = existing?.tasksPerDay ?? null;
    if (tasksPerDay === null) {
      if (existing) await prisma.dailyTaskTarget.delete({ where: { id: existing.id } });
    } else if (existing) {
      await prisma.dailyTaskTarget.update({ where: { id: existing.id }, data: { tasksPerDay, updatedById: viewer.id } });
    } else {
      await prisma.dailyTaskTarget.create({ data: { platformId: viewer.platformId, teamId, userId, tasksPerDay, updatedById: viewer.id } });
    }
    auditNote({
      module: "Teams & rules", action: "UPDATE", recordType: "DailyTaskTarget", recordId: existing?.id ?? null, targetUserId: userId,
      before: { tasksPerDay: before }, after: { tasksPerDay },
      summary: tasksPerDay === null ? `Removed the daily task target for ${label}` : `Set the daily task target for ${label} to ${tasksPerDay}`,
    });
    return listTargets(viewerId);
  } catch (e) {
    if (isMissingTable(e)) throw new Error("TARGETS_NOT_READY");
    throw e;
  }
}
