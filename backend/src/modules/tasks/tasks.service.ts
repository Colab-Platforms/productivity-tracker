import { isLinkedManager, linkedReportIds } from "../../lib/reportingLinks.js";
import { emitTaskChange } from "../../lib/realtime.js";
import { taskNotice } from "./tasks.notify.js";
import { managedByWhere, isTeamManager } from "../../lib/teamManagers.js";
import { prisma } from "../../lib/prisma.js";
import { inPinnedCompany, onlyPinnedCompany } from "../../lib/deployment.js";
import { parseIsoDay, platformToday } from "../../lib/dates.js";
import { detailsFor, recordEvent, selfTasksReady, shapeSelf } from "./tasks.self.js";
import { auditNote } from "../../lib/auditContext.js";
import { accessFor, scopeWhere } from "../../lib/companyAccess.js";
import { resolvePeople } from "../hr-filters/hrFilters.service.js";
import { isFiltering, type HrFilters } from "../hr-filters/hrFilters.logic.js";
import { entryDetailsFor, entryFormChoices, entryReady, entryView, resolveTaggedManager, selectableProjects } from "./tasks.entry.js";
import { mayReview, pendingTaskVisibleTo, parseHours, parseProgress, storeProgress } from "./tasks.entry.logic.js";
import { REVERT_LABEL, REVERT_MARK_PREFIX, REVERT_TYPES, checkRemark, encodeRevertNote, reopenedView, revertBlock, type RevertType } from "./tasks.revert.logic.js";
import { checkComment, creditOf, parseRating } from "./tasks.rating.logic.js";
import { isRated, ratingReady, ratingsFor, withRatings } from "./tasks.rating.js";

// ---------------------------------------------------------------------------
// SCORING
// A task's worth is its weight. What it earns depends on the manager's star rating (1-5): stars / 5 of the weight
// (5 stars all of it, 3 stars 60%, 1 star 20%). A finished task not rated yet earns all of it.
// Nothing unapproved counts at all.
// ---------------------------------------------------------------------------
export const TASK_WEIGHTS: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 5,
};

const WEIGHTS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETED"];
const MANAGING_ROLES = ["MANAGER", "HR", "ADMIN"];

async function userContext(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { platform: true },
  });
  if (!user) throw new Error("USER_NOT_FOUND");
  return {
    user,
    platformId: user.platformId,
    timezone: user.platform.timezone,
    role: String(user.role),
  };
}

// ---------------------------------------------------------------------------
// WHO MAY ACT ON A TASK
//
// The task's PROJECT decides. Priya can be on Sales CRM under Neha and on
// AI Tools under Rahul — a Sales CRM task goes to Neha, an AI Tools task to
// Rahul. Without this, one of them would be grading work they never set.
//
// Falls back to the reporting line for tasks with no project, and Admin/HR
// cover their own company.
// ---------------------------------------------------------------------------
// APPROVING or REJECTING a task (`strict`): a task tagged to an active manager can be answered by THAT manager only. Otherwise (no tag, or the
// tagged person can no longer sign in) the earlier rule applies: the task's project/team manager or the person's reporting line. HR and Admin
// can SEE every task but are not approvers by their role.
// Grading the finished work and reopening it (not strict) keep their earlier permissions: the tagged manager, the earlier rule, and HR/Admin of
// the company.
async function assertCanReviewTask(
  actor: { id: string; role: string; platformId: string },
  task: { id: string; userId: string; teamId: string | null },
  strict = false
) {
  if (!(await inPinnedCompany(task.userId))) throw new Error("NOT_YOUR_TEAM");
  const detail = (await entryDetailsFor([task.id])).get(task.id);
  const tagged = detail?.taggedManagerId ?? null;
  const taggedActive = detail?.taggedManagerActive ?? false;
  if (strict) {
    // HR never decides a task, whatever the reporting line says (HR monitors; the tagged manager decides).
    if (actor.role === "HR") throw new Error("NOT_YOUR_TEAM");
    const legacyOk = tagged && taggedActive ? false : await legacyMayReview(actor, task);
    if (!mayReview({ actorId: actor.id, taggedId: tagged, taggedActive, legacyOk })) throw new Error("NOT_YOUR_TEAM");
    return;
  }
  if (tagged && taggedActive && tagged === actor.id) return;
  if (await legacyMayReview(actor, task)) return;
  if (actor.role === "ADMIN" || actor.role === "HR") {
    const owner = await prisma.user.findUnique({ where: { id: task.userId }, select: { platformId: true } });
    if (owner && owner.platformId === actor.platformId) return;
  }
  throw new Error("NOT_YOUR_TEAM");
}

async function legacyMayReview(actor: { id: string }, task: { userId: string; teamId: string | null }): Promise<boolean> {
  if (task.teamId && (await isTeamManager(actor.id, task.teamId))) return true;

  // Anyone who manages ANY active team the person is on (primary manager or co-manager) can review their work.
  // The approval queue and the notifications already go to all of them; the check has to agree, or a manager sees a
  // task in the queue and is then refused ("That person isn't in your team") because the task was tagged to another team.
  const sharedTeam = await prisma.teamMember.findFirst({
    where: { userId: task.userId, isActive: true, team: { ...(await managedByWhere(actor.id)), isActive: true } },
    select: { id: true },
  });
  if (sharedTeam) return true;

  const target = await prisma.user.findUnique({ where: { id: task.userId }, select: { reportsToId: true } });
  return (!!target && target.reportsToId === actor.id) || (await isLinkedManager(actor.id, task.userId));
}

// For assigning NEW work, where there is no task to read a project from.
async function assertCanManage(
  actor: { id: string; role: string; platformId: string },
  targetUserId: string
) {
  if (!(await inPinnedCompany(targetUserId))) throw new Error("NOT_YOUR_TEAM");
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { platformId: true, reportsToId: true },
  });
  if (!target) throw new Error("NOT_YOUR_TEAM");

  if (target.reportsToId === actor.id || (await isLinkedManager(actor.id, targetUserId))) return;
  if (
    (actor.role === "ADMIN" || actor.role === "HR") &&
    target.platformId === actor.platformId
  ) {
    return;
  }

  // Or they share a project this manager runs.
  const shared = await prisma.teamMember.findFirst({
    where: {
      userId: targetUserId,
      isActive: true,
      team: { ...(await managedByWhere(actor.id)), isActive: true },
    },
    select: { id: true },
  });
  if (shared) return;

  throw new Error("NOT_YOUR_TEAM");
}

