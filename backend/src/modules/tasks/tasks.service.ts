import { emitTaskChange } from "../../lib/realtime.js";
import { taskNotice } from "./tasks.notify.js";
import { managedByWhere, isTeamManager } from "../../lib/teamManagers.js";
import { prisma } from "../../lib/prisma.js";
import { inPinnedCompany, onlyPinnedCompany } from "../../lib/deployment.js";
import { parseIsoDay, platformToday } from "../../lib/dates.js";
import { detailsFor, recordEvent, selfTasksReady, shapeSelf } from "./tasks.self.js";
import { auditNote } from "../../lib/auditContext.js";
import { REVERT_LABEL, REVERT_MARK_PREFIX, REVERT_TYPES, checkRemark, encodeRevertNote, reopenedView, revertBlock, type RevertType } from "./tasks.revert.logic.js";

// ---------------------------------------------------------------------------
// SCORING
// A task's worth is its weight. What it earns depends on the manager's grade:
// completed earns all of it, partially completed half, failed nothing.
// Nothing unapproved counts at all.
// ---------------------------------------------------------------------------
export const TASK_WEIGHTS: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 5,
};

export const OUTCOME_MULTIPLIER: Record<string, number> = {
  COMPLETED: 1,
  PARTIALLY_COMPLETED: 0.5,
  FAILED: 0,
};

