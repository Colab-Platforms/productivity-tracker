// Repetitive task flags: who may see them, the review steps (status, comments, escalation), the summary for reports and the Admin's threshold.
// A flag is information for a human. NOTHING here touches a task, rating, attendance, salary or any productivity figure.
import { prisma } from "../../lib/prisma.js";
import { auditNote } from "../../lib/auditContext.js";
import { notifyUsers } from "../../lib/notify.js";
import { accessFor, deciderIdsForCompany, scopeWhere } from "../../lib/companyAccess.js";
import { manageableUserIds, userContext } from "./tasks.service.js";
import { scanPeople } from "./repetition.detect.js";
import { canMove, checkNote, checkSettings, isOpen, STATUSES, STATUS_LABEL, type FlagStatus } from "./repetition.logic.js";
import { loadSettings, repetitionReady } from "./repetition.store.js";

const fullName = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : "");
const day = (d: Date) => d.toISOString().slice(0, 10);

async function ready() {
  if (!(await repetitionReady())) throw new Error("FEATURES_NOT_READY");
}

/**
 * Who may see which flags. Employees see none. A manager sees the people they manage (their reporting team and the projects they run); HR and Admin see
 * every company they act on (the shared company-access rule). Returns a Prisma `where` for repetition_flags.
 */
async function scopeFor(viewerId: string): Promise<{ role: string; where: Record<string, unknown> }> {
  const ctx = await userContext(viewerId);
  const role = ctx.role;
  if (role === "MANAGER") {
    const ids = (await manageableUserIds({ id: viewerId, role, platformId: ctx.platformId })).filter((i) => i !== viewerId);
    return { role, where: { userId: { in: ids } } };
  }
  if (role === "HR" || role === "ADMIN") return { role, where: scopeWhere(await accessFor(viewerId)) };
  throw new Error("NOT_ALLOWED");
}

async function loadFlag(viewerId: string, id: string) {
  const { role, where } = await scopeFor(viewerId);
  const f = await prisma.repetitionFlag.findFirst({ where: { id, ...where } });
  if (!f) throw new Error("NOT_FOUND"); // not in your scope reads exactly like a flag that does not exist
  return { role, flag: f };
}

type Row = Awaited<ReturnType<typeof rowsOf>>[number];
async function rowsOf(flags: Awaited<ReturnType<typeof prisma.repetitionFlag.findMany>>) {
  const [people, teams] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set(flags.map((f) => f.userId))] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true, reportsTo: { select: { firstName: true, lastName: true } } } }),
    prisma.team.findMany({ where: { id: { in: [...new Set(flags.map((f) => f.teamId).filter(Boolean) as string[])] } }, select: { id: true, name: true } }),
  ]);
  const P = new Map(people.map((p) => [p.id, p])), T = new Map(teams.map((t) => [t.id, t.name]));
  return flags.map((f) => ({
    id: f.id, userId: f.userId, employee: fullName(P.get(f.userId)), employeeCode: P.get(f.userId)?.employeeCode ?? null,
    reportingManager: fullName(P.get(f.userId)?.reportsTo ?? null) || null,
    projectId: f.teamId, project: f.teamId ? T.get(f.teamId) ?? null : null,
    sampleTitle: f.sampleTitle, repeatCount: f.repeatCount, firstDate: day(f.firstDate), lastDate: day(f.lastDate), similarity: f.similarity, reason: f.reason,
    status: f.status as FlagStatus, statusLabel: STATUS_LABEL[f.status as FlagStatus] ?? f.status, open: isOpen(f.status),
    escalated: !!f.escalatedAt, escalatedAt: f.escalatedAt ? f.escalatedAt.toISOString() : null,
    createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString(),
  }));
}

// --- reads ------------------------------------------------------------------------------------------------------------------------------------

export async function listFlags(viewerId: string, q: { status?: string; userId?: string; projectId?: string } = {}) {
  if (!(await repetitionReady())) return { ready: false, flags: [] as Row[], counts: { open: 0, all: 0 } };
  const { where } = await scopeFor(viewerId);
  const status = String(q.status ?? "open");
  const filter: Record<string, unknown> = { ...where };
  if (q.userId) filter.userId = String(q.userId);
  if (q.projectId) filter.teamId = String(q.projectId);
  const all = await prisma.repetitionFlag.findMany({ where: filter, orderBy: [{ createdAt: "desc" }], take: 400 });
  const wanted = status === "all" ? all : status === "open" ? all.filter((f) => isOpen(f.status)) : all.filter((f) => f.status === status);
  return { ready: true, flags: await rowsOf(wanted), counts: { open: all.filter((f) => isOpen(f.status)).length, all: all.length } };
}

