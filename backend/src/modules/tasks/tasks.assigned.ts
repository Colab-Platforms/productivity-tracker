// Manager-ASSIGNED tasks (the Daily Tasks "Assigned by me" / "Assigned by manager" tabs). Rules in tasks.assigned.logic.ts.
//
// Separate from employee-SUBMITTED tasks without a new table: an assigned task is a daily_tasks row with `assignedById` set, and the shared filter
// `activeTasks()` (tasks.deleted.ts) leaves those rows out of every submitted-task reader (approval queue, rating, productivity, reports, the employee's own
// list), so an assigned task is never approved, rated or counted twice. Only the functions below read them. Nothing here touches `approvalStatus`.

import { prisma } from "../../lib/prisma.js";
import { platformToday } from "../../lib/dates.js";
import { auditNote } from "../../lib/auditContext.js";
import { emitTaskChange } from "../../lib/realtime.js";
import { notifyUsers } from "../../lib/notify.js";
import { activeAssigned } from "./tasks.deleted.js";
import { selfTasksReady } from "./tasks.self.js";
import { assertCanManage, manageableUserIds, resolveProject, userContext } from "./tasks.service.js";
import { taskNotice } from "./tasks.notify.js";
import {
  ASSIGNED_PREFIX, MOVE_STATUS, checkText, countStages, decodeAssigned, dueOf, employeeMoveAllowed, encodeAssigned, isOverdue, parseDue, stageOf,
  type AssignedPayload, type AssignedStage, type EmployeeMove,
} from "./tasks.assigned.logic.js";

const WEIGHTS = ["LOW", "MEDIUM", "HIGH"];
const PERSON = { select: { id: true, firstName: true, lastName: true, employeeCode: true } } as const;
const fullName = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : "");

type EventRow = { id: string; actorId: string; createdAt: Date; payload: AssignedPayload };

async function eventsOf(taskIds: string[]): Promise<Map<string, EventRow[]>> {
  const out = new Map<string, EventRow[]>();
  if (taskIds.length === 0 || !(await selfTasksReady())) return out;
  const rows = await prisma.taskEvent.findMany({
    where: { taskId: { in: taskIds }, note: { startsWith: ASSIGNED_PREFIX } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, taskId: true, actorId: true, createdAt: true, note: true },
  });
  for (const r of rows) {
    const payload = decodeAssigned(r.note);
    if (!payload) continue;
    out.set(r.taskId, [...(out.get(r.taskId) ?? []), { id: r.id, actorId: r.actorId, createdAt: r.createdAt, payload }]);
  }
  return out;
}

async function writeEvent(taskId: string, platformId: string, actorId: string, kind: "CREATED" | "COMPLETED" | "REOPENED" | "EDITED" | "UPDATE", payload: AssignedPayload) {
  await prisma.taskEvent.create({ data: { taskId, platformId, actorId, kind, note: encodeAssigned(payload) } });
}

async function timezones(platformIds: string[]): Promise<Map<string, string>> {
  const rows = await prisma.platform.findMany({ where: { id: { in: [...new Set(platformIds)] } }, select: { id: true, timezone: true } });
  return new Map(rows.map((p) => [p.id, p.timezone]));
}

type Row = Awaited<ReturnType<typeof loadRows>>[number];
async function loadRows(where: Record<string, unknown>) {
  return prisma.dailyTask.findMany({
    // A removed (cancelled) task leaves the lists; its row and history stay in the database.
    where: { ...(await activeAssigned()), status: { not: "CANCELLED" as never }, ...where },
    include: { user: PERSON, assignedBy: PERSON, team: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "desc" }],
    take: 300,
  });
}