// The people this person actually manages: everyone on the teams they run plus their direct reports. (Not the company-wide list HR/Admin
// are shown: those are people they can SEE, not people whose tasks they review.)
export async function actingUserIds(actor: { id: string }): Promise<Set<string>> {
  const [managedTeams, reports, linked] = await Promise.all([
    prisma.team.findMany({
      where: { ...(await managedByWhere(actor.id)), isActive: true },
      select: { members: { where: { isActive: true }, select: { userId: true } } },
    }),
    prisma.user.findMany({ where: { reportsToId: actor.id }, select: { id: true } }),
    linkedReportIds(actor.id),
  ]);
  return new Set<string>([...managedTeams.flatMap((t) => t.members.map((m) => m.userId)), ...reports.map((r) => r.id), ...linked]);
}

export async function manageableUserIds(actor: {
  id: string;
  role: string;
  platformId: string;
}): Promise<string[]> {
  // Everyone on the teams they run, plus their direct reports. Both can cross
  // companies - at Avatar one person heads teams in several of them.
  const [managedTeams, reports, linked] = await Promise.all([
    prisma.team.findMany({
      where: { ...(await managedByWhere(actor.id)), isActive: true },
      select: {
        members: { where: { isActive: true }, select: { userId: true } },
      },
    }),
    prisma.user.findMany({
      where: { reportsToId: actor.id },
      select: { id: true },
    }),
    linkedReportIds(actor.id),
  ]);

  const ids = new Set<string>([
    ...managedTeams.flatMap((t) => t.members.map((m) => m.userId)),
    ...reports.map((r) => r.id),
    ...linked,
  ]);

  // An admin or HR also sees every company they act on (company access: their own, the ones assigned to them, or all for top management; a
  // deployment pinned to one company allows only that one). This is VIEWING: approving or rejecting still belongs to the tagged manager only.
  // Note ADDED to the two lists above, not substituted for them: substituting meant an admin of one company could not approve for a team they
  // personally run in another, so tasks submitted to them sat in nobody's queue and silently expired.
  if (actor.role === "ADMIN" || actor.role === "HR") {
    const all = await prisma.user.findMany({
      where: {
        ...scopeWhere(await accessFor(actor.id)),
        status: { in: ["ACTIVE", "INVITED"] },
      },
      select: { id: true },
    });
    for (const u of all) ids.add(u.id);
  }

  return onlyPinnedCompany(Array.from(ids));
}