const WEIGHTS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETED"];
const OUTCOMES = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED"];
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
async function assertCanReviewTask(
  actor: { id: string; role: string; platformId: string },
  task: { userId: string; teamId: string | null }
) {
  if (!(await inPinnedCompany(task.userId))) throw new Error("NOT_YOUR_TEAM");
  if (task.teamId) {
    if (await isTeamManager(actor.id, task.teamId)) return;
  }

  const target = await prisma.user.findUnique({
    where: { id: task.userId },
    select: { platformId: true, reportsToId: true },
  });
  if (!target) throw new Error("NOT_YOUR_TEAM");

  if (target.reportsToId === actor.id) return;
  if (
    (actor.role === "ADMIN" || actor.role === "HR") &&
    target.platformId === actor.platformId
  ) {
    return;
  }

  throw new Error("NOT_YOUR_TEAM");
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

  if (target.reportsToId === actor.id) return;
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

export async function manageableUserIds(actor: {
  id: string;
  role: string;
  platformId: string;
}): Promise<string[]> {
  // Everyone on the teams they run, plus their direct reports. Both can cross
  // companies - at Avatar one person heads teams in several of them.
  const [managedTeams, reports] = await Promise.all([
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
  ]);

  const ids = new Set<string>([
    ...managedTeams.flatMap((t) => t.members.map((m) => m.userId)),
    ...reports.map((r) => r.id),
  ]);

  // An admin or HR also sees their own company. Note ADDED to the two lists
  // above, not substituted for them: substituting meant an admin of one
  // company could not approve for a team they personally run in another, so
  // tasks submitted to them sat in nobody's queue and silently expired.
  if (actor.role === "ADMIN" || actor.role === "HR") {
    const all = await prisma.user.findMany({
      where: {
        platformId: actor.platformId,
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
    rejectionNote: string | null;
    reviewNote: string | null;
    completionNote: string | null;
    assignedById: string | null;
    teamId: string | null;
    date: Date;
  }
>(t: T, projectName?: string | null) {
  return {
    ...t,
    date: t.date.toISOString().slice(0, 10),
    weightValue: TASK_WEIGHTS[String(t.weight)] ?? 1,
    assigned: t.assignedById !== null,
    project: projectName ?? null,
    projectId: t.teamId,
    // Set when a manager sent this task back (Partially / Not fully completed): the kind, the remark, and whether it was finished again.
    reopened: reopenedView(t),
  };
}

type Scorable = {
  weight: string;
  status: string;
  approvalStatus: string;
  outcome: string | null;
};

export function scoreOf(tasks: Scorable[]) {
  const approved = tasks.filter((t) => String(t.approvalStatus) === "APPROVED");

  const totalWeight = approved.reduce(
    (n, t) => n + (TASK_WEIGHTS[String(t.weight)] ?? 1),
    0
  );

  const doneWeight = approved.reduce((n, t) => {
    const w = TASK_WEIGHTS[String(t.weight)] ?? 1;
    if (t.outcome) return n + w * (OUTCOME_MULTIPLIER[String(t.outcome)] ?? 0);
    if (String(t.status) === "COMPLETED") return n + w;
    return n;
  }, 0);

  return {
    total: approved.length,
    done: approved.filter(
      (t) =>
        String(t.status) === "COMPLETED" || String(t.outcome) === "COMPLETED"
    ).length,
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

  const [rows, projects] = await Promise.all([
    prisma.dailyTask.findMany({
      where: { userId, date },
      include: { team: { select: { name: true } } },
      orderBy: { title: "asc" },
    }),
    myProjects(userId),
  ]);

  // A task a manager reopened keeps its original day, which may be earlier than today, but it is unfinished work again: it is shown with
  // the rest of the person's working tasks, flagged with the day it came from. It does not change today's score.
  const reopenedOld = await prisma.dailyTask.findMany({
    where: { userId, approvalStatus: "APPROVED", status: { in: ["PENDING", "IN_PROGRESS"] }, outcome: null, date: { lt: date }, reviewNote: { startsWith: REVERT_MARK_PREFIX } },
    include: { team: { select: { name: true } } },
    orderBy: { date: "asc" },
  });
  const selfDetails = await detailsFor(rows.map((r) => r.id));
  const nowForSelf = new Date();
  const tasks = rows.map((t) => ({ ...shape(t, t.team?.name ?? null), ...shapeSelf(selfDetails.get(t.id), String(t.status), nowForSelf, ctx.timezone) }));
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

  return {
    date: date.toISOString().slice(0, 10),
    selfApproves: !ctx.user.reportsToId || selfManagedMode,
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
  const rows = await prisma.dailyTask.findMany({
    where: { userId, date },
    include: { team: { select: { name: true } } },
    orderBy: { title: "asc" },
  });
  return {
    date: date.toISOString().slice(0, 10),
    score: scoreOf(rows),
    tasks: rows.map((t) => shape(t, t.team?.name ?? null)),
  };
}

// Resolves the project for a new task and refuses one the person isn't on.
async function resolveProject(
  userId: string,
  given: unknown
): Promise<string | null> {
  const projects = await myProjects(userId);
  if (projects.length === 0) return null;

  const wanted = given ? String(given) : "";
  if (wanted) {
    if (!projects.some((p) => p.id === wanted)) throw new Error("NOT_MY_PROJECT");
    return wanted;
  }

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

  const teamId = await resolveProject(
    userId,
    body.teamId ?? body.projectId ?? null
  );

  const date = platformToday(ctx.timezone);
  // A MANAGER's own tasks are self-managed: approved when created, no approval step, nobody notified, no review queue. (Employee
  // tasks keep the approval workflow. Before the migration nothing is self-managed and a manager's task waits as it always did.)
  const selfManaged = ctx.role === "MANAGER" && (await selfTasksReady());
  const selfApprove = !ctx.user.reportsToId || selfManaged;

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
        status: "PENDING" as never,
        approvalStatus: (selfApprove ? "APPROVED" : "PENDING") as never,
        approvedById: selfApprove ? userId : null,
        approvedAt: selfApprove ? new Date() : null,
      },
      select: { id: true },
    });
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
    if (task.outcome) throw new Error("ALREADY_REVIEWED");
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
        body.teamId ?? body.projectId ?? null
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

  if (Object.keys(data).length === 0 && Object.keys(detailPatch).length === 0 && !workUpdate) throw new Error("NOTHING_TO_UPDATE");

  if (Object.keys(data).length > 0 || Object.keys(detailPatch).length > 0) {
    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) await tx.dailyTask.update({ where: { id: taskId }, data: data as never });
      if (selfManaged && Object.keys(detailPatch).length > 0) await tx.taskSelfDetail.update({ where: { taskId }, data: detailPatch });
    });
  }
  for (const e of events) await recordEvent({ taskId, platformId: task.platformId, actorId: userId, kind: e.kind, note: e.note ?? null });
  emitTaskChange({ taskId, ownerId: userId, action: body.status !== undefined ? "status" : "updated" });
  // A manager's own completed task is not "submitted" to anyone: there is nobody to review it.
  if (!selfManaged && body.status !== undefined && String(body.status) === "COMPLETED" && String(task.status) !== "COMPLETED") await taskNotice("submitted", taskId, userId);

  return listTasks(userId);
}

export async function deleteMyTask(userId: string, taskId: string) {
  const task = await prisma.dailyTask.findUnique({ where: { id: taskId } });
  if (!task || task.userId !== userId) throw new Error("NOT_FOUND");

  if (task.assignedById) throw new Error("ASSIGNED_CANNOT_DELETE");
  if (task.outcome) throw new Error("ALREADY_REVIEWED");
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
  range?: { from?: string; to?: string }
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
  const userIds = await manageableUserIds(actor);
  if (userIds.length === 0) {
    return {
      date: dateStr,
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
      where: { id: { in: userIds } },
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
        userId: { in: userIds },
        ...dateFilter,
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
          : { platformId: ctx.platformId, isActive: true },
      select: { id: true, name: true, platform: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
  ]);

  // A manager's own tasks are self-managed: nobody reviews or grades them, so they never appear in anyone's queue.
  const selfIds = new Set((await detailsFor(rawRows.map((r) => r.id))).keys());
  const rows = rawRows.filter((r) => !selfIds.has(r.id));

  const all = rows.map((t) => {
    const who = `${t.user.firstName} ${t.user.lastName}`.trim();
    return {
      ...shape(t, t.team?.name ?? null),
      userId: t.userId,
      who,
      name: who,
      employee: who,
      employeeCode: t.user.employeeCode,
      company: t.user.platform?.name ?? null,
    };
  });

  const roster = people.map((p) => ({
    id: p.id,
    name: `${p.firstName} ${p.lastName}`.trim(),
    employeeCode: p.employeeCode,
    designation: p.designation,
    company: p.platform?.name ?? null,
    projects: p.teamMemberships.map((m) => m.team),
  }));

  const proposals = all.filter((t) => t.approvalStatus === "PENDING");
  const toReview = all.filter(
    (t) =>
      t.approvalStatus === "APPROVED" &&
      t.status === "COMPLETED" &&
      !t.outcome
  );
  const recent = all.filter(
    (t) => Boolean(t.outcome) || t.approvalStatus === "REJECTED"
  );

  return {
    date: dateStr,
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
  await assertCanReviewTask(actor, task);
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
  emitTaskChange({ taskId, ownerId: task.userId, action: approve ? "approved" : "rejected" });
  await taskNotice(approve ? "proposalApproved" : "proposalReturned", taskId, managerId, { note: approve ? null : note ? String(note) : null });

  return listForApproval(managerId);
}

export async function reviewTask(
  managerId: string,
  taskId: string,
  outcome: string,
  note?: string
) {
  const ctx = await userContext(managerId);
  if (!MANAGING_ROLES.includes(ctx.role)) throw new Error("NOT_ALLOWED");
  const actor = { id: managerId, role: ctx.role, platformId: ctx.platformId };

  const outcomeIn = String(outcome ?? "");
  if (!OUTCOMES.includes(outcomeIn)) throw new Error("BAD_OUTCOME");

  const task = await prisma.dailyTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("NOT_FOUND");
  await assertCanReviewTask(actor, task);
  if ((await detailsFor([taskId])).has(taskId)) throw new Error("SELF_MANAGED");

  if (String(task.approvalStatus) !== "APPROVED") {
    throw new Error("NOT_APPROVED");
  }
  // A manager cannot fail something that was never finished.
  if (String(task.status) !== "COMPLETED") {
    throw new Error("NOT_FINISHED_YET");
  }

  await prisma.dailyTask.update({
    where: { id: taskId },
    data: {
      outcome: outcomeIn as never,
      reviewedById: managerId,
      reviewedAt: new Date(),
      reviewNote: note ? String(note).trim().slice(0, 1000) : null,
    },
  });
  emitTaskChange({ taskId, ownerId: task.userId, action: "graded" });
  await taskNotice(outcomeIn === "FAILED" ? "notAccepted" : "approved", taskId, managerId, { note: note ? String(note) : null, partial: outcomeIn === "PARTIALLY_COMPLETED" });

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

  const managerName = await prisma.user.findUnique({ where: { id: managerId }, select: { firstName: true, lastName: true } });
  auditNote({
    platformId: task.platformId,
    module: "Tasks",
    action: "UPDATE",
    recordType: "Task",
    recordId: taskId,
    targetUserId: task.userId,
    summary: `Reopened task "${task.title}" (${REVERT_LABEL[type]}): ${String(task.status)} to IN_PROGRESS`,
    before: { status: String(task.status), outcome: task.outcome ? String(task.outcome) : null, completedAt: task.completedAt, gradedById: task.reviewedById, gradedAt: task.reviewedAt, gradeNote: task.reviewNote, submissionNote: task.completionNote },
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