async function shape(rows: Row[]) {
  const [events, zones] = await Promise.all([eventsOf(rows.map((r) => r.id)), timezones(rows.map((r) => r.platformId))]);
  return rows.map((r) => {
    const ev = events.get(r.id) ?? [];
    const stage = stageOf(String(r.status), r.reviewedAt);
    const today = platformToday(zones.get(r.platformId) ?? "Asia/Kolkata").toISOString().slice(0, 10);
    const due = dueOf(ev);
    const comments = ev.filter((e) => e.payload.t === "comment");
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      priority: String(r.weight),
      projectId: r.teamId,
      project: r.team?.name ?? null,
      employeeId: r.userId,
      employee: fullName(r.user),
      employeeCode: r.user.employeeCode,
      assignedById: r.assignedById,
      assignedBy: fullName(r.assignedBy),
      assignedOn: r.createdAt.toISOString(),
      due,
      overdue: isOverdue(stage, due, today),
      stage,
      completionNote: r.completionNote,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      confirmedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
      sentBackReason: stage === "IN_PROGRESS" || stage === "TODO" ? (r.reviewNote ?? null) : null,
      commentCount: comments.length,
      lastComment: comments.length ? { text: (comments[comments.length - 1].payload as { text: string }).text, at: comments[comments.length - 1].createdAt.toISOString() } : null,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

export type AssignedView = Awaited<ReturnType<typeof shape>>[number];

/** One person's manager-assigned tasks dated in a period (read-only, for the Task Productivity drill-down). The caller decides who may see them. */
export async function assignedTasksForReport(userId: string, from: Date, to: Date): Promise<AssignedView[]> {
  return shape(await loadRows({ userId, date: { gte: from, lte: to } }));
}

function tell(taskId: string, ownerId: string, managerId: string, action: "assigned" | "updated" | "status") {
  emitTaskChange({ taskId, ownerId, action });
  if (managerId !== ownerId) emitTaskChange({ taskId, ownerId: managerId, action });
}

async function notice(recipients: string[], o: { type: string; title: string; body: string; taskId: string; key: string; link: string }) {
  try {
    const people = await prisma.user.findMany({ where: { id: { in: recipients } }, select: { id: true, platformId: true } });
    const byPlatform = new Map<string, string[]>();
    for (const p of people) byPlatform.set(p.platformId, [...(byPlatform.get(p.platformId) ?? []), p.id]);
    for (const [platformId, userIds] of byPlatform) {
      await notifyUsers({ platformId, userIds, type: o.type, title: o.title, body: o.body, link: o.link, dedupeKey: o.key, data: { taskId: o.taskId } });
    }
  } catch (e) {
    console.error("[tasks] assigned notice failed:", e instanceof Error ? e.message : e);
  }
}

async function ready() {
  if (!(await selfTasksReady())) throw new Error("FEATURES_NOT_READY");
}

/** A manager assigns, and so does an ADMIN (owner decision 2026-11-21: Admin assigns work to employees). HR does not. An Admin reaches the employees of the companies they act on. */
async function managerContext(userId: string) {
  const ctx = await userContext(userId);
  if (String(ctx.role) !== "MANAGER" && String(ctx.role) !== "ADMIN") throw new Error("NOT_ALLOWED");
  return { id: userId, role: String(ctx.role), platformId: ctx.platformId };
}

async function ownedByManager(managerId: string, taskId: string) {
  const task = await prisma.dailyTask.findFirst({ where: { ...(await activeAssigned()), id: taskId, assignedById: managerId } });
  if (!task) throw new Error("NOT_FOUND");
  return task;
}

// --- reads -------------------------------------------------------------------------------------------------------------------------------

/** The people a manager may assign to: their reporting team and project members, never another manager. */
export async function assignablePeople(managerId: string) {
  const actor = await managerContext(managerId);
  const ids = (await manageableUserIds(actor)).filter((i) => i !== managerId);
  // An Admin assigns to EMPLOYEES only (never to a manager, HR or another Admin); a manager keeps the earlier rule (anyone of their team but a manager).
  const people = await prisma.user.findMany({
    where: { id: { in: ids }, status: "ACTIVE" as never, role: actor.role === "ADMIN" ? ("EMPLOYEE" as never) : { not: "MANAGER" as never } },
    select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  // Their projects, so the form can suggest the person's own project.
  const members = await prisma.teamMember.findMany({ where: { userId: { in: people.map((p) => p.id) }, isActive: true, team: { isActive: true } }, select: { userId: true, isPrimary: true, team: { select: { id: true, name: true } } } });
  return {
    people: people.map((p) => ({
      id: p.id, name: fullName(p), code: p.employeeCode,
      projects: members.filter((m) => m.userId === p.id).map((m) => ({ id: m.team.id, name: m.team.name, primary: m.isPrimary })),
    })),
  };
}

export async function listAssignedByMe(managerId: string) {
  await managerContext(managerId);
  const tasks = await shape(await loadRows({ assignedById: managerId }));
  return { ready: await selfTasksReady(), tasks, counts: countStages(tasks) };
}

export async function listAssignedToMe(userId: string) {
  const tasks = await shape(await loadRows({ userId }));
  return { ready: await selfTasksReady(), tasks, counts: countStages(tasks) };
}

// --- manager actions ------------------------------------------------------------------------------------------------------------------

export async function assignNew(managerId: string, body: Record<string, unknown>) {
  await ready();
  const actor = await managerContext(managerId);
  const targetId = String(body.userId ?? "");
  if (!targetId) throw new Error("USER_REQUIRED");
  const target = await prisma.user.findUnique({ where: { id: targetId }, include: { platform: true } });
  if (!target || String(target.status) !== "ACTIVE") throw new Error("USER_NOT_FOUND");
  if (String(target.role) === "MANAGER") throw new Error("MANAGER_TASKS_ARE_PERSONAL");
  if (actor.role === "ADMIN") {
    // An Admin assigns to employees of the companies they act on (company access), never to HR or another Admin.
    if (String(target.role) !== "EMPLOYEE") throw new Error("ADMIN_ASSIGNS_EMPLOYEES");
    if (!(await manageableUserIds(actor)).includes(targetId)) throw new Error("NOT_YOUR_TEAM");
  } else {
    await assertCanManage(actor, targetId);
  }

  const title = String(body.title ?? "").trim();
  if (!title) throw new Error("TITLE_REQUIRED");
  if (title.length > 200) throw new Error("TITLE_TOO_LONG");
  const description = body.description ? String(body.description).trim().slice(0, 2000) || null : null;
  const weightIn = String(body.priority ?? body.weight ?? "MEDIUM");
  const weight = WEIGHTS.includes(weightIn) ? weightIn : "MEDIUM";
  const due = parseDue(body.due);
  const today = platformToday(target.platform.timezone).toISOString().slice(0, 10);
  if (due && due < today) throw new Error("DUE_IN_PAST");
  const teamId = await resolveProject(targetId, body.teamId ?? body.projectId ?? null);

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.dailyTask.create({
      data: {
        platformId: target.platformId, userId: targetId, date: platformToday(target.platform.timezone), title, description, teamId,
        weight: weight as never, status: "PENDING" as never,
        // Assigned work needs no approval or rating: the manager is the one handing it over.
        approvalStatus: "APPROVED" as never, approvedById: managerId, approvedAt: new Date(), assignedById: managerId,
      },
      select: { id: true },
    });
    await tx.taskEvent.create({ data: { taskId: row.id, platformId: target.platformId, actorId: managerId, kind: "CREATED", note: encodeAssigned({ v: 1, t: "created", due }) } });
    return row;
  });
  auditNote({ summary: `Assigned a task: ${title}`, recordType: "DailyTask", recordId: created.id, targetUserId: targetId, after: { title, due, project: teamId } });
  tell(created.id, targetId, managerId, "assigned");
  await taskNotice("assigned", created.id, managerId);
  return listAssignedByMe(managerId);
}

export async function editAssigned(managerId: string, taskId: string, body: Record<string, unknown>) {
  await ready();
  await managerContext(managerId);
  const task = await ownedByManager(managerId, taskId);
  if (stageOf(String(task.status), task.reviewedAt) === "CONFIRMED") throw new Error("ALREADY_CONFIRMED");
  if (String(task.status) === "CANCELLED") throw new Error("NOT_FOUND");

  const data: Record<string, unknown> = {};
  const changes: { field: string; from: string | null; to: string | null }[] = [];
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t) throw new Error("TITLE_REQUIRED");
    if (t.length > 200) throw new Error("TITLE_TOO_LONG");
    if (t !== task.title) { data.title = t; changes.push({ field: "Task", from: task.title, to: t }); }
  }
  if (body.description !== undefined) {
    const d = String(body.description ?? "").trim().slice(0, 2000) || null;
    if (d !== task.description) { data.description = d; changes.push({ field: "Details", from: task.description, to: d }); }
  }
  if (body.priority !== undefined || body.weight !== undefined) {
    const w = String(body.priority ?? body.weight);
    if (!WEIGHTS.includes(w)) throw new Error("BAD_PRIORITY");
    if (w !== String(task.weight)) { data.weight = w; changes.push({ field: "Priority", from: String(task.weight), to: w }); }
  }
  if (body.teamId !== undefined || body.projectId !== undefined) {
    const next = await resolveProject(task.userId, body.teamId ?? body.projectId ?? null);
    if (next !== task.teamId) { data.teamId = next; changes.push({ field: "Project", from: task.teamId, to: next }); }
  }
  let duePatch: { due: string | null } | null = null;
  if (body.due !== undefined) {
    const due = parseDue(body.due);
    const before = dueOf((await eventsOf([taskId])).get(taskId) ?? []);
    if (due !== before) {
      duePatch = { due };
      changes.push({ field: "Due date", from: before, to: due });
    }
  }
  if (changes.length === 0) throw new Error("NOTHING_CHANGED");
  await prisma.$transaction(async (tx) => {
    // Guarded: a confirmation that landed a moment earlier wins, and this edit does not overwrite it.
    const res = await tx.dailyTask.updateMany({ where: { id: taskId, assignedById: managerId, reviewedAt: null }, data: data as never });
    if (res.count === 0 && Object.keys(data).length > 0) throw new Error("ALREADY_CONFIRMED");
    if (res.count === 0 && !duePatch) throw new Error("ALREADY_CONFIRMED");
    await tx.taskEvent.create({ data: { taskId, platformId: task.platformId, actorId: managerId, kind: "EDITED", note: encodeAssigned({ v: 1, t: "edited", changes, ...(duePatch ?? {}) }) } });
  });
  auditNote({ summary: `Edited an assigned task: ${task.title}`, recordType: "DailyTask", recordId: taskId, targetUserId: task.userId, before: Object.fromEntries(changes.map((c) => [c.field, c.from])), after: Object.fromEntries(changes.map((c) => [c.field, c.to])) });
  tell(taskId, task.userId, managerId, "updated");
  await notice([task.userId], { type: "ASSIGNED_TASK_UPDATED", title: "Assigned task changed", body: `Your manager changed: ${task.title}`, taskId, key: `asg:${taskId}:edit:${Date.now()}`, link: "/dashboard/tasks?tab=assigned" });
  return listAssignedByMe(managerId);
}

export async function confirmAssigned(managerId: string, taskId: string, note: unknown) {
  await ready();
  await managerContext(managerId);
  const task = await ownedByManager(managerId, taskId);
  const text = String(note ?? "").trim() ? checkText("note", note, 1, 300) : null;
  const done = await prisma.dailyTask.updateMany({
    where: { id: taskId, assignedById: managerId, status: "COMPLETED" as never, reviewedAt: null },
    data: { reviewedById: managerId, reviewedAt: new Date(), reviewNote: text },
  });
  if (done.count === 0) throw new Error("NOT_AWAITING_CONFIRMATION");
  await writeEvent(taskId, task.platformId, managerId, "UPDATE", { v: 1, t: "confirmed", note: text });
  auditNote({ summary: `Confirmed an assigned task as complete: ${task.title}`, recordType: "DailyTask", recordId: taskId, targetUserId: task.userId });
  tell(taskId, task.userId, managerId, "status");
  await notice([task.userId], { type: "ASSIGNED_TASK_CONFIRMED", title: "Task confirmed", body: `Your manager confirmed: ${task.title}`, taskId, key: `asg:${taskId}:confirmed`, link: "/dashboard/tasks?tab=assigned" });
  return listAssignedByMe(managerId);
}

export async function sendBackAssigned(managerId: string, taskId: string, reason: unknown) {
  await ready();
  await managerContext(managerId);
  const task = await ownedByManager(managerId, taskId);
  const why = checkText("reason", reason, 3, 300);
  const res = await prisma.dailyTask.updateMany({
    where: { id: taskId, assignedById: managerId, status: "COMPLETED" as never, reviewedAt: null },
    data: { status: "IN_PROGRESS" as never, completedAt: null, reviewNote: why },
  });
  if (res.count === 0) throw new Error("NOT_AWAITING_CONFIRMATION");
  await writeEvent(taskId, task.platformId, managerId, "REOPENED", { v: 1, t: "sent_back", reason: why });
  auditNote({ summary: `Sent an assigned task back: ${task.title}`, recordType: "DailyTask", recordId: taskId, targetUserId: task.userId, after: { reason: why } });
  tell(taskId, task.userId, managerId, "status");
  await notice([task.userId], { type: "ASSIGNED_TASK_SENT_BACK", title: "Task sent back", body: `${task.title}: ${why}`, taskId, key: `asg:${taskId}:sentback:${Date.now()}`, link: "/dashboard/tasks?tab=assigned" });
  return listAssignedByMe(managerId);
}

/** Removing is only possible while the work has not started (the row stays, marked cancelled, with its history). */
export async function cancelAssigned(managerId: string, taskId: string) {
  await ready();
  await managerContext(managerId);
  const task = await ownedByManager(managerId, taskId);
  const res = await prisma.dailyTask.updateMany({ where: { id: taskId, assignedById: managerId, status: "PENDING" as never }, data: { status: "CANCELLED" as never } });
  if (res.count === 0) throw new Error("ALREADY_STARTED");
  await writeEvent(taskId, task.platformId, managerId, "UPDATE", { v: 1, t: "cancelled" });
  auditNote({ summary: `Removed an assigned task before it started: ${task.title}`, recordType: "DailyTask", recordId: taskId, targetUserId: task.userId });
  tell(taskId, task.userId, managerId, "updated");
  await notice([task.userId], { type: "ASSIGNED_TASK_UPDATED", title: "Assigned task removed", body: `Your manager removed: ${task.title}`, taskId, key: `asg:${taskId}:cancelled`, link: "/dashboard/tasks?tab=assigned" });
  return listAssignedByMe(managerId);
}

// --- employee actions -----------------------------------------------------------------------------------------------------------------

export async function moveAssigned(userId: string, taskId: string, toRaw: unknown, noteRaw: unknown) {
  await ready();
  const to = String(toRaw) as EmployeeMove;
  if (!(to in MOVE_STATUS)) throw new Error("BAD_PROGRESS");
  const task = await prisma.dailyTask.findFirst({ where: { id: taskId, userId, ...(await activeAssigned()) } });
  if (!task) throw new Error("NOT_FOUND");
  const from = stageOf(String(task.status), task.reviewedAt);
  if (from === to || (from === "AWAITING_CONFIRMATION" && to === "COMPLETED")) throw new Error("NO_CHANGE");
  if (!employeeMoveAllowed(from, to)) throw new Error(from === "CONFIRMED" ? "ALREADY_CONFIRMED" : "MOVE_NOT_ALLOWED");
  const note = String(noteRaw ?? "").trim() ? checkText("note", noteRaw, 1, 500) : null;
  const status = MOVE_STATUS[to];
  const res = await prisma.dailyTask.updateMany({
    // The row must still be exactly as we read it: a manager confirming at the same moment wins.
    where: { id: taskId, userId, status: task.status, reviewedAt: null },
    data: { status: status as never, completedAt: to === "COMPLETED" ? new Date() : null, ...(to === "COMPLETED" ? { completionNote: note } : {}) },
  });
  if (res.count === 0) throw new Error("CHANGED_ELSEWHERE");
  const toStage: AssignedStage = to === "COMPLETED" ? "AWAITING_CONFIRMATION" : to;
  await writeEvent(taskId, task.platformId, userId, to === "COMPLETED" ? "COMPLETED" : "UPDATE", { v: 1, t: "progress", from, to: toStage, note });
  auditNote({ summary: `Updated an assigned task to ${to === "COMPLETED" ? "Completed (waiting for confirmation)" : to === "IN_PROGRESS" ? "In progress" : "To do"}: ${task.title}`, recordType: "DailyTask", recordId: taskId, before: { stage: from }, after: { stage: toStage, note } });
  tell(taskId, userId, task.assignedById ?? userId, "status");
  const who = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  if (task.assignedById) {
    await notice([task.assignedById], to === "COMPLETED"
      ? { type: "ASSIGNED_TASK_DONE", title: "Assigned task waiting for confirmation", body: `${fullName(who)} marked it done: ${task.title}`, taskId, key: `asg:${taskId}:done:${Date.now()}`, link: "/dashboard/tasks?tab=assigned" }
      : { type: "ASSIGNED_TASK_PROGRESS", title: "Assigned task progress", body: `${fullName(who)} set it to ${to === "IN_PROGRESS" ? "In progress" : "To do"}: ${task.title}`, taskId, key: `asg:${taskId}:progress:${Date.now()}`, link: "/dashboard/tasks?tab=assigned" });
  }
  return listAssignedToMe(userId);
}

export async function commentAssigned(actorId: string, taskId: string, textRaw: unknown) {
  await ready();
  const text = checkText("comment", textRaw, 1, 500);
  const task = await prisma.dailyTask.findFirst({ where: { id: taskId, ...(await activeAssigned()) } });
  if (!task || (task.userId !== actorId && task.assignedById !== actorId)) throw new Error("NOT_FOUND");
  if (String(task.status) === "CANCELLED") throw new Error("NOT_FOUND");
  await writeEvent(taskId, task.platformId, actorId, "UPDATE", { v: 1, t: "comment", text });
  const other = actorId === task.userId ? task.assignedById : task.userId;
  tell(taskId, task.userId, task.assignedById ?? task.userId, "updated");
  const who = await prisma.user.findUnique({ where: { id: actorId }, select: { firstName: true, lastName: true } });
  if (other) await notice([other], { type: "ASSIGNED_TASK_COMMENT", title: "New comment on an assigned task", body: `${fullName(who)} on ${task.title}: ${text.slice(0, 120)}`, taskId, key: `asg:${taskId}:comment:${Date.now()}`, link: "/dashboard/tasks?tab=assigned" });
  return actorId === task.userId ? listAssignedToMe(actorId) : listAssignedByMe(actorId);
}

/** The step-by-step history: the employee and the manager who assigned it (and managers of that person). */
export async function historyAssigned(actorId: string, taskId: string) {
  await ready();
  const task = await prisma.dailyTask.findFirst({ where: { id: taskId, ...(await activeAssigned()) }, include: { user: PERSON, assignedBy: PERSON } });
  if (!task) throw new Error("NOT_FOUND");
  if (task.userId !== actorId && task.assignedById !== actorId) throw new Error("NOT_FOUND");
  const events = (await eventsOf([taskId])).get(taskId) ?? [];
  const names = await prisma.user.findMany({ where: { id: { in: [...new Set(events.map((e) => e.actorId))] } }, select: { id: true, firstName: true, lastName: true } });
  const nameOf = new Map(names.map((n) => [n.id, fullName(n)]));
  return {
    title: task.title,
    events: events.map((e) => ({ id: e.id, at: e.createdAt.toISOString(), by: nameOf.get(e.actorId) ?? "Someone", ...e.payload })),
  };
}
