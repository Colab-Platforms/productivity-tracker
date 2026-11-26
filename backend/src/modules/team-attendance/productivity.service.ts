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

import { inactiveStatuses } from "../../lib/userStatus.js";
import { weightedPerformance } from "../tasks/tasks.weighted.js";
import { isSupervisor, monitoringIds } from "../../lib/supervisor.js";
import { prisma } from "../../lib/prisma.js";
import { narrowIds } from "../hr-filters/hrFilters.service.js";
import { ratingsFor, starsFor } from "../tasks/tasks.rating.js";
import { isCompleteRating } from "../tasks/tasks.rating.logic.js";
import type { HrFilters } from "../hr-filters/hrFilters.logic.js";
import { selfManagedTaskIdsOf } from "../tasks/tasks.self.js";
import { auditNote } from "../../lib/auditContext.js";
import { accessFor, assertCompany } from "../../lib/companyAccess.js";
import { localDayOf, parseIsoDay, platformToday, zonedToUtc } from "../../lib/dates.js";
import { visibleUserIds } from "../tracker/tracker.service.js";
import { projectsAndManagers } from "./peopleDetails.js";
import { entryDetailsFor } from "../tasks/tasks.entry.js";
import { progressOf, pendingTaskVisibleTo } from "../tasks/tasks.entry.logic.js";
import { activeAssigned, activeTasks } from "../tasks/tasks.deleted.js";
import { assignedTasksForReport } from "../tasks/tasks.assigned.js";
import { lateDetailsFor } from "../tasks/tasks.late.js";
import { EFFICIENCY_POLICY_VERSION, efficiencyIndex, type EfficiencyTask } from "../tasks/efficiency.logic.js";
import { readEvidence } from "../tasks/tasks.evidence.js";
import { deletionsReady } from "../tasks/tasks.deleted.js";
import { adjustmentsFor, evaluationStatesFor, overlayWeighted } from "../tasks/evaluation.adjust.js";
import { getMonthAttendanceBulk } from "../attendance/attendance.service.js";
import { notTracked, timersFor, trackedSecondsByUser } from "../tasks/tasks.timer.js";

const MAX_RANGE_DAYS = 93;
const MAX_TARGET = 1000;

export type TargetSource = "PERSON" | "TEAM" | "COMPANY" | null;

async function getViewer(viewerId: string, self = false) {
  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    select: { id: true, role: true, platformId: true, platform: { select: { timezone: true } } },
  });
  if (!viewer) throw new Error("USER_NOT_FOUND");
  if (!self && !["MANAGER", "HR", "ADMIN"].includes(String(viewer.role)) && !(await isSupervisor(viewer.id))) throw new Error("NOT_ALLOWED");
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

