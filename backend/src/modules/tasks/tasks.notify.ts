import { prisma } from "../../lib/prisma.js";
import { linkedManagerIdsOf } from "../../lib/reportingLinks.js";
import { notifyUsers } from "../../lib/notify.js";
import { onlyPinnedCompany } from "../../lib/deployment.js";
import { managerIdsByTeam } from "../../lib/teamManagers.js";
import { entryDetailsFor } from "./tasks.entry.js";

// ---------------------------------------------------------------------------
// TASK NOTIFICATIONS
//
// Who hears about what:
//   assigned                -> the person the task was given to
//   proposed (needs a yes)  -> the people who can approve it: the employee's reporting manager and the manager of
//                              each team they are in
//   submitted (marked done) -> the person who assigned it, the reporting manager, and the team managers
//   proposal approved/returned, work approved/not accepted -> the employee
// Never the person who did the action, never the same person twice for one event. A notification is created once
// per event (a repeated event is dropped by its dedupeKey) and reaches only its recipient.
//
// Posting a notification must never break the task action that caused it: everything here is caught and logged.
// ---------------------------------------------------------------------------

export type TaskEvent = "assigned" | "proposed" | "submitted" | "proposalApproved" | "proposalReturned" | "approved" | "notAccepted" | "rated" | "reverted";

const MANAGER_LINK = "/dashboard/approvals";
const EMPLOYEE_LINK = "/dashboard/tasks";

const name = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : "Someone");
const clip = (s: string | null | undefined, n = 140) => (s ? ` — ${s.trim().slice(0, n)}` : "");

// People above this employee: whoever assigned the task, their reporting manager, and the managers of their teams.
async function managersOf(ownerId: string, assignedById: string | null, exclude: string[]): Promise<string[]> {
  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { reportsToId: true, teamMemberships: { where: { isActive: true, team: { isActive: true } }, select: { teamId: true } } },
  });
  const ids = new Set<string>();
  if (assignedById) ids.add(assignedById);
  if (owner?.reportsToId) ids.add(owner.reportsToId);
  for (const m of (await linkedManagerIdsOf([ownerId])).get(ownerId) ?? []) ids.add(m); // additional reporting managers
  // primary manager AND every co-manager of each of the person's teams
  const byTeam = await managerIdsByTeam((owner?.teamMemberships ?? []).map((m) => m.teamId));
  for (const list of byTeam.values()) for (const id of list) ids.add(id);
  for (const x of exclude) ids.delete(x);
  if (ids.size === 0) return [];
  // Only people who can still sign in.
  const live = await prisma.user.findMany({ where: { id: { in: [...ids] }, status: { in: ["ACTIVE", "INVITED"] } }, select: { id: true } });
  return onlyPinnedCompany(live.map((u) => u.id));
}

// HR is told about tasks only after the manager has decided; never asked to approve one.
async function withoutHr(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return ids;
  const hr = await prisma.user.findMany({ where: { id: { in: ids }, role: "HR" }, select: { id: true } });
  const drop = new Set(hr.map((u) => u.id));
  return ids.filter((id) => !drop.has(id));
}

// A task tagged to an active manager is that manager's alone: only they are asked. Otherwise the earlier recipients (reporting manager + team managers).
async function reviewersOf(taskId: string, ownerId: string, assignedById: string | null, exclude: string[]): Promise<string[]> {
  const d = (await entryDetailsFor([taskId])).get(taskId);
  if (d?.taggedManagerId && d.taggedManagerActive) return exclude.includes(d.taggedManagerId) ? [] : onlyPinnedCompany([d.taggedManagerId]);
  return withoutHr(await managersOf(ownerId, assignedById, exclude));
}

// A recipient's notification belongs to THEIR company (a manager can sit in another company than the employee).
async function send(recipients: string[], base: { type: string; title: string; body: string; link: string; dedupeKey: string; data: Record<string, unknown> }) {
  if (recipients.length === 0) return;
  const people = await prisma.user.findMany({ where: { id: { in: recipients } }, select: { id: true, platformId: true } });
  const byPlatform = new Map<string, string[]>();
  for (const p of people) byPlatform.set(p.platformId, [...(byPlatform.get(p.platformId) ?? []), p.id]);
  for (const [platformId, userIds] of byPlatform) await notifyUsers({ platformId, userIds, ...base });
}