async function myProjects(userId: string) {
  const rows = await prisma.teamMember.findMany({
    where: { userId, isActive: true, team: { isActive: true } },
    select: {
      isPrimary: true,
      team: {
        select: {
          id: true,
          name: true,
          platform: { select: { name: true } },
          manager: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  return rows.map((r) => ({
    id: r.team.id,
    name: r.team.name,
    company: r.team.platform?.name ?? null,
    manager: r.team.manager
      ? `${r.team.manager.firstName} ${r.team.manager.lastName}`.trim()
      : null,
    isPrimary: r.isPrimary,
  }));
}

// ---------------------------------------------------------------------------
// The row the frontend receives. A constrained generic, NOT
// Record<string, unknown> — spreading a Record loses every field from the
// result type.
// ---------------------------------------------------------------------------
function shape<
  T extends {
    id: string;
    title: string;
    description: string | null;
    weight: string;
    status: string;
    approvalStatus: string;
    outcome: string | null;
    rating: number | null;
    ratingComment: string | null;
    rejectionNote: string | null;
    reviewNote: string | null;
    completionNote: string | null;
    assignedById: string | null;
    teamId: string | null;
    date: Date;
  }
>(t: T, projectName?: string | null) {
  // The old grade is not sent any more: the star rating replaced it.
  const { outcome: _oldGrade, ...rest } = t;
  void _oldGrade;
  return {
    ...rest,
    date: t.date.toISOString().slice(0, 10),
    weightValue: TASK_WEIGHTS[String(t.weight)] ?? 1,
    assigned: t.assignedById !== null,
    project: projectName ?? null,
    projectId: t.teamId,
    // Set when a manager sent this task back (Partially / Not fully completed): the kind, the remark, and whether it was finished again.
    reopened: reopenedView({ status: String(t.status), outcome: t.rating != null ? "RATED" : null, reviewNote: t.reviewNote }),
  };
}

type Scorable = {
  weight: string;
  status: string;
  approvalStatus: string;
  rating: number | null;
};

export function scoreOf(tasks: Scorable[]) {
  const approved = tasks.filter((t) => String(t.approvalStatus) === "APPROVED");

  const totalWeight = approved.reduce(
    (n, t) => n + (TASK_WEIGHTS[String(t.weight)] ?? 1),
    0
  );

  const doneWeight = approved.reduce((n, t) => {
    const w = TASK_WEIGHTS[String(t.weight)] ?? 1;
    if (t.rating != null) return n + w * creditOf(t.rating);
    if (String(t.status) === "COMPLETED") return n + w;
    return n;
  }, 0);

  return {
    total: approved.length,
    done: approved.filter((t) => String(t.status) === "COMPLETED").length,
    totalWeight,
    doneWeight,
    percent:
      totalWeight === 0 ? 0 : Math.round((doneWeight / totalWeight) * 100),
  };
}

// ---------------------------------------------------------------------------
// EMPLOYEE SIDE
// Every mutation returns the WHOLE refreshed day, because the page replaces
// its state with the response.
// ---------------------------------------------------------------------------
export async function listTasks(userId: string) {
  const ctx = await userContext(userId);
  const date = platformToday(ctx.timezone);

  const [rawRows, projects] = await Promise.all([
    prisma.dailyTask.findMany({
      where: { userId, date },
      include: { team: { select: { name: true } } },
      orderBy: { title: "asc" },
    }),
    myProjects(userId),
  ]);
  const rows = await withRatings(rawRows);

  // A task a manager reopened keeps its original day, which may be earlier than today, but it is unfinished work again: it is shown with
  // the rest of the person's working tasks, flagged with the day it came from. It does not change today's score.
  const reopenedOld = await withRatings(await prisma.dailyTask.findMany({
    where: { userId, approvalStatus: "APPROVED", status: { in: ["PENDING", "IN_PROGRESS"] }, outcome: null, date: { lt: date }, reviewNote: { startsWith: REVERT_MARK_PREFIX } },
    include: { team: { select: { name: true } } },
    orderBy: { date: "asc" },
  }));
  const selfDetails = await detailsFor(rows.map((r) => r.id));
  const entries = await entryDetailsFor(rows.map((r) => r.id));
  const nowForSelf = new Date();
  const tasks = rows.map((t) => ({ ...shape(t, t.team?.name ?? null), ...shapeSelf(selfDetails.get(t.id), String(t.status), nowForSelf, ctx.timezone), ...entryView(String(t.status), entries.get(t.id)) }));
  // True for a manager once the self-managed tables exist: his own tasks need no approval.
  const selfManagedMode = ctx.role === "MANAGER" && (await selfTasksReady());

  const working = [
    ...reopenedOld.map((t) => ({ ...shape(t, t.team?.name ?? null), selfManaged: false as const, fromEarlierDay: true })),
    ...tasks.filter((t) => t.approvalStatus === "APPROVED" && t.status !== "COMPLETED").map((t) => ({ ...t, fromEarlierDay: false })),
  ];
  const awaiting = tasks.filter((t) => t.approvalStatus === "PENDING");
  const score = scoreOf(rows);

  // Per-project totals, so somebody on two projects can see where their day
  // actually went.
  const byProject = projects.map((p) => {
    const mine = rows.filter((t) => t.teamId === p.id);
    return { ...p, taskCount: mine.length, score: scoreOf(mine) };
  });

  // The new entry form (hours, progress, tagged manager). Not offered to a manager's own self-managed tasks.
  const entryReadyNow = !selfManagedMode && (await entryReady());
  const entryForm = entryReadyNow ? { ready: true, ...(await entryFormChoices(userId, ctx.platformId)) } : { ready: false, projects: [], managers: [] };

  return {
    date: date.toISOString().slice(0, 10),
    entryForm,
    selfApproves: selfManagedMode || (!ctx.user.reportsToId && entryForm.managers.length === 0),
    selfManagedMode,
    score,
    scorePercent: score.percent,
    projects,
    byProject,
    awaitingApproval: awaiting,
    pending: awaiting,
    rejected: tasks.filter((t) => t.approvalStatus === "REJECTED"),
    active: working,
    working,
    todays: working,
    inProgress: working,
    done: tasks.filter(
      (t) => t.approvalStatus === "APPROVED" && t.status === "COMPLETED"
    ),
    tasks,
  };
}

// One earlier (or later) day of the person's OWN tasks, for My History. Read-only; nothing is recomputed.
export async function listMyDay(userId: string, day: unknown) {
  const date = parseIsoDay(day);
  const rows = await withRatings(await prisma.dailyTask.findMany({
    where: { userId, date },
    include: { team: { select: { name: true } } },
    orderBy: { title: "asc" },
  }));
  return {
    date: date.toISOString().slice(0, 10),
    score: scoreOf(rows),
    tasks: rows.map((t) => shape(t, t.team?.name ?? null)),
  };
}

// The person's own tasks over a date range (newest day first), for the Daily Tasks date filter. Read-only, own data only, max 93 days.
export async function listMyRange(userId: string, from: unknown, to: unknown) {
  const start = parseIsoDay(from);
  const end = parseIsoDay(to);
  if (end.getTime() < start.getTime()) throw new Error("BAD_RANGE");
  if ((end.getTime() - start.getTime()) / 86400000 > 92) throw new Error("RANGE_TOO_LONG");
  const rows = await withRatings(await prisma.dailyTask.findMany({
    where: { userId, date: { gte: start, lte: end } },
    include: { team: { select: { name: true } } },
    orderBy: [{ date: "desc" }, { title: "asc" }],
  }));
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
    score: scoreOf(rows),
    tasks: rows.map((t) => shape(t, t.team?.name ?? null)),
  };
}

// Resolves the project for a new task and refuses one the person isn't on.
async function resolveProject(
  userId: string,
  given: unknown,
  required = false,
  platformId: string | null = null
): Promise<string | null> {
  // The daily task entry form offers ALL active projects of the person's company (platformId given); other callers keep "own projects only".
  const projects = platformId ? (await selectableProjects({ id: userId, platformId })).map((p) => ({ ...p, isPrimary: false })) : await myProjects(userId);
  if (projects.length === 0) return null;

  const wanted = given ? String(given) : "";
  if (wanted) {
    if (!projects.some((p) => p.id === wanted)) throw new Error("NOT_MY_PROJECT");
    return wanted;
  }
  // The daily task form requires an explicit project whenever the person has any (a person with none is not blocked).
  if (required) throw new Error("PROJECT_REQUIRED");

  // Not chosen: fall back to the primary project, or the only one they have.
  const primary = projects.find((p) => p.isPrimary);
  if (primary) return primary.id;
  return projects.length === 1 ? projects[0].id : null;
}

export async function proposeTask(userId: string, body: Record<string, unknown>) {
  const ctx = await userContext(userId);

  const title = String(body.title ?? "").trim();
  if (!title) throw new Error("TITLE_REQUIRED");
  if (title.length > 200) throw new Error("TITLE_TOO_LONG");

  const description = body.description
    ? String(body.description).trim().slice(0, 2000)
    : null;

  const weightIn = String(body.weight ?? "MEDIUM");
  const weight = WEIGHTS.includes(weightIn) ? weightIn : "MEDIUM";

  const date = platformToday(ctx.timezone);
  // A MANAGER's own tasks are self-managed: approved when created, no approval step, nobody notified, no review queue. (Employee
  // tasks keep the approval workflow. Before the migration nothing is self-managed and a manager's task waits as it always did.)
  const selfManaged = ctx.role === "MANAGER" && (await selfTasksReady());

  // Daily task entry (hours, progress, tagged manager) once its table exists; a manager's own self-managed tasks use none of it.
  const entry = !selfManaged && (await entryReady());
  const teamId = await resolveProject(userId, body.teamId ?? body.projectId ?? null, entry, entry ? ctx.platformId : null);
  let progress: ReturnType<typeof parseProgress> = null;
  let hours: ReturnType<typeof parseHours> = null;
  let taggedManagerId: string | null = null;
  if (entry) {
    progress = parseProgress(body.progress);
    if (progress === "BAD") throw new Error("BAD_PROGRESS");
    hours = parseHours(body.hoursSpent);
    if (hours === "BAD") throw new Error("BAD_HOURS");
    taggedManagerId = await resolveTaggedManager({ id: userId, platformId: ctx.platformId }, body.taggedManagerId);
  }
  const stored = progress ? storeProgress(progress) : null;
  // Self-approval only when nobody can approve: no tagged manager AND no reporting manager. A task tagged to a manager always waits for
  // THAT manager, even when the employee has no reporting manager set.
  const selfApprove = selfManaged || (!ctx.user.reportsToId && !taggedManagerId);

  let due: Date | null = null;
  if (selfManaged && body.dueDate !== undefined && body.dueDate !== null && body.dueDate !== "") {
    due = parseIsoDay(body.dueDate);
    if (due.getTime() < date.getTime()) throw new Error("DUE_IN_PAST");
  }

  const created = await prisma.$transaction(async (tx) => {
    const t = await tx.dailyTask.create({
      data: {
        platformId: ctx.platformId,
        userId,
        date,
        title,
        description,
        teamId,
        weight: weight as never,
        status: (stored ? stored.status : "PENDING") as never,
        completedAt: stored?.status === "COMPLETED" ? new Date() : null,
        approvalStatus: (selfApprove ? "APPROVED" : "PENDING") as never,
        approvedById: selfApprove ? userId : null,
        approvedAt: selfApprove ? new Date() : null,
      },
      select: { id: true },
    });
    if (entry && (stored || hours !== null || taggedManagerId)) {
      await tx.taskEntryDetail.create({
        data: { taskId: t.id, platformId: ctx.platformId, hoursSpent: typeof hours === "number" ? hours : null, taggedManagerId, blocked: stored?.blocked === true, blockedNote: stored?.blocked && body.blockedNote ? String(body.blockedNote).trim().slice(0, 500) : null },
      });
    }
    if (selfManaged) await tx.taskSelfDetail.create({ data: { taskId: t.id, platformId: ctx.platformId, userId, dueDate: due } });
    return t;
  });
  if (selfManaged) await recordEvent({ taskId: created.id, platformId: ctx.platformId, actorId: userId, kind: "CREATED", note: due ? `Due ${due.toISOString().slice(0, 10)}` : null });
  emitTaskChange({ taskId: created.id, ownerId: userId, action: "created" }); // after the write succeeded
  if (!selfApprove) await taskNotice("proposed", created.id, userId);

  return listTasks(userId);
}

export async function updateMyTask(
  userId: string,
  taskId: string,
  body: Record<string, unknown>
) {
  const task = await prisma.dailyTask.findUnique({ where: { id: taskId } });
  if (!task || task.userId !== userId) throw new Error("NOT_FOUND");

  const sd = (await detailsFor([taskId])).get(taskId);
  const selfManaged = !!sd;
  const detailPatch: { startedAt?: Date; dueDate?: Date | null } = {};
  const events: { kind: "STARTED" | "COMPLETED" | "REOPENED" | "EDITED" | "UPDATE"; note?: string }[] = [];

  const data: Record<string, unknown> = {};

  if (body.status !== undefined) {
    const status = String(body.status);
    if (!STATUSES.includes(status)) throw new Error("BAD_STATUS");
    if (String(task.approvalStatus) !== "APPROVED") {
      throw new Error("NOT_APPROVED_YET");
    }
    if (await isRated(task)) throw new Error("ALREADY_REVIEWED");
    // Forgot to tick it on the day: allowed later, but only up to 30 days back.
    if (status === "COMPLETED" && String(task.status) !== "COMPLETED") {
      const ctx = await userContext(userId);
      const ageDays = Math.round((platformToday(ctx.timezone).getTime() - task.date.getTime()) / 86400000);
      if (ageDays > 30) throw new Error("TASK_TOO_OLD");
    }
    data.status = status as never;
    // Productivity is counted in the hour a task was actually finished, so the moment is recorded.
    // Moving it back out of COMPLETED (before a manager reviews it) clears it again.
    if (status === "COMPLETED" && String(task.status) !== "COMPLETED") data.completedAt = new Date();
    if (status !== "COMPLETED" && String(task.status) === "COMPLETED") data.completedAt = null;
    if (selfManaged) {
      // The start time is set once, the first time the manager marks it In Progress (or completes it straight from Not Started).
      if ((status === "IN_PROGRESS" || status === "COMPLETED") && !sd!.startedAt) {
        detailPatch.startedAt = new Date();
        events.push({ kind: "STARTED" });
      }
      if (status === "COMPLETED" && String(task.status) !== "COMPLETED") events.push({ kind: "COMPLETED" });
      if (status !== "COMPLETED" && String(task.status) === "COMPLETED") events.push({ kind: "REOPENED" });
    }
  }

  // Progress (Completed / In Progress / Blocked), hours spent and the blocked note. Progress is NOT approval: it can change while the
  // approval is still pending, and never touches the approval. Not for a manager's own self-managed task.
  let entryPatch: { hoursSpent?: number | null; blocked?: boolean; blockedNote?: string | null; taggedManagerId?: string | null } | null = null;
  if (body.progress !== undefined || body.hoursSpent !== undefined || body.blockedNote !== undefined) {
    if (selfManaged) throw new Error("SELF_MANAGED_ONLY");
    if (!(await entryReady())) throw new Error("FEATURES_NOT_READY");
    if (await isRated(task)) throw new Error("ALREADY_REVIEWED");
    entryPatch = {};
    if (body.progress !== undefined) {
      const pr = parseProgress(body.progress);
      if (pr === null || pr === "BAD") throw new Error("BAD_PROGRESS");
      const st = storeProgress(pr);
      data.status = st.status as never;
      if (st.status === "COMPLETED" && String(task.status) !== "COMPLETED") data.completedAt = new Date();
      if (st.status !== "COMPLETED" && String(task.status) === "COMPLETED") data.completedAt = null;
      entryPatch.blocked = st.blocked;
      if (!st.blocked) entryPatch.blockedNote = null;
    }
    if (body.hoursSpent !== undefined) {
      const h = parseHours(body.hoursSpent);
      if (h === "BAD") throw new Error("BAD_HOURS");
      entryPatch.hoursSpent = h;
    }
    if (body.blockedNote !== undefined) entryPatch.blockedNote = body.blockedNote ? String(body.blockedNote).trim().slice(0, 500) : null;
  }

  if (body.dueDate !== undefined) {
    if (!selfManaged) throw new Error("SELF_MANAGED_ONLY");
    const next = body.dueDate === null || body.dueDate === "" ? null : parseIsoDay(body.dueDate);
    if ((next?.getTime() ?? null) !== (sd!.dueDate?.getTime() ?? null)) {
      detailPatch.dueDate = next;
      events.push({ kind: "EDITED", note: next ? `Deadline set to ${next.toISOString().slice(0, 10)}` : "Deadline removed" });
    }
  }

  let workUpdate: string | null = null;
  if (body.workUpdate !== undefined && body.workUpdate !== null && String(body.workUpdate).trim() !== "") {
    if (!selfManaged) throw new Error("SELF_MANAGED_ONLY");
    workUpdate = String(body.workUpdate).trim().slice(0, 1000);
    events.push({ kind: "UPDATE", note: workUpdate });
  }

  if (body.completionNote !== undefined) {
    data.completionNote = body.completionNote
      ? String(body.completionNote).trim().slice(0, 2000)
      : null;
  }

  // Editing the task itself — only while it isn't live work yet.
  if (
    body.title !== undefined ||
    body.description !== undefined ||
    body.weight !== undefined ||
    body.teamId !== undefined ||
    body.projectId !== undefined
  ) {
    // Approved work can't be edited, EXCEPT a manager's own task: it is his, and he may keep it up to date.
    if (String(task.approvalStatus) === "APPROVED" && !selfManaged) {
      throw new Error("APPROVED_CANNOT_EDIT");
    }
    if (selfManaged) {
      const changed = ["title", "description", "weight"].filter((k) => (body as Record<string, unknown>)[k] !== undefined);
      if (changed.length) events.push({ kind: "EDITED", note: `Changed ${changed.join(", ")}` });
    }

    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) throw new Error("TITLE_REQUIRED");
      if (title.length > 200) throw new Error("TITLE_TOO_LONG");
      data.title = title;
    }
    if (body.description !== undefined) {
      data.description = body.description
        ? String(body.description).trim().slice(0, 2000)
        : null;
    }
    if (body.weight !== undefined) {
      const weight = String(body.weight);
      if (!WEIGHTS.includes(weight)) throw new Error("BAD_WEIGHT");
      data.weight = weight as never;
    }
    if (body.teamId !== undefined || body.projectId !== undefined) {
      data.teamId = await resolveProject(
        userId,
        body.teamId ?? body.projectId ?? null,
        false,
        !selfManaged && (await entryReady()) ? task.platformId : null
      );
    }

    // A sent-back task that gets edited goes straight back for approval.
    if (String(task.approvalStatus) === "REJECTED") {
      data.approvalStatus = "PENDING" as never;
      data.rejectionNote = null;
      data.approvedById = null;
      data.approvedAt = null;
    }
  }

  if (Object.keys(data).length === 0 && Object.keys(detailPatch).length === 0 && !workUpdate && !entryPatch) throw new Error("NOTHING_TO_UPDATE");

  if (Object.keys(data).length > 0 || Object.keys(detailPatch).length > 0 || entryPatch) {
    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) await tx.dailyTask.update({ where: { id: taskId }, data: data as never });
      if (entryPatch) {
        await tx.taskEntryDetail.upsert({
          where: { taskId },
          update: entryPatch,
          create: { taskId, platformId: task.platformId, hoursSpent: entryPatch.hoursSpent ?? null, taggedManagerId: entryPatch.taggedManagerId ?? null, blocked: entryPatch.blocked === true, blockedNote: entryPatch.blockedNote ?? null },
        });
      }
      if (selfManaged && Object.keys(detailPatch).length > 0) await tx.taskSelfDetail.update({ where: { taskId }, data: detailPatch });
    });
  }
  for (const e of events) await recordEvent({ taskId, platformId: task.platformId, actorId: userId, kind: e.kind, note: e.note ?? null });
  emitTaskChange({ taskId, ownerId: userId, action: body.status !== undefined ? "status" : "updated" });
  // A manager's own completed task is not "submitted" to anyone: there is nobody to review it.
  const finishedNow = String(data.status ?? "") === "COMPLETED" && String(task.status) !== "COMPLETED";
  if (!selfManaged && finishedNow && (body.status !== undefined || String(task.approvalStatus) === "APPROVED")) await taskNotice("submitted", taskId, userId);

  return listTasks(userId);
}