async function scopedPeople(viewer: Awaited<ReturnType<typeof getViewer>>, q: { userId?: string; teamId?: string; filters?: HrFilters; self?: boolean }): Promise<{ people: ScopedPerson[]; scope: { orgTotal: number; filteredTotal: number } }> {
  // The HR filters narrow what the viewer may already see; scope reports how many are left next to how many the viewer may see.
  const narrowed = await narrowIds(
  q.self ? [viewer.id] : await visibleUserIds({ id: viewer.id, role: String(viewer.role), platformId: viewer.platformId }),
  q.self ? undefined : q.filters,
  { activeOnly: true },
  );
  const allowed = narrowed.ids;
  const scope = narrowed.scope;
  if (allowed.length === 0) return { people: [], scope };
  const people = await prisma.user.findMany({
    where: { id: { in: allowed }, status: { notIn: await inactiveStatuses() } },
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
// WHAT TASKS EXIST FOR EACH PERSON IN THE PERIOD (explains the numbers; never changes them)
// The report's own figures (completed, days with data, %, weighted score) are unchanged. This adds the task counts behind them and the reason a
// figure is missing, so "No task data available" is no longer used for different situations:
//   NO_TASKS             nothing was submitted or assigned in the period
//   AWAITING_APPROVAL    tasks exist but wait for their manager (a task counts only once approved)
//   NO_COMPLETION_TIME   approved tasks marked completed before completion times were recorded (they cannot be placed in a day)
//   NONE_COMPLETED       approved tasks exist, none finished (a real zero, shown as 0)
//   HAS_DATA             at least one counted completion
// Sources: employee-submitted tasks (the ones the report counts) and, separately, tasks a manager assigned (never mixed into the figures, never
// counted twice: they are different rows, kept out of every submitted-task query by activeTasks()). A manager's own self-managed tasks are excluded
// as everywhere. Waiting-for-approval counts obey the same visibility rule as the approval queue.
// ---------------------------------------------------------------------------------------------
export type TaskReason = "HAS_DATA" | "NO_TASKS" | "AWAITING_APPROVAL" | "NO_COMPLETION_TIME" | "NONE_COMPLETED";
export type TaskSummary = {
  inPeriod: number; approved: number; awaitingApproval: number; rejected: number;
  completedAwaitingApproval: number; completedWithoutTime: number; open: number; overdue: number;
  assigned: { total: number; open: number; awaitingConfirmation: number; confirmed: number };
};
export function taskReason(s: TaskSummary, completedTotal: number | null): TaskReason {
  if (completedTotal !== null && completedTotal > 0) return "HAS_DATA";
  if (completedTotal === 0) return "NONE_COMPLETED";
  if (s.awaitingApproval > 0) return "AWAITING_APPROVAL";
  if (s.completedWithoutTime > 0) return "NO_COMPLETION_TIME";
  return s.inPeriod === 0 && s.assigned.total === 0 ? "NO_TASKS" : "NO_TASKS";
}
const emptySummary = (): TaskSummary => ({ inPeriod: 0, approved: 0, awaitingApproval: 0, rejected: 0, completedAwaitingApproval: 0, completedWithoutTime: 0, open: 0, overdue: 0, assigned: { total: 0, open: 0, awaitingConfirmation: 0, confirmed: 0 } });

async function summariesFor(viewer: { id: string; role: unknown }, ids: string[], selfIds: string[], fromIso: string, toIso: string, today: string, startUtc: Date, endUtc: Date): Promise<Map<string, TaskSummary>> {
  const out = new Map<string, TaskSummary>(ids.map((i) => [i, emptySummary()]));
  const [rows, assigned] = await Promise.all([
    prisma.dailyTask.findMany({
      where: { userId: { in: ids }, id: { notIn: selfIds }, ...(await activeTasks()), status: { not: "CANCELLED" }, date: { gte: parseIsoDay(fromIso), lte: parseIsoDay(toIso) } },
      select: { id: true, userId: true, date: true, status: true, approvalStatus: true, completedAt: true },
    }),
    prisma.dailyTask.findMany({
      where: { userId: { in: ids }, ...(await activeAssigned()), assignedById: { not: null }, status: { not: "CANCELLED" }, date: { gte: parseIsoDay(fromIso), lte: parseIsoDay(toIso) } },
      select: { userId: true, status: true, reviewedAt: true },
    }).catch(() => [] as { userId: string; status: unknown; reviewedAt: Date | null }[]),
  ]);
  // who the waiting tasks were sent to (same rule as the approval queue: HR sees none, a manager only his own)
  const waitingIds = rows.filter((r) => String(r.approvalStatus) === "PENDING").map((r) => r.id);
  const tags = waitingIds.length ? await entryDetailsFor(waitingIds) : new Map();
  for (const r of rows) {
    const s = out.get(r.userId)!;
    const approval = String(r.approvalStatus), status = String(r.status);
    if (approval === "REJECTED") { s.rejected += 1; continue; }
    if (approval === "PENDING") {
      const tag = tags.get(r.id);
      const mine = !(tag?.taggedManagerId && tag.taggedManagerActive) || tag.taggedManagerId === viewer.id;
      if (!pendingTaskVisibleTo(String(viewer.role), mine)) continue;
      s.awaitingApproval += 1; s.inPeriod += 1;
      if (status === "COMPLETED") s.completedAwaitingApproval += 1;
      continue;
    }
    s.approved += 1; s.inPeriod += 1;
    if (status === "COMPLETED") { if (!r.completedAt) s.completedWithoutTime += 1; }
    else { s.open += 1; if (r.date.toISOString().slice(0, 10) < today) s.overdue += 1; }
  }
  void startUtc; void endUtc;
  for (const a of assigned) {
    const s = out.get(a.userId); if (!s) continue;
    s.assigned.total += 1;
    if (String(a.status) === "COMPLETED") { if (a.reviewedAt) s.assigned.confirmed += 1; else s.assigned.awaitingConfirmation += 1; }
    else s.assigned.open += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// PRODUCTIVITY OVER A RANGE (per person, per day)
// ---------------------------------------------------------------------------------------------
export async function getProductivity(viewerId: string, q: { from?: string; to?: string; userId?: string; teamId?: string; filters?: HrFilters; self?: boolean; raw?: boolean }) {
  const viewer = await getViewer(viewerId, q.self === true);
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
    activeTasks().then((live) => prisma.dailyTask.findMany({ where: { userId: { in: ids }, id: { notIn: selfIds }, ...COUNTED, ...live, completedAt: { gte: startUtc, lt: endUtc } }, select: { id: true, userId: true, completedAt: true, outcome: true } }).then(keepFullyDone)),
    activeTasks().then((live) => prisma.dailyTask.groupBy({ by: ["userId", "date"], where: { userId: { in: ids }, id: { notIn: selfIds }, approvalStatus: "APPROVED", ...live, date: { gte: parseIsoDay(fromIso), lte: parseIsoDay(toIso) } }, _count: { _all: true } })),
    activeTasks().then((live) => prisma.dailyTask.groupBy({ by: ["userId", "date"], where: { userId: { in: ids }, id: { notIn: selfIds }, approvalStatus: "APPROVED", status: "COMPLETED", completedAt: null, ...live, date: { gte: parseIsoDay(fromIso), lte: parseIsoDay(toIso) } }, _count: { _all: true } })),
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

  // Priority-weighted performance of each person's tasks dated inside the range (rules in tasks.weighted.ts, the same everywhere).
  const weightedRows = await prisma.dailyTask.findMany({
    where: { userId: { in: ids }, id: { notIn: selfIds }, ...(await activeTasks()), date: { gte: parseIsoDay(fromIso), lte: parseIsoDay(toIso) } },
    select: { id: true, userId: true, weight: true, status: true, approvalStatus: true, outcome: true, completedAt: true },
  });
  const weightedStars = await starsFor(weightedRows);
  const weightedRated = weightedRows.map((r) => ({ ...r, rating: weightedStars.get(r.id) ?? null }));
  const weightedBy = new Map<string, typeof weightedRated>();
  for (const r of weightedRated) { const l = weightedBy.get(r.userId) ?? []; l.push(r); weightedBy.set(r.userId, l); }
  const details = await projectsAndManagers(ids);
  // each person's tracked working time over the tasks dated in the period (tasks that ran at the same time are counted once)
  const trackedBy = await trackedSecondsByUser(weightedRows);
  const summaries = await summariesFor(viewer, ids, selfIds, fromIso, toIso, today, startUtc, endUtc);
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
      projects: details.get(p.id)?.projects ?? [], reportingManager: details.get(p.id)?.reportingManager ?? null,
      targetPerDay: t.perDay, targetSource: t.source,
      // setup state, kept apart from task data: a person with no team can still get a company default; only a person target needs nothing
      targetState: t.perDay === null ? "NOT_CONFIGURED" : t.perDay > 0 ? "CONFIGURED" : "ZERO",
      mappedToTeam: p.teamId !== null,
      daysWithData: dataDays,
      completedTotal: dataDays > 0 ? completedTotal : null,
      targetTotal,
      overallPercent: targetTotal && dataDays > 0 ? Math.round((completedTotal / targetTotal) * 1000) / 10 : null,
      weighted: weightedPerformance(weightedBy.get(p.id) ?? [], { cutoff: endUtc }),
      trackedSeconds: trackedBy.get(p.id)?.seconds ?? 0,
      trackedTasks: trackedBy.get(p.id)?.tasks ?? 0,
      tasks: summaries.get(p.id) ?? emptySummary(),
      reason: taskReason(summaries.get(p.id) ?? emptySummary(), dataDays > 0 ? completedTotal : null),
      days,
    };
  });

  // A manager's adjustments (evaluation.adjust.ts) are laid over the calculated figures for exactly this period; the calculated ones are kept beside them.
  const adj = q.raw ? new Map() : await adjustmentsFor(out.map((p) => p.userId), base.from, base.to);
  // Not Evaluated / Evaluated / Updated: has a manager saved an evaluation for this exact period, and more than once (raw = the calculation view, no overlay)
  const states = q.raw ? new Map() : await evaluationStatesFor(out.map((p) => p.userId), base.from, base.to);
  const noState = { state: "NOT_EVALUATED" as const, count: 0, lastAt: null, lastById: null, lastByName: null };
  const people2 = out.map((p) => {
    const a = adj.get(p.userId);
    const evalState = states.get(p.userId) ?? noState;
    if (!a) return { ...p, evaluation: null, evalState };
    return {
      ...p,
      evalState,
      weighted: overlayWeighted(p.weighted, a),
      overallPercent: a.productivity ?? p.overallPercent,
      evaluation: { adjusted: true, by: a.byId, at: a.at, reason: a.reason, original: { score: p.weighted.percent, status: p.weighted.status, productivity: p.overallPercent }, adjustedFields: { score: a.score !== null, status: a.status !== null, productivity: a.productivity !== null } },
    };
  });

  return { ...base, scope, targetsReady: targets.ready, weightedTotal: weightedPerformance(weightedRated, { cutoff: endUtc }), people: people2 };
}

// ---------------------------------------------------------------------------------------------
// THE TASKS BEHIND THE REPORT (for the Excel export)
// Same people as the report (scopedPeople: the viewer's authorised list narrowed by the filters, never widened), same range, same
// exclusions (a manager's own self-managed tasks are not team productivity). One row per task whose task DATE is in the range, plus any
// task COMPLETED in the range (that is how the report counts it, in the day it was finished). `counted` says whether the report counts the
// task: the SAME rule as getProductivity (completed, approved, finished inside the range, not rated below the "completed" threshold), so
// the number of counted rows equals the report's "Tasks completed" total.
// ---------------------------------------------------------------------------------------------
export async function getProductivityTasks(viewerId: string, q: { from?: string; to?: string; userId?: string; teamId?: string; filters?: HrFilters; self?: boolean }) {
  const viewer = await getViewer(viewerId, q.self === true);
  const tz = viewer.platform.timezone;
  const today = platformToday(tz).toISOString().slice(0, 10);
  const fromIso = q.from ? parseIsoDay(q.from).toISOString().slice(0, 10) : today;
  const toIsoRaw = q.to ? parseIsoDay(q.to).toISOString().slice(0, 10) : fromIso;
  if (toIsoRaw < fromIso) throw new Error("BAD_RANGE");
  const dayCount = (Date.parse(toIsoRaw) - Date.parse(fromIso)) / 86400000 + 1;
  if (dayCount > MAX_RANGE_DAYS) throw new Error("RANGE_TOO_LONG");
  const toIso = toIsoRaw > today ? today : toIsoRaw;
  const base = { generatedAt: new Date().toISOString(), timezone: tz, today, from: fromIso, to: toIso };

  const { people, scope } = await scopedPeople(viewer, q);
  if (people.length === 0 || toIso < fromIso) return { ...base, scope, tasks: [] as unknown[] };
  const ids = people.map((p) => p.id);
  const byPerson = new Map(people.map((p) => [p.id, p]));
  const startUtc = zonedToUtc(fromIso, "00:00", tz);
  const endUtc = zonedToUtc(addDays(toIso, 1), "00:00", tz);

  const selfIds = await selfManagedTaskIdsOf(ids);
  const rows = await prisma.dailyTask.findMany({
    where: {
      userId: { in: ids },
      id: { notIn: selfIds },
      ...(await activeTasks()),
      OR: [{ date: { gte: parseIsoDay(fromIso), lte: parseIsoDay(toIso) } }, { ...COUNTED, completedAt: { gte: startUtc, lt: endUtc } }],
    },
    select: { id: true, userId: true, title: true, description: true, weight: true, status: true, approvalStatus: true, outcome: true, date: true, completedAt: true, completionNote: true, rejectionNote: true, createdAt: true, team: { select: { name: true } } },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
  const taskIds = rows.map((r) => r.id);
  const timers = await timersFor(rows);
  const [details, people2, countedRows, ratings, lates] = await Promise.all([
    entryDetailsFor(taskIds),
    projectsAndManagers(ids),
    keepFullyDone(rows.filter((r) => String(r.status) === "COMPLETED" && String(r.approvalStatus) === "APPROVED" && r.completedAt && r.completedAt >= startUtc && r.completedAt < endUtc)),
    ratingsFor(rows), // the manager's saved star rating and comment per task (an old grade not yet converted reads through, as everywhere else)
    lateDetailsFor(taskIds), // tasks submitted for an earlier day: how late and why
  ]);
  const counted = new Set(countedRows.map((r) => r.id));

  const tasks = rows.filter((t) => {
    // Same visibility rule as the approval queue: a task still waiting for its manager is not shown to HR, nor to a manager it is not tagged to.
    if (String(t.approvalStatus) !== "PENDING") return true;
    const tag = details.get(t.id);
    const mine = !(tag?.taggedManagerId && tag.taggedManagerActive) || tag.taggedManagerId === viewer.id;
    return pendingTaskVisibleTo(String(viewer.role), mine);
  }).map((t) => {
    const p = byPerson.get(t.userId)!;
    const d = details.get(t.id);
    const status = String(t.status);
    return {
      id: t.id, userId: t.userId, employee: p.name, employeeCode: p.code,
      project: t.team?.name ?? null,
      reportingManager: people2.get(t.userId)?.reportingManager ?? null, // the person's permanent reporting manager
      taggedManager: d?.taggedManagerName ?? null, // the manager this task was sent to for approval
      title: t.title, description: t.description,
      date: t.date.toISOString().slice(0, 10),
      priority: String(t.weight),
      hoursSpent: d?.hoursSpent ?? null,
      progress: status === "CANCELLED" ? "CANCELLED" : progressOf(status, d?.blocked === true),
      // Why a Blocked task cannot go on (the employee's written reason); empty for every other progress.
      blockedReason: status !== "CANCELLED" && progressOf(status, d?.blocked === true) === "BLOCKED" ? d?.blockedNote ?? null : null,
      approvalStatus: String(t.approvalStatus),
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
      // The real moment the task was sent, and (only for a previous-day submission) how late it was and the reason given.
      submittedAt: t.createdAt.toISOString(),
      late: lates.get(t.id) ? { lateByDays: lates.get(t.id)!.lateByDays, outsideWindow: lates.get(t.id)!.outsideWindow, reason: lates.get(t.id)!.reason } : null,
      rating: ratings.get(t.id)?.rating ?? null,
      ratingComment: ratings.get(t.id)?.comment ?? null,
      completionNote: t.completionNote ?? null,
      rejectionNote: t.rejectionNote ?? null,
      counted: counted.has(t.id),
      // Automatic task time (a separate figure: it never feeds the Overall Performance Score). Older tasks read "Not tracked".
      timer: timers.get(t.id) ?? notTracked(),
      // Weighted score of this one task: its priority weight, the share earned (1, 0.5 or 0) and the points; blank when it is not scored (not approved / cancelled).
      // How this task takes part in the Overall Performance Score (same rules as the score itself; priority plays no part):
      //   inScore         eligible (approved, not cancelled, dated inside the period)
      //   scoreCompleted  completed as of the end of the period
      //   ratingStatus    RATED (the manager's stars) | PENDING_EVALUATION (completed, not rated yet) | NOT_APPLICABLE (not completed)
      ...(() => {
        const rating = ratings.get(t.id)?.rating ?? null;
        const inPeriod = t.date >= parseIsoDay(fromIso) && t.date <= parseIsoDay(toIso);
        const one = { ...t, rating };
        const eligible = inPeriod && weightedPerformance([one]).tasks === 1;
        const done = eligible && weightedPerformance([one], { cutoff: endUtc }).completed === 1;
        return { inScore: eligible, scoreCompleted: done, ratingStatus: done ? (rating !== null ? "RATED" : "PENDING_EVALUATION") : "NOT_APPLICABLE", partial: String(t.outcome ?? "") === "PARTIALLY_COMPLETED" };
      })(),
    };
  });
  return { ...base, scope, tasks };
}

// ---------------------------------------------------------------------------------------------
// ONE PERSON'S TASKS FOR THE DRILL-DOWN (click an employee in the report)
// The same authorised list as the report (scopedPeople; a person outside it answers NOT_FOUND). "submitted" = the tasks the report counts from
// (getProductivityTasks, same visibility rule for waiting tasks); "assigned" = tasks a manager assigned, shown apart and never added to the
// figures. Assigned tasks are visible to an Admin and to the manager who assigned them, nobody else (the assigned-task rule).
// ---------------------------------------------------------------------------------------------
export async function getPersonTasks(viewerId: string, q: { userId: string; from?: string; to?: string; filters?: HrFilters }) {
  const viewer = await getViewer(viewerId, false);
  const { people } = await scopedPeople(viewer, { userId: q.userId, filters: q.filters });
  const person = people.find((p) => p.id === q.userId);
  if (!person) throw new Error("NOT_FOUND");
  const submitted = await getProductivityTasks(viewerId, { from: q.from, to: q.to, userId: q.userId, filters: q.filters });
  const tz = viewer.platform.timezone;
  const from = parseIsoDay(submitted.from), to = parseIsoDay(submitted.to);
  const assigned = (await assignedTasksForReport(q.userId, from, to).catch(() => [])).filter((a) => String(viewer.role) === "ADMIN" || a.assignedById === viewer.id);
  return {
    from: submitted.from, to: submitted.to, timezone: tz, today: submitted.today,
    person: { id: person.id, name: person.name, employeeCode: person.code, teamName: person.teamName },
    submitted: (submitted.tasks as Record<string, unknown>[]),
    assigned,
  };
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
    where: { userId: { in: ids }, id: { notIn: selfIds }, ...COUNTED, ...(await activeTasks()), completedAt: { gte: zonedToUtc(day, "00:00", tz), lt: zonedToUtc(addDays(day, 1), "00:00", tz) } },
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

// The company a target screen works on: the one asked for, else the viewer's own. HR / Admin may use every company they act on (company access: own,
// assigned, or all), exactly like the report that lists those companies' people; anything else answers NOT_FOUND.
async function targetCompany(viewerId: string, companyId?: unknown) {
  const viewer = await getAdmin(viewerId);
  const access = await accessFor(viewerId);
  const id = typeof companyId === "string" && companyId ? companyId : viewer.platformId;
  assertCompany(access, id);
  const companies = await prisma.platform.findMany({ where: access.all ? {} : { id: { in: access.ids } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  return { viewer, platformId: id, companies };
}

export async function listTargets(viewerId: string, companyId?: unknown) {
  const { platformId, companies } = await targetCompany(viewerId, companyId);
  const viewer = { platformId };
  const [teams, people, t] = await Promise.all([
    prisma.team.findMany({ where: { platformId: viewer.platformId, isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({ where: { platformId: viewer.platformId, status: { notIn: await inactiveStatuses() } }, select: { id: true, firstName: true, lastName: true, employeeCode: true }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    loadTargets([viewer.platformId]),
  ]);
  return {
    ready: t.ready,
    companyId: platformId,
    companies,
    company: t.rows.find((r) => !r.teamId && !r.userId)?.tasksPerDay ?? null,
    teams: teams.map((x) => ({ teamId: x.id, name: x.name, tasksPerDay: t.rows.find((r) => r.teamId === x.id)?.tasksPerDay ?? null })),
    people: people.map((x) => ({ userId: x.id, name: `${x.firstName} ${x.lastName}`.trim(), employeeCode: x.employeeCode, tasksPerDay: t.rows.find((r) => r.userId === x.id)?.tasksPerDay ?? null })),
  };
}

// scope "company" | "team" | "user". tasksPerDay null removes that target.
export async function setTarget(viewerId: string, body: { scope?: unknown; id?: unknown; tasksPerDay?: unknown; companyId?: unknown }) {
  const target = await targetCompany(viewerId, body.companyId);
  const viewer = { id: target.viewer.id, platformId: target.platformId };
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
    return listTargets(viewerId, viewer.platformId);
  } catch (e) {
    if (isMissingTable(e)) throw new Error("TARGETS_NOT_READY");
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// WORK EFFICIENCY INDEX (policy EFFICIENCY_V1; the rules are in tasks/efficiency.logic.ts, this only reads the records)
// The same authorised people and filters as the productivity report. Reads only: nothing is stored, so the figure is recomputed from the records every time
// and every percentage can be reproduced from the breakdown. With `userId` the answer also carries the task lines and deletions behind the number.
// ---------------------------------------------------------------------------------------------
export async function getEfficiency(viewerId: string, q: { from?: string; to?: string; userId?: string; teamId?: string; filters?: HrFilters; self?: boolean }) {
  const viewer = await getViewer(viewerId, q.self === true);
  const tz = viewer.platform.timezone;
  const today = platformToday(tz).toISOString().slice(0, 10);
  const fromIso = q.from ? parseIsoDay(q.from).toISOString().slice(0, 10) : today;
  const toIsoRaw = q.to ? parseIsoDay(q.to).toISOString().slice(0, 10) : fromIso;
  if (toIsoRaw < fromIso) throw new Error("BAD_RANGE");
  if ((Date.parse(toIsoRaw) - Date.parse(fromIso)) / 86400000 + 1 > MAX_RANGE_DAYS) throw new Error("RANGE_TOO_LONG");
  const toIso = toIsoRaw > today ? today : toIsoRaw;
  const base = { generatedAt: new Date().toISOString(), timezone: tz, today, from: fromIso, to: toIso, version: EFFICIENCY_POLICY_VERSION };
  const { people, scope } = await scopedPeople(viewer, q);
  if (people.length === 0 || toIso < fromIso) return { ...base, scope, people: [] as unknown[] };
  const ids = people.map((p) => p.id);
  const startUtc = zonedToUtc(fromIso, "00:00", tz);
  const endUtc = zonedToUtc(addDays(toIso, 1), "00:00", tz);
  const cutoff = endUtc.getTime() - 1;
  const selfIds = await selfManagedTaskIdsOf(ids);

  const rows = await prisma.dailyTask.findMany({
    where: { userId: { in: ids }, id: { notIn: selfIds }, ...(await activeTasks()), approvalStatus: "APPROVED" as never, status: { not: "CANCELLED" as never }, date: { gte: parseIsoDay(fromIso), lte: parseIsoDay(toIso) } },
    select: { id: true, userId: true, title: true, status: true, outcome: true, date: true, completedAt: true },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
  const taskIds = rows.map((r) => r.id);
  const timers = await timersFor(rows);
  const [details, stars, evidence, deletions, attendance] = await Promise.all([
    entryDetailsFor(taskIds),
    starsFor(rows),
    readEvidence(taskIds),
    deletedTasksFor(ids, startUtc, endUtc, fromIso, toIso),
    attendanceFor(ids, fromIso, toIso),
  ]);
  const byUser = new Map<string, EfficiencyTask[]>();
  for (const r of rows) {
    const d = details.get(r.id);
    const tm = timers.get(r.id);
    const list = byUser.get(r.userId) ?? [];
    list.push({
      id: r.id, title: r.title, date: r.date.toISOString().slice(0, 10), status: String(r.status), outcome: r.outcome ? String(r.outcome) : null,
      completedAt: r.completedAt ? r.completedAt.getTime() : null, blocked: d?.blocked === true, blockedNote: d?.blockedNote ?? null,
      rating: stars.get(r.id) ?? null, qualityReverts: evidence.quality.get(r.id) ?? 0, requirementReverts: evidence.requirement.get(r.id) ?? 0,
      unclassifiedReverts: evidence.unclassified.get(r.id) ?? 0, partialPercent: evidence.partial.get(r.id)?.percent ?? null,
      actualSeconds: tm?.tracked ? tm.activeSeconds : null, expectedSeconds: evidence.expected.get(r.id) ?? null,
    });
    byUser.set(r.userId, list);
  }
  const detail = !!q.userId;
  const out = people.map((p) => {
    const e = efficiencyIndex({ tasks: byUser.get(p.id) ?? [], deletions: deletions.get(p.id) ?? [], attendance: attendance.get(p.id) ?? null, cutoff, cutoffDay: toIso });
    return { userId: p.id, name: p.name, employeeCode: p.code, teamName: p.teamName, efficiency: detail ? e : { ...e, lines: [], deletions: [] } };
  });
  return { ...base, scope, people: out };
}

/** Manager deletions (task_deletions) of these people's tasks that fall in the period, by the task's own day. Tolerates a missing table. */
async function deletedTasksFor(userIds: string[], _s: Date, _e: Date, fromIso: string, toIso: string) {
  const out = new Map<string, { id: string; title: string; reasonCode: string; reasonNote: string | null }[]>();
  if (!(await deletionsReady())) return out;
  const rows = await prisma.taskDeletion.findMany({
    where: { task: { userId: { in: userIds }, assignedById: null, date: { gte: parseIsoDay(fromIso), lte: parseIsoDay(toIso) } } },
    select: { id: true, reasonCode: true, reasonNote: true, task: { select: { userId: true, title: true } } },
  });
  for (const r of rows) {
    const list = out.get(r.task.userId) ?? [];
    list.push({ id: r.id, title: r.task.title, reasonCode: r.reasonCode, reasonNote: r.reasonNote });
    out.set(r.task.userId, list);
  }
  return out;
}

/** Credited and scheduled days from the one attendance engine (never recalculated here). Present = 1, half day = 0.5; absent counts as scheduled. */
async function attendanceFor(userIds: string[], fromIso: string, toIso: string) {
  const out = new Map<string, { scheduledDays: number; creditDays: number }>();
  const months: { y: number; m: number }[] = [];
  for (let d = new Date(`${fromIso.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= toIso; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
  for (const { y, m } of months) {
    const res = await getMonthAttendanceBulk(userIds, y, m).catch(() => []);
    for (const person of res) {
      const cur = out.get(person.userId) ?? { scheduledDays: 0, creditDays: 0 };
      for (const day of person.days) {
        if (day.date < fromIso || day.date > toIso) continue;
        if (day.status === "PRESENT") { cur.scheduledDays += 1; cur.creditDays += 1; }
        else if (day.status === "HALF_DAY") { cur.scheduledDays += 1; cur.creditDays += 0.5; }
        else if (day.status === "ABSENT") cur.scheduledDays += 1;
      }
      out.set(person.userId, cur);
    }
  }
  return out;
}