export async function flagDetail(viewerId: string, id: string) {
  await ready();
  const { flag } = await loadFlag(viewerId, id);
  const [tasks, events] = await Promise.all([
    prisma.repetitionFlagTask.findMany({ where: { flagId: id }, orderBy: [{ taskDate: "asc" }, { createdAt: "asc" }] }),
    prisma.repetitionFlagEvent.findMany({ where: { flagId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  ]);
  // what each task looks like NOW (the snapshot is what was matched; the live state shows whether it moved on since)
  const live = await prisma.dailyTask.findMany({ where: { id: { in: tasks.map((t) => t.taskId) } }, select: { id: true, status: true, approvalStatus: true } });
  const L = new Map(live.map((t) => [t.id, t]));
  const actors = await prisma.user.findMany({ where: { id: { in: [...new Set(events.map((e) => e.actorId).filter(Boolean) as string[])] } }, select: { id: true, firstName: true, lastName: true } });
  const A = new Map(actors.map((a) => [a.id, fullName(a)]));
  const [row] = await rowsOf([flag]);
  return {
    flag: row,
    tasks: tasks.map((t) => ({ id: t.taskId, date: day(t.taskDate), title: t.title, description: t.description, status: t.status, approvalStatus: t.approvalStatus, currentStatus: L.get(t.taskId) ? String(L.get(t.taskId)!.status) : null, currentApproval: L.get(t.taskId) ? String(L.get(t.taskId)!.approvalStatus) : null })),
    events: events.map((e) => ({ id: e.id, at: e.createdAt.toISOString(), by: e.actorId ? A.get(e.actorId) ?? "Someone" : "System", kind: e.kind, from: e.fromStatus, to: e.toStatus, note: e.note })),
  };
}

// --- review actions ---------------------------------------------------------------------------------------------------------------------

export async function setStatus(viewerId: string, id: string, toRaw: unknown, noteRaw: unknown) {
  await ready();
  const to = String(toRaw) as FlagStatus;
  if (!STATUSES.includes(to) || to === "NEW") throw new Error("BAD_FLAG_STATUS");
  const { flag } = await loadFlag(viewerId, id);
  const from = flag.status as FlagStatus;
  if (from === to) throw new Error("NO_CHANGE");
  if (!canMove(from, to)) throw new Error("MOVE_NOT_ALLOWED");
  // Dismissing a false alarm always needs a written reason; other steps may carry an optional note.
  const note = to === "FALSE_POSITIVE" ? checkNote(noteRaw, 3, 300, "REASON_REQUIRED") : String(noteRaw ?? "").trim() ? checkNote(noteRaw, 1, 300, "NOTE_REQUIRED") : null;
  const res = await prisma.repetitionFlag.updateMany({ where: { id, status: from }, data: { status: to } }); // guarded: two reviewers at once cannot both win
  if (res.count === 0) throw new Error("CHANGED_ELSEWHERE");
  await prisma.repetitionFlagEvent.create({ data: { flagId: id, actorId: viewerId, kind: "STATUS", fromStatus: from, toStatus: to, note } });
  auditNote({ summary: `Repetitive task flag set to ${STATUS_LABEL[to]}`, recordType: "RepetitionFlag", recordId: id, targetUserId: flag.userId, before: { status: from }, after: { status: to, note } });
  return flagDetail(viewerId, id);
}

export async function addComment(viewerId: string, id: string, textRaw: unknown) {
  await ready();
  const { flag } = await loadFlag(viewerId, id);
  const text = checkNote(textRaw, 1, 500, "COMMENT_REQUIRED");
  await prisma.repetitionFlagEvent.create({ data: { flagId: id, actorId: viewerId, kind: "COMMENT", note: text } });
  auditNote({ summary: "Commented on a repetitive task flag", recordType: "RepetitionFlag", recordId: id, targetUserId: flag.userId });
  return flagDetail(viewerId, id);
}

/** A manager (or Admin) passes a suspicious pattern to HR. HR and Admin of the company are notified once. */
export async function escalate(viewerId: string, id: string, noteRaw: unknown) {
  await ready();
  const { role, flag } = await loadFlag(viewerId, id);
  if (role === "HR") throw new Error("HR_CANNOT_ESCALATE"); // HR is who escalations go to
  if (flag.status === "FALSE_POSITIVE" || flag.status === "RESOLVED") throw new Error("FLAG_CLOSED");
  if (flag.escalatedAt) throw new Error("ALREADY_ESCALATED");
  const note = String(noteRaw ?? "").trim() ? checkNote(noteRaw, 1, 300, "NOTE_REQUIRED") : null;
  const res = await prisma.repetitionFlag.updateMany({ where: { id, escalatedAt: null }, data: { escalatedAt: new Date(), escalatedById: viewerId } });
  if (res.count === 0) throw new Error("ALREADY_ESCALATED");
  await prisma.repetitionFlagEvent.create({ data: { flagId: id, actorId: viewerId, kind: "ESCALATED", note } });
  auditNote({ summary: "Escalated a repetitive task flag to HR", recordType: "RepetitionFlag", recordId: id, targetUserId: flag.userId, after: { note } });
  try {
    const [emp, by] = await Promise.all([
      prisma.user.findUnique({ where: { id: flag.userId }, select: { firstName: true, lastName: true, employeeCode: true } }),
      prisma.user.findUnique({ where: { id: viewerId }, select: { firstName: true, lastName: true } }),
    ]);
    const to = await deciderIdsForCompany(flag.platformId, viewerId);
    const people = await prisma.user.findMany({ where: { id: { in: to } }, select: { id: true, platformId: true } });
    const byPlatform = new Map<string, string[]>();
    for (const p of people) byPlatform.set(p.platformId, [...(byPlatform.get(p.platformId) ?? []), p.id]);
    for (const [platformId, userIds] of byPlatform) {
      await notifyUsers({
        platformId, userIds, type: "REPETITIVE_TASK_ESCALATED", title: "Repetitive task flag escalated",
        body: `${fullName(by)} escalated ${fullName(emp)}${emp?.employeeCode ? ` (${emp.employeeCode})` : ""}: ${flag.sampleTitle.slice(0, 80)}`,
        link: "/dashboard/approvals", dedupeKey: `repflag:${id}:escalated`, data: { flagId: id },
      });
    }
  } catch (e) {
    console.error("[repetition] escalation notice failed:", e instanceof Error ? e.message : e);
  }
  return flagDetail(viewerId, id);
}

// --- reports ----------------------------------------------------------------------------------------------------------------------------------

/** Totals, per employee, per project and the most repeated descriptions, for flags raised between two days (default: the last 30). */
export async function summary(viewerId: string, fromIso?: string, toIso?: string) {
  if (!(await repetitionReady())) return { ready: false };
  const { where } = await scopeFor(viewerId);
  const to = toIso && /^\d{4}-\d{2}-\d{2}$/.test(toIso) ? new Date(`${toIso}T23:59:59.999Z`) : new Date();
  const from = fromIso && /^\d{4}-\d{2}-\d{2}$/.test(fromIso) ? new Date(`${fromIso}T00:00:00.000Z`) : new Date(to.getTime() - 30 * 86400000);
  const flags = await prisma.repetitionFlag.findMany({ where: { ...where, createdAt: { gte: from, lte: to } }, orderBy: { createdAt: "desc" } });
  const rows = await rowsOf(flags);
  const by = <K extends string>(key: (r: Row) => K | null, label: (r: Row) => string) => {
    const m = new Map<string, { key: string; label: string; flags: number; open: number; repeats: number }>();
    for (const r of rows) {
      const k = key(r); if (!k) continue;
      const cur = m.get(k) ?? { key: k, label: label(r), flags: 0, open: 0, repeats: 0 };
      cur.flags++; cur.repeats += r.repeatCount; if (r.open) cur.open++;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.flags - a.flags || b.repeats - a.repeats);
  };
  const titles = new Map<string, { title: string; flags: number; repeats: number }>();
  for (const r of rows) {
    const k = r.sampleTitle.toLowerCase().replace(/\s+/g, " ").trim();
    const cur = titles.get(k) ?? { title: r.sampleTitle, flags: 0, repeats: 0 };
    cur.flags++; cur.repeats += r.repeatCount; titles.set(k, cur);
  }
  const count = (s: FlagStatus) => rows.filter((r) => r.status === s).length;
  return {
    ready: true, from: day(from), to: day(to),
    totals: {
      flags: rows.length, open: rows.filter((r) => r.open).length, reviewed: rows.filter((r) => !r.open).length,
      new: count("NEW"), underReview: count("UNDER_REVIEW"), valid: count("VALID"), falsePositive: count("FALSE_POSITIVE"), resolved: count("RESOLVED"),
      escalated: rows.filter((r) => r.escalated).length,
    },
    byEmployee: by((r) => r.userId, (r) => `${r.employee}${r.employeeCode ? ` (${r.employeeCode})` : ""}`),
    byProject: by((r) => (r.projectId ?? "none"), (r) => r.project ?? "No project"),
    topTitles: [...titles.values()].sort((a, b) => b.flags - a.flags || b.repeats - a.repeats).slice(0, 10),
  };
}

// --- Admin settings ---------------------------------------------------------------------------------------------------------------------------

async function adminOnly(viewerId: string) {
  const ctx = await userContext(viewerId);
  if (ctx.role !== "ADMIN") throw new Error("NOT_ALLOWED");
}

export async function getSettings(viewerId: string) {
  await adminOnly(viewerId);
  return { ready: await repetitionReady(), settings: await loadSettings() };
}

export async function saveSettings(viewerId: string, body: Record<string, unknown>) {
  await adminOnly(viewerId);
  await ready();
  const before = await loadSettings();
  const next = checkSettings(body);
  await prisma.repetitionSettings.upsert({
    where: { id: "global" },
    create: { id: "global", ...next, updatedById: viewerId },
    update: { ...next, updatedById: viewerId },
  });
  auditNote({ summary: "Changed the repetitive task detection settings", recordType: "RepetitionSettings", recordId: "global", before, after: next });
  return { ready: true, settings: next };
}

/** Admin: check everyone's recent tasks now (for the first run, or after changing the threshold). Only the companies the Admin acts on. */
export async function scanNow(viewerId: string) {
  await adminOnly(viewerId);
  const a = await accessFor(viewerId);
  return scanPeople(a.all ? "all" : a.ids);
}