export async function deleteMyTask(userId: string, taskId: string) {
  const task = await prisma.dailyTask.findUnique({ where: { id: taskId } });
  if (!task || task.userId !== userId) throw new Error("NOT_FOUND");

  if (task.assignedById) throw new Error("ASSIGNED_CANNOT_DELETE");
  if (await isRated(task)) throw new Error("ALREADY_REVIEWED");
  if (
    String(task.approvalStatus) === "APPROVED" &&
    String(task.status) !== "PENDING"
  ) {
    throw new Error("ALREADY_STARTED");
  }

  await prisma.dailyTask.delete({ where: { id: taskId } });
  emitTaskChange({ taskId, ownerId: userId, action: "deleted" });
  return listTasks(userId);
}

// ---------------------------------------------------------------------------
// MANAGER SIDE
// ---------------------------------------------------------------------------
export async function listForApproval(
  managerId: string,
  range?: { from?: string; to?: string },
  filters?: HrFilters
) {
  const ctx = await userContext(managerId);
  if (!MANAGING_ROLES.includes(ctx.role)) throw new Error("NOT_ALLOWED");

  const actor = { id: managerId, role: ctx.role, platformId: ctx.platformId };
  const date = platformToday(ctx.timezone);
  const dateStr = date.toISOString().slice(0, 10);

  // Default view is today plus anything still pending from earlier days, so
  // nothing quietly ages out. Give a range and you get exactly that range -
  // which is what "show me last week, for this person" needs.
  const asUtcDay = (s?: string) => (s ? parseIsoDay(s) : undefined);
  const fromDate = asUtcDay(range?.from);
  const toDate = asUtcDay(range?.to);

  const dateFilter =
    fromDate || toDate
      ? {
          date: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          },
        }
      : {
          OR: [
            { date },
            {
              approvalStatus: "PENDING" as const,
              date: {
                lt: date,
                gte: new Date(date.getTime() - 30 * 24 * 60 * 60 * 1000),
              },
            },
          ],
        };
  // Everyone this person may see, and (HR/Admin filters: company, project, reporting manager) the ones who pass the filters. The filters only
  // narrow the authorised list, never widen it; the people, the task counts and the rows below all come from the same narrowed list.
  const allIds = await manageableUserIds(actor);
  let userIds = allIds;
  if (filters && isFiltering(filters)) {
    const keep = new Set((await resolvePeople(managerId, filters)).ids);
    userIds = allIds.filter((id) => keep.has(id));
  }
  const scope = { orgTotal: allIds.length, filteredTotal: userIds.length };

  // The employee picks the approver freely, so a task can be tagged to a manager OUTSIDE the usual team of that employee. Those tasks (and
  // only those) must reach the tagged manager's queue; the employee's other tasks stay invisible to him. Not applied while HR/Admin filters
  // are active (filters only narrow the authorised list).
  let extraTaskIds: string[] = [];
  let extraOwnerIds: string[] = [];
  if (!(filters && isFiltering(filters)) && (await entryReady())) {
    const tagged = await prisma.taskEntryDetail.findMany({ where: { taggedManagerId: managerId }, select: { taskId: true } });
    if (tagged.length > 0) {
      const outside = await prisma.dailyTask.findMany({
        where: { AND: [{ id: { in: tagged.map((t) => t.taskId) } }, { userId: { notIn: userIds } }, dateFilter] },
        select: { id: true, userId: true },
      });
      extraTaskIds = outside.map((r) => r.id);
      extraOwnerIds = [...new Set(outside.map((r) => r.userId))];
    }
  }
  if (userIds.length === 0 && extraOwnerIds.length === 0) {
    return {
      date: dateStr,
      scope,
      teamSize: 0,
      members: [],
      people: [],
      team: [],
      projects: [],
      proposals: [],
      awaitingApproval: [],
      toReview: [],
      grading: [],
      toGrade: [],
      recent: [],
      all: [],
    };
  }

  const [people, rawRows, managedProjects] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: [...userIds, ...extraOwnerIds] } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        employeeCode: true,
        designation: true,
        platform: { select: { name: true } },
        teamMemberships: {
          where: { isActive: true },
          select: { team: { select: { id: true, name: true } } },
        },
      },
      orderBy: { firstName: "asc" },
    }),
    prisma.dailyTask.findMany({
      where: {
        OR: [{ AND: [{ userId: { in: userIds } }, dateFilter] }, { id: { in: extraTaskIds } }],
      },
      include: {
        team: { select: { id: true, name: true } },
        user: {
          select: {
            firstName: true,
            lastName: true,
            employeeCode: true,
            platform: { select: { name: true } },
          },
        },
      },
      orderBy: { title: "asc" },
    }),
    prisma.team.findMany({
      where:
        ctx.role === "MANAGER"
          ? { ...(await managedByWhere(managerId)), isActive: true }
          : { ...scopeWhere(await accessFor(managerId)), isActive: true },
      select: { id: true, name: true, platform: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
  ]);

  // A manager's own tasks are self-managed: nobody reviews or grades them, so they never appear in anyone's queue.
  const selfIds = new Set((await detailsFor(rawRows.map((r) => r.id))).keys());
  const rows = rawRows.filter((r) => !selfIds.has(r.id));

  const [entries, acting, ratedRows] = await Promise.all([entryDetailsFor(rows.map((r) => r.id)), actingUserIds(actor), withRatings(rows)]);
  const deciderIds = [...new Set(ratedRows.map((t) => t.approvedById).filter((x): x is string => !!x))];
  const deciders = new Map(
    (deciderIds.length ? await prisma.user.findMany({ where: { id: { in: deciderIds } }, select: { id: true, firstName: true, lastName: true } }) : []).map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()])
  );
  const everyRow = ratedRows.map((t) => {
    const who = `${t.user.firstName} ${t.user.lastName}`.trim();
    const d = entries.get(t.id);
    return {
      ...shape(t, t.team?.name ?? null),
      ...entryView(String(t.status), d),
      // HR and Admin see every task but only the manager it belongs to can act on it.
      // Approval history: who decided and when (the Admin monitors this; HR sees it once a task is approved).
      decidedBy: t.approvedById ? deciders.get(t.approvedById) ?? null : null,
      decidedAt: t.approvedAt ? t.approvedAt.toISOString() : null,
      canAct: mayReview({ actorId: managerId, taggedId: d?.taggedManagerId ?? null, taggedActive: d?.taggedManagerActive ?? false, legacyOk: acting.has(t.userId) }),
      userId: t.userId,
      who,
      name: who,
      employee: who,
      employeeCode: t.user.employeeCode,
      company: t.user.platform?.name ?? null,
    };
  });

  // A task that is still waiting for its manager must not reach anyone who cannot decide it, except the Admin, who may monitor it:
  // HR sees it only after approval, and another manager never sees a task tagged to someone else.
  const all = everyRow.filter((t) => t.approvalStatus !== "PENDING" || pendingTaskVisibleTo(ctx.role, t.canAct));

  const roster = people.map((p) => ({
    id: p.id,
    name: `${p.firstName} ${p.lastName}`.trim(),
    employeeCode: p.employeeCode,
    designation: p.designation,
    company: p.platform?.name ?? null,
    projects: p.teamMemberships.map((m) => m.team),
  }));

  // Needs Approval = what THIS person can decide (never merely what they can see).
  const proposals = all.filter((t) => t.approvalStatus === "PENDING" && t.canAct);
  const toReview = all.filter(
    (t) =>
      t.approvalStatus === "APPROVED" &&
      t.status === "COMPLETED" &&
      t.rating == null
  );
  const recent = all.filter(
    (t) => t.rating != null || t.approvalStatus === "REJECTED"
  );

  return {
    date: dateStr,
    scope,
    teamSize: roster.length,
    members: roster,
    people: roster,
    team: roster,
    // The project filter, and the dropdown when assigning work.
    projects: managedProjects.map((p) => ({
      id: p.id,
      name: p.name,
      company: p.platform?.name ?? null,
    })),
    proposals,
    awaitingApproval: proposals,
    toReview,
    grading: toReview,
    toGrade: toReview,
    recent,
    all,
  };
}