export async function taskNotice(event: TaskEvent, taskId: string, actorId: string, extra: { note?: string | null; partial?: boolean; stamp?: number; label?: string; stars?: number } = {}): Promise<void> {
  try {
    const task = await prisma.dailyTask.findUnique({
      where: { id: taskId },
      select: { id: true, title: true, userId: true, assignedById: true, user: { select: { firstName: true, lastName: true } } },
    });
    if (!task) return;
    const actor = await prisma.user.findUnique({ where: { id: actorId }, select: { firstName: true, lastName: true } });
    const owner = name(task.user);
    const by = name(actor);
    const stamp = extra.stamp ?? Date.now();
    const data = { taskId: task.id };

    if (event === "assigned") {
      if (task.userId === actorId) return;
      return send([task.userId], { type: "TASK_ASSIGNED", title: "New task assigned", body: `${by} assigned you: ${task.title}`, link: EMPLOYEE_LINK, dedupeKey: `task:${task.id}:assigned`, data });
    }
    if (event === "proposed") {
      return send(await reviewersOf(task.id, task.userId, null, [actorId, task.userId]), { type: "TASK_PROPOSED", title: "Task needs your approval", body: `${owner} proposed: ${task.title}`, link: MANAGER_LINK, dedupeKey: `task:${task.id}:proposed`, data });
    }
    if (event === "submitted") {
      return send(await reviewersOf(task.id, task.userId, task.assignedById, [actorId, task.userId]), { type: "TASK_SUBMITTED", title: "Work submitted for review", body: `${owner} marked done: ${task.title}`, link: MANAGER_LINK, dedupeKey: `task:${task.id}:submitted:${stamp}`, data });
    }
    // Everything below tells the employee about a manager's decision.
    if (task.userId === actorId) return;
    if (event === "proposalApproved") {
      return send([task.userId], { type: "TASK_PROPOSAL_APPROVED", title: "Your task was approved", body: `${by} approved: ${task.title}. You can start it.`, link: EMPLOYEE_LINK, dedupeKey: `task:${task.id}:proposal-approved:${stamp}`, data });
    }
    if (event === "proposalReturned") {
      return send([task.userId], { type: "TASK_PROPOSAL_RETURNED", title: "Your task was sent back", body: `${by} sent back: ${task.title}${clip(extra.note)}`, link: EMPLOYEE_LINK, dedupeKey: `task:${task.id}:proposal-returned:${stamp}`, data });
    }
    if (event === "approved") {
      return send([task.userId], { type: "TASK_APPROVED", title: "Your work was approved", body: `${by} approved: ${task.title}${extra.partial ? " (partially done)" : ""}${clip(extra.note)}`, link: EMPLOYEE_LINK, dedupeKey: `task:${task.id}:graded:${stamp}`, data });
    }
    if (event === "rated") {
      // Same notification type as before ("TASK_APPROVED") so the existing popup and inbox handling keep working.
      return send([task.userId], { type: "TASK_APPROVED", title: "Your work was rated", body: `${by} rated "${task.title}" ${extra.stars ?? "?"}/5${clip(extra.note)}`, link: EMPLOYEE_LINK, dedupeKey: `task:${task.id}:graded:${stamp}`, data });
    }
    if (event === "reverted") {
      // Every revert is its own event (a task can be reopened more than once), so the key carries the moment.
      return send([task.userId], { type: "TASK_REVERTED", title: "Your task was reopened", body: `${by} reopened: ${task.title}${extra.label ? ` (${extra.label})` : ""}${clip(extra.note, 200)}`, link: EMPLOYEE_LINK, dedupeKey: `task:${task.id}:reverted:${stamp}`, data });
    }
    if (event === "notAccepted") {
      return send([task.userId], { type: "TASK_REJECTED", title: "Your work was not accepted", body: `${by} marked it not done: ${task.title}${clip(extra.note)}`, link: EMPLOYEE_LINK, dedupeKey: `task:${task.id}:graded:${stamp}`, data });
    }
  } catch (e) {
    console.error("[tasks] could not create the notification:", e instanceof Error ? e.message : e);
  }
}
