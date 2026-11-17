// Repetitive task detection: reading the tasks, comparing them (rules in repetition.logic.ts) and raising or updating flags.
// It runs in the BACKGROUND a moment after a task is submitted, never delaying or failing the submission, and it only ever WRITES to the flag tables:
// no task, rating, attendance or productivity figure is read for change or changed here.
import { prisma } from "../../lib/prisma.js";
import { activeTasks } from "./tasks.deleted.js";
import { selfManagedIds } from "./tasks.self.js";
import { notifyUsers } from "../../lib/notify.js";
import { deciderIdsForCompany } from "../../lib/companyAccess.js";
import { coveredBy, detect, lookbackDays, type Candidate, type TaskLite } from "./repetition.logic.js";
import { isMissingTable, loadSettings, repetitionReady } from "./repetition.store.js";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Raise or update flags for these people. Returns how many NEW flags were raised. */
export async function detectForUsers(userIds: string[]): Promise<number> {
  if (userIds.length === 0 || !(await repetitionReady())) return 0;
  const settings = await loadSettings();
  if (!settings.enabled) return 0;

  const since = new Date(Date.now() - lookbackDays(settings) * 86400000);
  since.setUTCHours(0, 0, 0, 0);
  const [people, rows] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds }, status: "ACTIVE" as never }, select: { id: true, platformId: true, reportsToId: true, firstName: true, lastName: true, employeeCode: true } }),
    // Employee-SUBMITTED tasks only: activeTasks() leaves out deleted tasks and manager-assigned tasks.
    prisma.dailyTask.findMany({
      where: { userId: { in: userIds }, date: { gte: since }, status: { not: "CANCELLED" as never }, approvalStatus: { not: "REJECTED" as never }, ...(await activeTasks()) },
      select: { id: true, userId: true, teamId: true, date: true, title: true, description: true, status: true, approvalStatus: true },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  const selfIds = await selfManagedIds(rows.map((r) => r.id)); // a manager's own tasks are not "submitted" work
  const active = new Set(people.map((p) => p.id));
  const tasks: TaskLite[] = rows
    .filter((r) => active.has(r.userId) && !selfIds.has(r.id))
    .map((r) => ({ id: r.id, userId: r.userId, teamId: r.teamId, date: iso(r.date), title: r.title, description: r.description, status: String(r.status), approvalStatus: String(r.approvalStatus) }));
  const candidates = detect(tasks, settings);
  if (candidates.length === 0) return 0;

  // Existing flags of these people, with their task ids (to recognise the same pattern).
  const existing = await prisma.repetitionFlag.findMany({
    where: { userId: { in: [...new Set(candidates.map((c) => c.userId))] } },
    select: { id: true, userId: true, status: true, lastDate: true, repeatCount: true },
  });
  const links = existing.length ? await prisma.repetitionFlagTask.findMany({ where: { flagId: { in: existing.map((f) => f.id) } }, select: { flagId: true, taskId: true } }) : [];
  const idsOf = new Map<string, string[]>();
  for (const l of links) idsOf.set(l.flagId, [...(idsOf.get(l.flagId) ?? []), l.taskId]);

  let raised = 0;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const c of candidates) {
    const mine = existing.filter((f) => f.userId === c.userId).map((f) => ({ id: f.id, status: f.status, taskIds: idsOf.get(f.id) ?? [], lastDate: iso(f.lastDate) }));
    const cover = coveredBy(c, mine);
    if (cover) {
      if (cover.status === "NEW" || cover.status === "UNDER_REVIEW") await refresh(cover.id, c, byId, idsOf.get(cover.id) ?? []);
      continue; // Valid / False positive / Resolved: the pattern is already known, never raise it twice
    }
    const person = people.find((p) => p.id === c.userId);
    if (!person) continue;
    const created = await raise(person, c, byId);
    if (created) raised++;
  }
  return raised;
}

async function refresh(flagId: string, c: Candidate, byId: Map<string, TaskLite>, haveIds: string[]) {
  try {
    const fresh = c.taskIds.filter((t) => !haveIds.includes(t));
    await prisma.$transaction(async (tx) => {
      if (fresh.length) {
        await tx.repetitionFlagTask.createMany({
          data: fresh.map((id) => { const t = byId.get(id)!; return { flagId, taskId: id, taskDate: new Date(t.date), title: t.title, description: t.description, status: t.status, approvalStatus: t.approvalStatus }; }),
          skipDuplicates: true,
        });
      }
      const total = await tx.repetitionFlagTask.count({ where: { flagId } });
      await tx.repetitionFlag.update({ where: { id: flagId }, data: { repeatCount: Math.max(total, 2), lastDate: new Date(c.lastDate), similarity: c.similarity, lastDetectedAt: new Date(), ...(fresh.length ? { reason: c.reason } : {}) } });
      if (fresh.length) await tx.repetitionFlagEvent.create({ data: { flagId, actorId: null, kind: "UPDATED", note: `${fresh.length} more matching ${fresh.length === 1 ? "entry" : "entries"} found (now ${total}). No new notification is sent for the same pattern.` } });
    });
  } catch (e) {
    if (!isMissingTable(e)) console.error("[repetition] refresh failed:", e instanceof Error ? e.message : e);
  }
}