export async function assignTask(
  managerId: string,
  body: Record<string, unknown>
) {
  const ctx = await userContext(managerId);
  if (!MANAGING_ROLES.includes(ctx.role)) throw new Error("NOT_ALLOWED");
  const actor = { id: managerId, role: ctx.role, platformId: ctx.platformId };

  const targetUserId = String(body.userId ?? "");
  if (!targetUserId) throw new Error("USER_REQUIRED");
  // A manager's tasks are his own: nobody (HR, Admin, another manager, an owner, or he himself through this route) assigns work to a manager.
  const targetRole = await prisma.user.findUnique({ where: { id: targetUserId }, select: { role: true } });
  if (targetRole && String(targetRole.role) === "MANAGER") throw new Error("MANAGER_TASKS_ARE_PERSONAL");
  await assertCanManage(actor, targetUserId);

  const title = String(body.title ?? "").trim();
  if (!title) throw new Error("TITLE_REQUIRED");
  if (title.length > 200) throw new Error("TITLE_TOO_LONG");

  const description = body.description
    ? String(body.description).trim().slice(0, 2000)
    : null;

  const weightIn = String(body.weight ?? "MEDIUM");
  const weight = WEIGHTS.includes(weightIn) ? weightIn : "MEDIUM";

  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { platform: true },
  });
  if (!target) throw new Error("USER_NOT_FOUND");

  // Tagged to the employee's project, not the manager's guess.
  const teamId = await resolveProject(
    targetUserId,
    body.teamId ?? body.projectId ?? null
  );

  // The task lands on the EMPLOYEE's day, in their company's timezone.
  const date = platformToday(target.platform.timezone);

  const assigned = await prisma.dailyTask.create({
    data: {
      platformId: target.platformId,
      userId: targetUserId,
      date,
      title,
      description,
      teamId,
      weight: weight as never,
      status: "PENDING" as never,
      // Assigned work needs no approval — the approver is the one assigning.
      approvalStatus: "APPROVED" as never,
      approvedById: managerId,
      approvedAt: new Date(),
      assignedById: managerId,
    },
    select: { id: true },
  });
  emitTaskChange({ taskId: assigned.id, ownerId: targetUserId, action: "assigned" });
  await taskNotice("assigned", assigned.id, managerId);

  return listForApproval(managerId);
}

