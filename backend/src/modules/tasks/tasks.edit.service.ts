// EDITING A SUBMITTED TASK.
//
//  - Pending or sent back (not rated): the owner edits it directly and it waits for approval again (`editMyTask`).
//  - Approved or rated: no direct edit. The owner sends a correction request (`requestCorrection`); the tagged manager approves or declines it
//    (`decideCorrection`). Nothing changes until it is approved, and the original values, approval and rating are kept in the history.
//  - Every step is one row of history (tasks.edit.logic.ts) written in the SAME transaction as the change, so a change without its history cannot happen.
//  - Two edits at once, or an edit while the manager decides, cannot both win: a per-task lock, a version token and a guarded update.
// The server enforces every rule here; the screen only hides what is not allowed.

import { prisma } from "../../lib/prisma.js";
import { parseIsoDay, platformToday } from "../../lib/dates.js";
import { auditNote } from "../../lib/auditContext.js";
import { accessFor, scopeWhere } from "../../lib/companyAccess.js";
import { emitTaskChange } from "../../lib/realtime.js";
import { onlyPinnedCompany } from "../../lib/deployment.js";
import { detailsFor } from "./tasks.self.js";
import { activeTasks } from "./tasks.deleted.js";
import { isRated, ratingReady, withRatings } from "./tasks.rating.js";
import { entryDetailsFor, entryReady, resolveTaggedManager, type EntryDetail } from "./tasks.entry.js";
import { allowedDaysFor, lateReady } from "./tasks.late.js";
import { checkBackdate } from "./tasks.late.logic.js";
import { parseHours, parseProgress, storeProgress, progressOf, checkBlockedReason, mayReview, PROGRESS_LABEL } from "./tasks.entry.logic.js";
import { taskNotice } from "./tasks.notify.js";
import { actingUserIds, assertCanReviewTask, listTasks, mayUseReviewActions, resolveProject, userContext } from "./tasks.service.js";
import { changeEvents, changesReady, taskIdsWithChangesSince, writeChange } from "./tasks.edit.js";
import { detectAfterSubmit } from "./repetition.detect.js";
import {
  CORRECTION_FIELDS, DIRECT_FIELDS, FIELD_LABEL, checkReason, deriveRequests, diffSnapshots, editRoute, parseVersion, pendingRequest, pickChanged, versionOf,
  type ChangePayload, type Field, type RequestView, type Snapshot,
} from "./tasks.edit.logic.js";

const WEIGHTS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const MANAGING_ROLES = ["MANAGER", "HR", "ADMIN"];

type TaskRow = NonNullable<Awaited<ReturnType<typeof loadOwnTask>>>;

async function loadOwnTask(userId: string, taskId: string) {
  const task = await prisma.dailyTask.findUnique({ where: { id: taskId, ...(await activeTasks()) }, include: { team: { select: { name: true } } } });
  // Someone else's task, or none: the same answer, so nothing is revealed.
  if (!task || task.userId !== userId) return null;
  return task;
}

function snapshotOf(task: { title: string; description: string | null; teamId: string | null; weight: unknown; status: unknown; date: Date; team?: { name: string } | null }, entry: EntryDetail | undefined, projectName?: string | null): Snapshot {
  const blocked = entry?.blocked === true && String(task.status) !== "COMPLETED";
  return {
    title: task.title,
    description: task.description ?? null,
    projectId: task.teamId,
    project: projectName !== undefined ? projectName : task.team?.name ?? null,
    managerId: entry?.taggedManagerId ?? null,
    manager: entry?.taggedManagerName ?? null,
    date: task.date.toISOString().slice(0, 10),
    hoursSpent: entry?.hoursSpent ?? null,
    priority: String(task.weight),
    progress: progressOf(String(task.status), blocked),
    blockedReason: blocked ? entry?.blockedNote ?? null : null,
  };
}

const label = (fields: string[]) => [...new Set(fields.map((f) => FIELD_LABEL[f as Field] ?? f))];

type Parsed = { next: Snapshot; changed: Field[]; late: ReturnType<typeof checkBackdate> | null; lateAllowedDays: number; newDate: Date | null };