async function raise(person: { id: string; platformId: string; reportsToId: string | null; firstName: string; lastName: string; employeeCode: string | null }, c: Candidate, byId: Map<string, TaskLite>): Promise<boolean> {
  let flagId = "";
  try {
    await prisma.$transaction(async (tx) => {
      // one detection per person at a time, so two submissions at the same moment cannot raise the same flag twice
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtext(${"repetition:" + person.id}))`;
      const dup = await tx.repetitionFlag.findFirst({ where: { userId: person.id, patternKey: c.patternKey, status: { not: "RESOLVED" } }, select: { id: true } });
      if (dup) return;
      const f = await tx.repetitionFlag.create({
        data: { platformId: person.platformId, userId: person.id, teamId: c.teamId, patternKey: c.patternKey, sampleTitle: c.sampleTitle.slice(0, 200), repeatCount: c.count, firstDate: new Date(c.firstDate), lastDate: new Date(c.lastDate), similarity: c.similarity, reason: c.reason, status: "NEW" },
        select: { id: true },
      });
      await tx.repetitionFlagTask.createMany({
        data: c.taskIds.map((id) => { const t = byId.get(id)!; return { flagId: f.id, taskId: id, taskDate: new Date(t.date), title: t.title, description: t.description, status: t.status, approvalStatus: t.approvalStatus }; }),
      });
      await tx.repetitionFlagEvent.create({ data: { flagId: f.id, actorId: null, kind: "DETECTED", toStatus: "NEW", note: c.reason } });
      flagId = f.id;
    });
  } catch (e) {
    if (!isMissingTable(e)) console.error("[repetition] raise failed:", e instanceof Error ? e.message : e);
    return false;
  }
  if (!flagId) return false;
  await notifyNew(flagId, person, c);
  return true;
}

/** The reporting manager hears about a NEW flag (once). With no usable reporting manager, the company's HR/Admin do. */
async function notifyNew(flagId: string, person: { id: string; platformId: string; reportsToId: string | null; firstName: string; lastName: string; employeeCode: string | null }, c: Candidate) {
  try {
    let to: string[] = [];
    if (person.reportsToId) {
      const m = await prisma.user.findFirst({ where: { id: person.reportsToId, status: "ACTIVE" as never, role: { in: ["MANAGER", "ADMIN", "HR"] as never } }, select: { id: true } });
      if (m) to = [m.id];
    }
    if (to.length === 0) to = await deciderIdsForCompany(person.platformId, person.id);
    if (to.length === 0) return;
    const people = await prisma.user.findMany({ where: { id: { in: to } }, select: { id: true, platformId: true } });
    const by = new Map<string, string[]>();
    for (const p of people) by.set(p.platformId, [...(by.get(p.platformId) ?? []), p.id]);
    const name = `${person.firstName} ${person.lastName}`.trim();
    for (const [platformId, userIds] of by) {
      await notifyUsers({
        platformId, userIds, type: "REPETITIVE_TASK_FLAG", title: "Repetitive task alert",
        body: `${name}${person.employeeCode ? ` (${person.employeeCode})` : ""} submitted similar tasks ${c.count} times in ${c.spanDays} day${c.spanDays === 1 ? "" : "s"}: ${c.sampleTitle.slice(0, 80)}`,
        link: "/dashboard/approvals", dedupeKey: `repflag:${flagId}:new`, data: { flagId },
      });
    }
  } catch (e) {
    console.error("[repetition] notice failed:", e instanceof Error ? e.message : e);
  }
}

// --- when to run ------------------------------------------------------------------------------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * Called right after an employee submits or edits a task. Waits a moment so a Quick Add batch is checked once, then runs in the background.
 * Never throws and never delays the person's request.
 */
export function detectAfterSubmit(userId: string): void {
  try {
    if (timers.has(userId)) return;
    timers.set(userId, setTimeout(() => {
      timers.delete(userId);
      detectForUsers([userId]).catch((e) => console.error("[repetition] detection failed:", e instanceof Error ? e.message : e));
    }, 1500));
  } catch (e) {
    console.error("[repetition] could not schedule:", e instanceof Error ? e.message : e);
  }
}

/** Admin's "Scan now": every active person in the given companies who has enough recent tasks (one query, grouped in memory). */
export async function scanPeople(platformIds: string[] | "all"): Promise<{ checked: number; raised: number }> {
  if (!(await repetitionReady())) throw new Error("FEATURES_NOT_READY");
  const s = await loadSettings();
  if (!s.enabled) return { checked: 0, raised: 0 };
  const since = new Date(Date.now() - lookbackDays(s) * 86400000);
  const grouped = await prisma.dailyTask.groupBy({
    by: ["userId"],
    where: { date: { gte: since }, status: { not: "CANCELLED" as never }, approvalStatus: { not: "REJECTED" as never }, ...(platformIds === "all" ? {} : { platformId: { in: platformIds } }), ...(await activeTasks()) },
    _count: { _all: true },
    having: { userId: { _count: { gte: s.minCount } } },
  });
  const ids = grouped.map((g) => g.userId);
  let raised = 0;
  for (let i = 0; i < ids.length; i += 50) raised += await detectForUsers(ids.slice(i, i + 50));
  return { checked: ids.length, raised };
}