export async function approveTask(
  managerId: string,
  taskId: string,
  approve: boolean,
  note?: string
) {
  const ctx = await userContext(managerId);
  if (!MANAGING_ROLES.includes(ctx.role)) throw new Error("NOT_ALLOWED");
  const actor = { id: managerId, role: ctx.role, platformId: ctx.platformId };

  // Whoever proposed the task deserves to know why it was turned down.
  if (!approve && !String(note ?? "").trim()) throw new Error("REASON_REQUIRED");

  const task = await prisma.dailyTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("NOT_FOUND");
  await assertCanReviewTask(actor, task, true);
  if ((await detailsFor([taskId])).has(taskId)) throw new Error("SELF_MANAGED");

  // A double-click can never overwrite a decision.
  if (String(task.approvalStatus) !== "PENDING") {
    throw new Error("ALREADY_ANSWERED");
  }

  await prisma.dailyTask.update({
    where: { id: taskId },
    data: {
      approvalStatus: (approve ? "APPROVED" : "REJECTED") as never,
      approvedById: managerId,
      approvedAt: new Date(),
      rejectionNote: approve
        ? null
        : note
        ? String(note).trim().slice(0, 1000)
        : null,
    },
  });
  if (approve && note && String(note).trim() && (await entryReady())) {
    const comment = String(note).trim().slice(0, 1000);
    await prisma.taskEntryDetail
      .upsert({ where: { taskId }, update: { approvalNote: comment }, create: { taskId, platformId: task.platformId, approvalNote: comment } })
      .catch((e) => console.error("[tasks] approval comment not saved:", e));
  }
  emitTaskChange({ taskId, ownerId: task.userId, action: approve ? "approved" : "rejected" });
  await taskNotice(approve ? "proposalApproved" : "proposalReturned", taskId, managerId, { note: approve ? null : note ? String(note) : null });

  return listForApproval(managerId);
}