/**
 * The task as it would be after the edit, validated with the SAME rules the submit form uses (project, tagged manager, hours, priority, progress, the
 * Blocked reason, the backdated-task window). Anything not sent stays as it is.
 */
async function parseProposed(owner: { id: string; platformId: string; timezone: string }, before: Snapshot, body: Record<string, unknown>, allowed: Field[], opts: { correction: boolean }): Promise<Parsed> {
  const next: Snapshot = { ...before };

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) throw new Error("TITLE_REQUIRED");
    if (title.length > 200) throw new Error("TITLE_TOO_LONG");
    next.title = title;
  }
  if (body.description !== undefined) next.description = body.description ? String(body.description).trim().slice(0, 2000) || null : null;

  const projectGiven = body.teamId !== undefined ? body.teamId : body.projectId;
  if (projectGiven !== undefined && String(projectGiven ?? "") !== String(before.projectId ?? "")) {
    const id = await resolveProject(owner.id, projectGiven ?? null, true, owner.platformId);
    next.projectId = id;
    next.project = id ? (await prisma.team.findUnique({ where: { id }, select: { name: true } }))?.name ?? null : null;
  }

  if (body.taggedManagerId !== undefined && String(body.taggedManagerId ?? "") !== String(before.managerId ?? "")) {
    if (opts.correction) throw new Error("CORRECTION_FIELD_NOT_ALLOWED");
    const id = await resolveTaggedManager({ id: owner.id, platformId: owner.platformId }, body.taggedManagerId);
    next.managerId = id;
    next.manager = id ? await prisma.user.findUnique({ where: { id }, select: { firstName: true, lastName: true } }).then((u) => (u ? `${u.firstName} ${u.lastName}`.trim() : null)) : null;
  }

  let late: ReturnType<typeof checkBackdate> | null = null;
  let lateAllowedDays = 0;
  let newDate: Date | null = null;
  if (body.date !== undefined && String(body.date) !== before.date) {
    if (opts.correction) throw new Error("CORRECTION_FIELD_NOT_ALLOWED");
    newDate = parseIsoDay(body.date);
    const today = platformToday(owner.timezone);
    if (newDate.getTime() > today.getTime()) throw new Error("DATE_IN_FUTURE");
    next.date = newDate.toISOString().slice(0, 10);
    if (newDate.getTime() < today.getTime()) {
      // Moving a task to an earlier day follows the backdated-task policy: inside the window freely, outside it with a written reason, never past the limit.
      if (!(await lateReady())) throw new Error("FEATURES_NOT_READY");
      lateAllowedDays = await allowedDaysFor(owner.platformId);
      late = checkBackdate({ forDate: newDate, today, allowedDays: lateAllowedDays, reason: body.lateReason });
    }
  }

  if (body.hoursSpent !== undefined) {
    const h = parseHours(body.hoursSpent);
    if (h === "BAD") throw new Error("BAD_HOURS");
    next.hoursSpent = h;
  }
  const weight = body.weight !== undefined ? body.weight : body.priority;
  if (weight !== undefined) {
    if (!WEIGHTS.includes(String(weight))) throw new Error("BAD_WEIGHT");
    next.priority = String(weight);
  }
  if (body.progress !== undefined) {
    const p = parseProgress(body.progress);
    if (p === null || p === "BAD") throw new Error("BAD_PROGRESS");
    next.progress = p;
  }
  // Blocked always carries a reason (the one just given, or the one it already has); any other progress clears it.
  if (next.progress === "BLOCKED") next.blockedReason = checkBlockedReason(body.blockedNote !== undefined ? body.blockedNote : before.blockedReason);
  else next.blockedReason = null;

  return { next, changed: diffSnapshots(before, next, allowed), late, lateAllowedDays, newDate };
}