/**
 * Rate a finished task 1-5 stars (this replaced the Completed / Partial / Failed grade). Re-rating overwrites the earlier rating.
 * Who: the people who can grade the task (assertCanReviewTask), never the task's own owner. Only an approved, finished task.
 */
export async function reviewTask(
  managerId: string,
  taskId: string,
  input: { rating?: unknown; comment?: unknown; outcome?: unknown }
) {
  const ctx = await userContext(managerId);
  if (!MANAGING_ROLES.includes(ctx.role)) throw new Error("NOT_ALLOWED");
  const actor = { id: managerId, role: ctx.role, platformId: ctx.platformId };

  // The old three-way grade is gone: a request that still sends it is told to use stars.
  if (input.rating === undefined && input.outcome !== undefined) throw new Error("USE_RATING");
  const stars = parseRating(input.rating);
  if (stars === null) throw new Error("BAD_RATING");
  const comment = checkComment(input.comment);
  if ("error" in comment) throw new Error(comment.error);
  if (!(await ratingReady())) throw new Error("FEATURES_NOT_READY");

  const task = await prisma.dailyTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("NOT_FOUND");
  // Nobody rates their own work, whatever their role.
  if (task.userId === managerId) throw new Error("NOT_YOUR_OWN_TASK");
  await assertCanReviewTask(actor, task);
  if ((await detailsFor([taskId])).has(taskId)) throw new Error("SELF_MANAGED");

  if (String(task.approvalStatus) !== "APPROVED") {
    throw new Error("NOT_APPROVED");
  }
  // A manager cannot rate something that was never finished.
  if (String(task.status) !== "COMPLETED") {
    throw new Error("NOT_FINISHED_YET");
  }

  const before = (await prisma.taskRating.findUnique({ where: { taskId }, select: { rating: true } }))?.rating ?? null;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.taskRating.upsert({
      where: { taskId },
      update: { rating: stars, comment: comment.text, ratedById: managerId },
      create: { taskId, platformId: task.platformId, ratedById: managerId, rating: stars, comment: comment.text },
    });
    // who reviewed and when stay on the task itself; a fresh rating also replaces any "reopened" marker note
    await tx.dailyTask.update({ where: { id: taskId }, data: { reviewedById: managerId, reviewedAt: now, reviewNote: null } });
  });
  auditNote({
    platformId: task.platformId,
    module: "Tasks",
    action: "UPDATE",
    recordType: "Task",
    recordId: taskId,
    targetUserId: task.userId,
    summary: `Rated task "${task.title}" ${stars}/5`,
    before: { rating: before },
    after: { rating: stars, comment: comment.text },
  });
  emitTaskChange({ taskId, ownerId: task.userId, action: "graded" });
  await taskNotice("rated", taskId, managerId, { note: comment.text, stars, stamp: now.getTime() });

  return listForApproval(managerId);
}
/**
 * Send a Completed task back to In Progress, with a required remark and a kind (Partially / Not fully completed).
 * Who: the people who can grade the task (its team's managers, the person it reports to, HR/Admin of the company), never the task's own owner.
 * What is kept: the task, its details and the employee's submission note. What changes: status -> In Progress, the grade and the completion
 * time are cleared (so the task no longer counts as completed), and the latest revert (kind + remark + who + when) is stored on the task.
 * The permanent record (previous and new status, kind, who, when, remark, the original grade) goes to the immutable audit log.
 * One transaction with a state check, so two presses cannot revert the same task twice.
 */