/** Applies a validated snapshot to the task rows, inside the caller's transaction. */
async function applySnapshot(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], task: { id: string; platformId: string; status: unknown }, next: Snapshot, opts: { resubmit: boolean; newDate: Date | null }) {
  const st = storeProgress(next.progress as never);
  const wasCompleted = String(task.status) === "COMPLETED";
  const data: Record<string, unknown> = {
    title: next.title,
    description: next.description,
    teamId: next.projectId,
    weight: next.priority as never,
    status: st.status as never,
  };
  if (opts.newDate) data.date = opts.newDate;
  if (st.status === "COMPLETED" && !wasCompleted) data.completedAt = new Date();
  if (st.status !== "COMPLETED" && wasCompleted) data.completedAt = null;
  if (opts.resubmit) Object.assign(data, { approvalStatus: "PENDING", rejectionNote: null, approvedById: null, approvedAt: null });
  const allowedApproval = opts.resubmit ? ["PENDING", "REJECTED"] : ["APPROVED"];
  return { data, st, allowedApproval };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1. DIRECT EDIT (pending or sent back)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function editMyTask(userId: string, taskId: string, body: Record<string, unknown>) {
  const ctx = await userContext(userId);
  const task = await loadOwnTask(userId, taskId);
  if (!task) throw new Error("NOT_FOUND");
  if ((await detailsFor([taskId])).has(taskId)) throw new Error("SELF_MANAGED_ONLY");
  if (task.assignedById) throw new Error("ASSIGNED_CANNOT_EDIT");
  if (!(await entryReady()) || !(await changesReady())) throw new Error("FEATURES_NOT_READY");

  const rated = await isRated(task);
  if (editRoute(String(task.approvalStatus), rated) === "CORRECTION") throw new Error("USE_CORRECTION");

  const expected = parseVersion(body.version);
  if (expected === null) throw new Error("VERSION_REQUIRED");

  const entry = (await entryDetailsFor([taskId])).get(taskId);
  if (versionOf(task.updatedAt, entry?.updatedAt) !== expected) throw new Error("EDITED_ELSEWHERE");

  const before = snapshotOf(task, entry);
  const parsed = await parseProposed({ id: userId, platformId: ctx.platformId, timezone: ctx.timezone }, before, body, DIRECT_FIELDS, { correction: false });
  if (parsed.changed.length === 0) throw new Error("NOTHING_TO_UPDATE");

  const approvalBefore = String(task.approvalStatus);
  const resubmit = true; // a pending task stays pending; a sent-back task goes back for approval
  const previousRejection = approvalBefore === "REJECTED" ? task.rejectionNote ?? null : null;
  const payload: ChangePayload = {
    v: 1,
    type: "EDIT",
    changed: parsed.changed,
    before: pickChanged(before, parsed.changed),
    after: pickChanged(parsed.next, parsed.changed),
    approvalBefore,
    approvalAfter: "PENDING",
    previousRejection,
  };

  await prisma.$transaction(async (tx) => {
    // One edit at a time per task, whoever sends it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"taskedit:" + taskId}))`;
    const cur = await tx.dailyTask.findUnique({ where: { id: taskId }, select: { updatedAt: true, approvalStatus: true, status: true } });
    const curEntry = await tx.taskEntryDetail.findUnique({ where: { taskId }, select: { updatedAt: true } });
    if (!cur || versionOf(cur.updatedAt, curEntry?.updatedAt) !== expected) throw new Error("EDITED_ELSEWHERE");
    const { data, st } = await applySnapshot(tx, { id: taskId, platformId: task.platformId, status: cur.status }, parsed.next, { resubmit, newDate: parsed.newDate });
    // The approval is re-checked by the update itself: a manager who approved a moment ago wins and the edit is refused.
    const claim = await tx.dailyTask.updateMany({ where: { id: taskId, approvalStatus: { in: ["PENDING", "REJECTED"] as never }, updatedAt: cur.updatedAt }, data: data as never });
    if (claim.count !== 1) throw new Error("EDITED_ELSEWHERE");
    await tx.taskEntryDetail.upsert({
      where: { taskId },
      update: { hoursSpent: parsed.next.hoursSpent, taggedManagerId: parsed.next.managerId, blocked: st.blocked, blockedNote: st.blocked ? parsed.next.blockedReason : null },
      create: { taskId, platformId: task.platformId, hoursSpent: parsed.next.hoursSpent, taggedManagerId: parsed.next.managerId, blocked: st.blocked, blockedNote: st.blocked ? parsed.next.blockedReason : null },
    });
    if (parsed.newDate && (await lateReady())) {
      if (parsed.late) {
        await tx.taskLateDetail.upsert({
          where: { taskId },
          update: { lateByDays: parsed.late.lateByDays, outsideWindow: parsed.late.outsideWindow, allowedDays: parsed.lateAllowedDays, reason: parsed.late.reason },
          create: { platformId: task.platformId, taskId, userId, lateByDays: parsed.late.lateByDays, outsideWindow: parsed.late.outsideWindow, allowedDays: parsed.lateAllowedDays, reason: parsed.late.reason },
        });
      } else {
        await tx.taskLateDetail.deleteMany({ where: { taskId } }); // moved back to today: no longer a late submission
      }
    }
    await writeChange(tx, { taskId, platformId: task.platformId, actorId: userId, payload });
  });

  auditNote({
    summary: `Edited the task "${task.title.slice(0, 80)}" (${label(parsed.changed).join(", ")})${approvalBefore === "REJECTED" ? " and sent it back for approval" : ""}`,
    targetUserId: userId,
    before: { ...payload.before, approvalStatus: approvalBefore, manager: before.manager },
    after: { ...payload.after, approvalStatus: "PENDING", manager: parsed.next.manager },
  });
  emitTaskChange({ taskId, ownerId: userId, action: "updated" });
  await taskNotice("edited", taskId, userId, {
    resubmitted: approvalBefore === "REJECTED",
    oldManagerId: before.managerId && before.managerId !== parsed.next.managerId ? before.managerId : null,
    stamp: Date.now(),
  });
  detectAfterSubmit(userId); // a reworded or re-dated task may now match others: check in the background
  return listTasks(userId);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2. CORRECTION REQUEST (approved or rated)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function requestCorrection(userId: string, taskId: string, body: Record<string, unknown>) {
  const ctx = await userContext(userId);
  const task = await loadOwnTask(userId, taskId);
  if (!task) throw new Error("NOT_FOUND");
  if ((await detailsFor([taskId])).has(taskId)) throw new Error("SELF_MANAGED_ONLY");
  if (task.assignedById) throw new Error("ASSIGNED_CANNOT_EDIT");
  if (!(await entryReady()) || !(await changesReady())) throw new Error("FEATURES_NOT_READY");
  const rated = await isRated(task);
  if (editRoute(String(task.approvalStatus), rated) === "DIRECT") throw new Error("USE_EDIT");

  const reason = checkReason(body.reason);
  const entry = (await entryDetailsFor([taskId])).get(taskId);
  const before = snapshotOf(task, entry);
  const parsed = await parseProposed({ id: userId, platformId: ctx.platformId, timezone: ctx.timezone }, before, body, CORRECTION_FIELDS, { correction: true });
  if (parsed.changed.length === 0) throw new Error("NOTHING_TO_UPDATE");

  const payload: ChangePayload = {
    v: 1,
    type: "CORRECTION_REQUESTED",
    changed: parsed.changed,
    before: pickChanged(before, parsed.changed),
    after: pickChanged(parsed.next, parsed.changed),
    approvalBefore: String(task.approvalStatus),
    approvalAfter: String(task.approvalStatus), // nothing changes until a manager approves it
    reason,
  };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"taskedit:" + taskId}))`;
    const evs = await changeEvents([taskId], tx as never);
    if (pendingRequest(evs.get(taskId) ?? [])) throw new Error("CORRECTION_ALREADY_PENDING"); // a double click, or a second request, makes no second row
    const live = await tx.dailyTask.findUnique({ where: { id: taskId }, select: { approvalStatus: true } });
    if (!live || !["APPROVED"].includes(String(live.approvalStatus))) throw new Error("EDITED_ELSEWHERE");
    await writeChange(tx, { taskId, platformId: task.platformId, actorId: userId, payload });
  });
  auditNote({ summary: `Asked for a correction to "${task.title.slice(0, 80)}" (${label(parsed.changed).join(", ")}): ${reason}`, targetUserId: userId, before: payload.before, after: payload.after });
  emitTaskChange({ taskId, ownerId: userId, action: "updated" });
  await taskNotice("correctionRequested", taskId, userId, { note: reason, stamp: Date.now() });
  return listTasks(userId);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 3. THE MANAGER'S DECISION
// ---------------------------------------------------------------------------------------------------------------------------------------------
export async function decideCorrection(actorId: string, taskId: string, body: { requestId?: unknown; approve?: unknown; note?: unknown }) {
  const ctx = await userContext(actorId);
  if (!(await mayUseReviewActions(ctx, actorId))) throw new Error("NOT_ALLOWED");
  const actor = { id: actorId, role: ctx.role, platformId: ctx.platformId };
  if (typeof body.approve !== "boolean") throw new Error("BAD_DECISION");
  const requestId = typeof body.requestId === "string" ? body.requestId : "";
  if (!requestId) throw new Error("CORRECTION_NOT_FOUND");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
  if (!body.approve && note.length < 3) throw new Error("DECISION_NOTE_REQUIRED");
  if (!(await changesReady())) throw new Error("FEATURES_NOT_READY");

  const task = await prisma.dailyTask.findUnique({ where: { id: taskId, ...(await activeTasks()) }, include: { team: { select: { name: true } } } });
  if (!task) throw new Error("NOT_FOUND");
  if (task.userId === actorId) throw new Error("NOT_YOUR_OWN_TASK");
  // The same strict rule as approving a task: the tagged manager (or, for an untagged old task, the project / reporting line). HR and Admin are
  // never deciders by role.
  await assertCanReviewTask(actor, task, true);

  const ownerCtx = await userContext(task.userId);
  const found = deriveRequests((await changeEvents([taskId])).get(taskId) ?? []).find((r) => r.id === requestId);
  if (!found) throw new Error("CORRECTION_NOT_FOUND");
  if (found.state !== "PENDING") throw new Error("CORRECTION_ALREADY_DECIDED");
  const entry = (await entryDetailsFor([taskId])).get(taskId);

  // Re-validate what was asked for against today's rules (the project may no longer be offered, the blocked reason must still be real).
  const req = found.payload;
  const before = snapshotOf(task, entry);
  const body2: Record<string, unknown> = {};
  for (const k of req.changed as Field[]) {
    const v = (req.after as Record<string, unknown>)[k];
    if (k === "projectId") body2.teamId = v;
    else if (k === "priority") body2.weight = v;
    else if (k === "blockedReason") body2.blockedNote = v;
    else body2[k] = v;
  }
  if (req.changed.includes("progress") === false && before.progress === "BLOCKED") body2.blockedNote = before.blockedReason;

  const decisionBase = { v: 1 as const, requestId, changed: req.changed, approvalBefore: String(task.approvalStatus), approvalAfter: String(task.approvalStatus) };

  if (!body.approve) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"taskedit:" + taskId}))`;
      const again = deriveRequests((await changeEvents([taskId], tx as never)).get(taskId) ?? []).find((r) => r.id === requestId);
      if (!again || again.state !== "PENDING") throw new Error("CORRECTION_ALREADY_DECIDED");
      await writeChange(tx, { taskId, platformId: task.platformId, actorId, payload: { ...decisionBase, type: "CORRECTION_REJECTED", before: req.before, after: req.after, decisionNote: note } });
    });
    auditNote({ summary: `Declined a correction to "${task.title.slice(0, 80)}": ${note}`, targetUserId: task.userId, before: req.before, after: req.after });
    emitTaskChange({ taskId, ownerId: task.userId, action: "updated" });
    await taskNotice("correctionDecided", taskId, actorId, { note, label: "declined", stamp: Date.now() });
    return pendingCorrections(actorId);
  }

  const parsed = await parseProposed({ id: task.userId, platformId: ownerCtx.platformId, timezone: ownerCtx.timezone }, before, body2, CORRECTION_FIELDS, { correction: true });
  if (parsed.changed.length === 0) throw new Error("NOTHING_TO_UPDATE"); // already the same: nothing left to apply
  let ratingCopy: ChangePayload["rating"] = null;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"taskedit:" + taskId}))`;
    const again = deriveRequests((await changeEvents([taskId], tx as never)).get(taskId) ?? []).find((r) => r.id === requestId);
    if (!again || again.state !== "PENDING") throw new Error("CORRECTION_ALREADY_DECIDED"); // two managers, or a double click: only one decision is recorded
    const cur = await tx.dailyTask.findUnique({ where: { id: taskId }, select: { updatedAt: true, status: true } });
    if (!cur) throw new Error("NOT_FOUND");
    const { data, st } = await applySnapshot(tx, { id: taskId, platformId: task.platformId, status: cur.status }, parsed.next, { resubmit: false, newDate: null });
    // The approval stays exactly as it was (who approved and when is preserved); only the task's own details change.
    const claim = await tx.dailyTask.updateMany({ where: { id: taskId, approvalStatus: "APPROVED" as never, updatedAt: cur.updatedAt }, data: data as never });
    if (claim.count !== 1) throw new Error("EDITED_ELSEWHERE");
    await tx.taskEntryDetail.upsert({
      where: { taskId },
      update: { hoursSpent: parsed.next.hoursSpent, blocked: st.blocked, blockedNote: st.blocked ? parsed.next.blockedReason : null },
      create: { taskId, platformId: task.platformId, hoursSpent: parsed.next.hoursSpent, taggedManagerId: parsed.next.managerId, blocked: st.blocked, blockedNote: st.blocked ? parsed.next.blockedReason : null },
    });
    // A rated task loses its rating (owner's choice) and returns to the manager's to-rate list. The rating and feedback are copied into the history first.
    if (await ratingReady()) {
      const r = await tx.taskRating.findUnique({ where: { taskId } });
      if (r) {
        ratingCopy = { rating: r.rating, comment: r.comment ?? null, ratedBy: r.ratedById ?? null, ratedAt: r.ratedAt.toISOString() };
        await tx.taskRating.delete({ where: { taskId } });
      }
    }
    await writeChange(tx, {
      taskId, platformId: task.platformId, actorId,
      payload: { ...decisionBase, type: "CORRECTION_APPROVED", changed: parsed.changed, before: pickChanged(before, parsed.changed), after: pickChanged(parsed.next, parsed.changed), decisionNote: note || null, rating: ratingCopy, ratingCleared: ratingCopy !== null },
    });
  });
  auditNote({
    summary: `Approved a correction to "${task.title.slice(0, 80)}" (${label(parsed.changed).join(", ")})${ratingCopy ? ", the rating was cleared for re-rating" : ""}`,
    targetUserId: task.userId,
    before: { ...pickChanged(before, parsed.changed), rating: ratingCopy },
    after: pickChanged(parsed.next, parsed.changed),
  });
  emitTaskChange({ taskId, ownerId: task.userId, action: "updated" });
  await taskNotice("correctionDecided", taskId, actorId, { note: note || null, label: "approved", stamp: Date.now() });
  return pendingCorrections(actorId);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 4. WHAT A MANAGER MAY DECIDE, AND THE HISTORY OF A TASK
// ---------------------------------------------------------------------------------------------------------------------------------------------
const nameOf = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : "Someone");

/** Correction requests waiting for THIS person (only tasks they would be allowed to approve; never HR or Admin by role). */
export async function pendingCorrections(viewerId: string) {
  const ctx = await userContext(viewerId);
  if (!(await mayUseReviewActions(ctx, viewerId))) throw new Error("NOT_ALLOWED");
  if (!(await changesReady())) return { ready: false, corrections: [] as unknown[] };
  const ids = await taskIdsWithChangesSince(new Date(Date.now() - 180 * 86_400_000));
  if (ids.length === 0) return { ready: true, corrections: [] as unknown[] };
  const [events, rawTasks, entries, acting] = await Promise.all([
    changeEvents(ids),
    prisma.dailyTask.findMany({ where: { id: { in: ids }, ...(await activeTasks()) }, include: { team: { select: { name: true } }, user: { select: { firstName: true, lastName: true, employeeCode: true } } } }),
    entryDetailsFor(ids),
    actingUserIds({ id: viewerId }),
  ]);
  const pinned = new Set(await onlyPinnedCompany([...new Set(rawTasks.map((t) => t.userId))]));
  const tasks = await withRatings(rawTasks.filter((t) => pinned.has(t.userId)));
  const out: Array<Record<string, unknown>> = [];
  for (const t of tasks) {
    if (t.userId === viewerId) continue;
    const pending = pendingRequest(events.get(t.id) ?? []);
    if (!pending) continue;
    const d = entries.get(t.id);
    const canAct = ctx.role === "HR"
      ? !!d?.taggedManagerId && d.taggedManagerActive && d.taggedManagerId === viewerId
      : mayReview({ actorId: viewerId, taggedId: d?.taggedManagerId ?? null, taggedActive: d?.taggedManagerActive ?? false, legacyOk: acting.has(t.userId) });
    if (!canAct) continue;
    out.push({
      taskId: t.id,
      requestId: pending.id,
      requestedAt: pending.at.toISOString(),
      employee: nameOf(t.user),
      employeeCode: t.user.employeeCode,
      title: t.title,
      date: t.date.toISOString().slice(0, 10),
      project: t.team?.name ?? null,
      approvalStatus: String(t.approvalStatus),
      rated: t.rating != null,
      rating: t.rating ?? null,
      ratingComment: t.ratingComment ?? null,
      reason: pending.payload.reason ?? null,
      changed: label(pending.payload.changed),
      before: pending.payload.before,
      after: pending.payload.after,
    });
  }
  out.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
  return { ready: true, corrections: out };
}

/** The full change history of one task: the owner, the people who can review it, and HR / Admin inside their company scope. Anyone else gets "not found". */
export async function taskChanges(viewerId: string, taskId: string) {
  const ctx = await userContext(viewerId);
  const task = await prisma.dailyTask.findUnique({ where: { id: taskId, ...(await activeTasks()) }, include: { user: { select: { firstName: true, lastName: true, employeeCode: true } }, team: { select: { name: true } } } });
  if (!task) throw new Error("NOT_FOUND");
  let allowed = task.userId === viewerId;
  if (!allowed && (await mayUseReviewActions(ctx, viewerId))) {
    try {
      await assertCanReviewTask({ id: viewerId, role: ctx.role, platformId: ctx.platformId }, task);
      allowed = true;
    } catch {
      allowed = false;
    }
    if (!allowed && (ctx.role === "HR" || ctx.role === "ADMIN")) {
      allowed = !!(await prisma.user.findFirst({ where: { id: task.userId, ...scopeWhere(await accessFor(viewerId)) }, select: { id: true } }));
    }
  }
  if (!allowed) throw new Error("NOT_FOUND");
  if (!(await changesReady())) return { ready: false, task: null, changes: [], pending: null };

  const events = (await changeEvents([taskId])).get(taskId) ?? [];
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set(events.map((e) => e.actorId))] } }, select: { id: true, firstName: true, lastName: true, role: true } });
  const by = new Map(people.map((p) => [p.id, { name: nameOf(p), role: String(p.role) }]));
  const requests = new Map<string, RequestView>(deriveRequests(events).map((r) => [r.id, r]));
  const pending = pendingRequest(events);
  return {
    ready: true,
    task: { id: task.id, title: task.title, employee: nameOf(task.user), employeeCode: task.user.employeeCode, date: task.date.toISOString().slice(0, 10), project: task.team?.name ?? null, approvalStatus: String(task.approvalStatus) },
    changes: events
      .map((e) => ({
        id: e.id,
        type: e.payload.type,
        at: e.createdAt.toISOString(),
        by: by.get(e.actorId)?.name ?? "Someone",
        byRole: by.get(e.actorId)?.role ?? null,
        changed: label(e.payload.changed),
        before: e.payload.before,
        after: e.payload.after,
        approvalBefore: e.payload.approvalBefore,
        approvalAfter: e.payload.approvalAfter,
        reason: e.payload.reason ?? null,
        decisionNote: e.payload.decisionNote ?? null,
        previousRejection: e.payload.previousRejection ?? null,
        rating: e.payload.rating ?? null,
        ratingCleared: e.payload.ratingCleared === true,
        requestId: e.payload.requestId ?? (e.payload.type === "CORRECTION_REQUESTED" ? e.id : null),
        state: e.payload.type === "CORRECTION_REQUESTED" ? requests.get(e.id)?.state ?? null : null,
      }))
      .reverse(), // newest first
    pending: pending ? { requestId: pending.id, at: pending.at.toISOString() } : null,
  };
}