export async function revertTask(managerId: string, taskId: string, typeIn: unknown, remarkIn: unknown) {
  const ctx = await userContext(managerId);
  if (!MANAGING_ROLES.includes(ctx.role)) throw new Error("NOT_ALLOWED");
  const actor = { id: managerId, role: ctx.role, platformId: ctx.platformId };

  const type = String(typeIn ?? "") as RevertType;
  if (!REVERT_TYPES.includes(type)) throw new Error("BAD_REVERT_TYPE");
  const remark = checkRemark(remarkIn);
  if ("error" in remark) throw new Error(remark.error);

  const task = await prisma.dailyTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("NOT_FOUND");
  // Nobody reverts their own task, whatever their role.
  if (task.userId === managerId) throw new Error("NOT_ALLOWED");
  await assertCanReviewTask(actor, task);

  const selfManaged = (await detailsFor([taskId])).has(taskId);
  const block = revertBlock({ approvalStatus: String(task.approvalStatus), status: String(task.status), reviewNote: task.reviewNote, selfManaged });
  if (block) throw new Error(block);

  const now = new Date();
  const claimed = await prisma.dailyTask.updateMany({
    // the state check is part of the write: if someone else reverted it a moment ago this matches nothing
    where: { id: taskId, status: "COMPLETED" as never, approvalStatus: "APPROVED" as never },
    data: {
      status: "IN_PROGRESS" as never,
      outcome: null,
      completedAt: null,
      reviewedById: managerId,
      reviewedAt: now,
      reviewNote: encodeRevertNote(type, remark.text),
    },
  });
  if (claimed.count !== 1) throw new Error("ALREADY_REOPENED");
  // The task is unfinished again, so its rating goes too (the previous stars are kept in the audit row below).
  const previous = (await ratingsFor([task])).get(taskId) ?? null;
  if (await ratingReady()) await prisma.taskRating.deleteMany({ where: { taskId } });

  const managerName = await prisma.user.findUnique({ where: { id: managerId }, select: { firstName: true, lastName: true } });
  auditNote({
    platformId: task.platformId,
    module: "Tasks",
    action: "UPDATE",
    recordType: "Task",
    recordId: taskId,
    targetUserId: task.userId,
    summary: `Reopened task "${task.title}" (${REVERT_LABEL[type]}): ${String(task.status)} to IN_PROGRESS`,
    before: { status: String(task.status), rating: previous?.rating ?? null, ratingComment: previous?.comment ?? null, completedAt: task.completedAt, gradedById: task.reviewedById, gradedAt: task.reviewedAt, gradeNote: task.reviewNote, submissionNote: task.completionNote },
    after: { status: "IN_PROGRESS", revertType: type, revertLabel: REVERT_LABEL[type], remark: remark.text, revertedById: managerId, revertedBy: managerName ? `${managerName.firstName} ${managerName.lastName}`.trim() : null, employeeId: task.userId, revertedAt: now },
  });
  emitTaskChange({ taskId, ownerId: task.userId, action: "reverted" });
  await taskNotice("reverted", taskId, managerId, { note: remark.text, label: REVERT_LABEL[type], stamp: now.getTime() });

  return listForApproval(managerId);
}

/** The task, only if it belongs to this person (used by routes that read one of your own tasks). */
export async function ownTaskOrThrow(userId: string, taskId: string) {
  const task = await prisma.dailyTask.findUnique({ where: { id: taskId }, select: { id: true, userId: true } });
  if (!task || task.userId !== userId) throw new Error("NOT_FOUND");
  return task;
}
