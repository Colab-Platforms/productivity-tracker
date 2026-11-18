// Repetitive task flags: who may see them, the review steps (status, comments, employee explanations, escalation to HR and to Admin), the summary for
// reports and the Admin's threshold. A flag is information for a human, never a finding of misconduct. NOTHING here touches a task, rating, attendance,
// salary or any productivity figure. The visibility rules live in repetition.access.ts (pure, tested); this file applies them.
import { prisma } from "../../lib/prisma.js";
import { auditNote } from "../../lib/auditContext.js";
import { notifyUsers } from "../../lib/notify.js";
import { accessFor, deciderIdsForCompany, scopeWhere } from "../../lib/companyAccess.js";
import { manageableUserIds, userContext } from "./tasks.service.js";
import { scanPeople } from "./repetition.detect.js";
import { canMove, checkNote, checkSettings, isOpen, STATUSES, STATUS_LABEL, type FlagStatus } from "./repetition.logic.js";
import { actionsFor, canSee, commentFor, eventNoteVisible, eventVisible, OUTCOME_TEXT, viewerOf, type EventKind, type NoteKind, type Viewer, type Visibility } from "./repetition.access.js";
import { loadSettings, notesReady, repetitionReady } from "./repetition.store.js";

const fullName = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : "");
const day = (d: Date) => d.toISOString().slice(0, 10);

async function ready() {
  if (!(await repetitionReady())) throw new Error("FEATURES_NOT_READY");
}

/**
 * Who may see which flags. A manager: the people they manage (their reporting team and the projects they run). HR and Admin: every company they act on
 * (the shared company-access rule). An employee: only flags about themselves (`own` = true gives that to any role: a person's own alert).
 */
async function scopeFor(viewerId: string, o: { own?: boolean; allowEmployee?: boolean } = {}): Promise<{ role: string; where: Record<string, unknown> }> {
  const ctx = await userContext(viewerId);
  const role = ctx.role;
  if (o.own) return { role, where: { userId: viewerId } };
  if (role === "MANAGER") {
    const ids = (await manageableUserIds({ id: viewerId, role, platformId: ctx.platformId })).filter((i) => i !== viewerId);
    return { role, where: { userId: { in: ids } } };
  }
  if (role === "HR" || role === "ADMIN") return { role, where: scopeWhere(await accessFor(viewerId)) };
  if (o.allowEmployee) return { role, where: { userId: viewerId } };
  throw new Error("NOT_ALLOWED");
}

/** One flag the viewer may see, with the viewer's mode (the person a flag is about is always read as an employee). */
async function loadFlag(viewerId: string, id: string, o: { own?: boolean } = {}) {
  const { role, where } = await scopeFor(viewerId, { allowEmployee: true, own: o.own });
  const f = await prisma.repetitionFlag.findFirst({ where: { id, ...where } });
  if (!f) throw new Error("NOT_FOUND"); // not in your scope reads exactly like a flag that does not exist
  return { role, viewer: viewerOf(role, f.userId === viewerId), flag: f };
}

/** The review actions need a reviewer who is not the subject of the flag. */
function reviewer(viewer: Viewer) {
  if (viewer === "EMPLOYEE") throw new Error("NOT_ALLOWED");
}

type Row = Awaited<ReturnType<typeof rowsOf>>[number];
async function rowsOf(flags: Awaited<ReturnType<typeof prisma.repetitionFlag.findMany>>, mode: Viewer = "HR") {
  const [people, teams, adminEsc] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set(flags.map((f) => f.userId))] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true, reportsTo: { select: { firstName: true, lastName: true } } } }),
    prisma.team.findMany({ where: { id: { in: [...new Set(flags.map((f) => f.teamId).filter(Boolean) as string[])] } }, select: { id: true, name: true } }),
    // which flags were escalated to Admin (only HR and Admin may know)
    (mode === "HR" || mode === "ADMIN") && flags.length && (await notesReady())
      ? prisma.repetitionFlagNote.findMany({ where: { flagId: { in: flags.map((f) => f.id) }, kind: "ESCALATION_ADMIN" }, select: { flagId: true } })
      : Promise.resolve([] as { flagId: string }[]),
  ]);
  const P = new Map(people.map((p) => [p.id, p])), T = new Map(teams.map((t) => [t.id, t.name]));
  const toAdmin = new Set(adminEsc.map((n) => n.flagId));
  return flags.map((f) => {
    const employee = mode === "EMPLOYEE";
    return {
      id: f.id, userId: f.userId, employee: fullName(P.get(f.userId)), employeeCode: P.get(f.userId)?.employeeCode ?? null,
      reportingManager: employee ? null : fullName(P.get(f.userId)?.reportsTo ?? null) || null,
      projectId: f.teamId, project: f.teamId ? T.get(f.teamId) ?? null : null,
      sampleTitle: f.sampleTitle, repeatCount: f.repeatCount, firstDate: day(f.firstDate), lastDate: day(f.lastDate), similarity: f.similarity, reason: f.reason,
      status: f.status as FlagStatus, statusLabel: STATUS_LABEL[f.status as FlagStatus] ?? f.status, open: isOpen(f.status),
      // the employee never learns that a case was escalated; a manager does not learn about the escalation to Admin
      escalated: employee ? false : !!f.escalatedAt,
      escalatedAt: employee ? null : f.escalatedAt ? f.escalatedAt.toISOString() : null,
      escalatedToAdmin: mode === "HR" || mode === "ADMIN" ? toAdmin.has(f.id) : false,
      outcome: OUTCOME_TEXT[f.status] ?? "",
      createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString(),
    };
  });
}

// --- reads ------------------------------------------------------------------------------------------------------------------------------------

/** `own` = the flags about the signed-in person themselves (any role), shown as an employee sees them. */
export async function listFlags(viewerId: string, q: { status?: string; userId?: string; projectId?: string; own?: boolean } = {}) {
  if (!(await repetitionReady())) return { ready: false, flags: [] as Row[], counts: { open: 0, all: 0, escalatedAdmin: 0 }, mode: "HR" as Viewer };
  const { role, where } = await scopeFor(viewerId, { allowEmployee: true, own: q.own });
  const mode: Viewer = q.own ? "EMPLOYEE" : viewerOf(role, false);
  const status = String(q.status ?? "open");
  const filter: Record<string, unknown> = { ...where };
  if (q.userId && mode !== "EMPLOYEE") filter.userId = String(q.userId);
  if (q.projectId) filter.teamId = String(q.projectId);
  const all = await prisma.repetitionFlag.findMany({ where: filter, orderBy: [{ createdAt: "desc" }], take: 400 });
  let rows = await rowsOf(all, mode);
  const escalatedAdmin = rows.filter((r) => r.escalatedToAdmin).length;
  const wanted = status === "all" ? rows : status === "open" ? rows.filter((r) => r.open) : status === "escalatedAdmin" ? rows.filter((r) => r.escalatedToAdmin) : rows.filter((r) => r.status === status);
  rows = wanted;
  return { ready: true, flags: rows, counts: { open: all.filter((f) => isOpen(f.status)).length, all: all.length, escalatedAdmin }, mode, notesReady: await notesReady() };
}

export type TimelineItem = { id: string; at: string; by: string; kind: string; from?: string | null; to?: string | null; note: string | null; visibility?: Visibility; own?: boolean };

export async function flagDetail(viewerId: string, id: string) {
  await ready();
  const { viewer, flag } = await loadFlag(viewerId, id);
  const hasNotes = await notesReady();
  const [tasks, events, notes] = await Promise.all([
    prisma.repetitionFlagTask.findMany({ where: { flagId: id }, orderBy: [{ taskDate: "asc" }, { createdAt: "asc" }] }),
    prisma.repetitionFlagEvent.findMany({ where: { flagId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    hasNotes ? prisma.repetitionFlagNote.findMany({ where: { flagId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }) : Promise.resolve([]),
  ]);
  // what each task looks like NOW (the snapshot is what was matched; the live state shows whether it moved on since)
  const live = await prisma.dailyTask.findMany({ where: { id: { in: tasks.map((t) => t.taskId) } }, select: { id: true, status: true, approvalStatus: true } });
  const L = new Map(live.map((t) => [t.id, t]));
  const actorIds = [...new Set([...events.map((e) => e.actorId), ...notes.map((n) => n.authorId)].filter(Boolean) as string[])];
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, firstName: true, lastName: true } });
  const A = new Map(actors.map((a) => [a.id, fullName(a)]));
  const [row] = await rowsOf([flag], viewer);

  const timeline: TimelineItem[] = [];
  for (const e of events) {
    const kind = e.kind as EventKind;
    if (!eventVisible(viewer, kind)) continue;
    timeline.push({
      id: e.id, at: e.createdAt.toISOString(), kind, from: e.fromStatus, to: e.toStatus,
      by: viewer === "EMPLOYEE" ? (kind === "STATUS" ? "Review team" : "System") : e.actorId ? A.get(e.actorId) ?? "Someone" : "System",
      note: eventNoteVisible(viewer, kind) ? e.note : null,
    });
  }
  for (const n of notes) {
    if (!canSee(viewer, n.visibility as Visibility)) continue;
    timeline.push({ id: n.id, at: n.createdAt.toISOString(), kind: n.kind, by: viewer === "EMPLOYEE" ? "You" : n.authorId ? A.get(n.authorId) ?? "Someone" : "Someone", note: n.body, visibility: n.visibility as Visibility, own: n.authorId === viewerId });
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  return {
    flag: row,
    mode: viewer,
    can: actionsFor(viewer, { status: flag.status, escalatedToHr: !!flag.escalatedAt, escalatedToAdmin: row.escalatedToAdmin }, hasNotes),
    tasks: tasks.map((t) => ({ id: t.taskId, date: day(t.taskDate), title: t.title, description: t.description, status: t.status, approvalStatus: t.approvalStatus, currentStatus: L.get(t.taskId) ? String(L.get(t.taskId)!.status) : null, currentApproval: L.get(t.taskId) ? String(L.get(t.taskId)!.approvalStatus) : null })),
    // kept for the older screen: the same history without the new notes
    events: timeline.filter((t) => !["EXPLANATION", "MANAGER_COMMENT", "HR_OBSERVATION", "ADMIN_NOTE", "ESCALATION_ADMIN"].includes(t.kind)).map((t) => ({ id: t.id, at: t.at, by: t.by, kind: t.kind, from: t.from ?? null, to: t.to ?? null, note: t.note })),
    timeline,
  };
}

// --- people hear about it ---------------------------------------------------------------------------------------------------------------------

async function tell(userIds: string[], o: { type: string; title: string; body: string; link: string; key: string; flagId: string }) {
  try {
    if (userIds.length === 0) return;
    const people = await prisma.user.findMany({ where: { id: { in: [...new Set(userIds)] }, status: "ACTIVE" as never }, select: { id: true, platformId: true } });
    const byPlatform = new Map<string, string[]>();
    for (const p of people) byPlatform.set(p.platformId, [...(byPlatform.get(p.platformId) ?? []), p.id]);
    for (const [platformId, ids] of byPlatform) await notifyUsers({ platformId, userIds: ids, type: o.type, title: o.title, body: o.body, link: o.link, dedupeKey: o.key, data: { flagId: o.flagId } });
  } catch (e) {
    console.error("[repetition] notice failed:", e instanceof Error ? e.message : e);
  }
}

// --- review actions ---------------------------------------------------------------------------------------------------------------------------

export async function setStatus(viewerId: string, id: string, toRaw: unknown, noteRaw: unknown) {
  await ready();
  const to = String(toRaw) as FlagStatus;
  if (!STATUSES.includes(to) || to === "NEW") throw new Error("BAD_FLAG_STATUS");
  const { viewer, flag } = await loadFlag(viewerId, id);
  reviewer(viewer);
  const from = flag.status as FlagStatus;
  if (from === to) throw new Error("NO_CHANGE");
  if (!canMove(from, to)) throw new Error("MOVE_NOT_ALLOWED");
  // Dismissing a false alarm always needs a written reason; other steps may carry an optional note.
  const note = to === "FALSE_POSITIVE" ? checkNote(noteRaw, 3, 300, "REASON_REQUIRED") : String(noteRaw ?? "").trim() ? checkNote(noteRaw, 1, 300, "NOTE_REQUIRED") : null;
  const res = await prisma.repetitionFlag.updateMany({ where: { id, status: from }, data: { status: to } }); // guarded: two reviewers at once cannot both win
  if (res.count === 0) throw new Error("CHANGED_ELSEWHERE");
  await prisma.repetitionFlagEvent.create({ data: { flagId: id, actorId: viewerId, kind: "STATUS", fromStatus: from, toStatus: to, note } });
  auditNote({ summary: `Repetitive task flag set to ${STATUS_LABEL[to]}`, recordType: "RepetitionFlag", recordId: id, targetUserId: flag.userId, before: { status: from }, after: { status: to, note } });
  // the employee hears the new status only (never the reviewer's note or name)
  await tell([flag.userId], { type: "REPETITIVE_TASK_STATUS", title: "Your task alert was updated", body: `The review status of "${flag.sampleTitle.slice(0, 80)}" is now: ${STATUS_LABEL[to]}. This is not a finding of misconduct.`, link: "/dashboard/tasks", key: `repflag:${id}:status:${to}:${Date.now()}`, flagId: id });
  return flagDetail(viewerId, id);
}

/** A reviewer's comment: a manager's comment is visible to managers, HR and Admin; an HR observation or Admin note only to HR and Admin. Never to the employee. */
export async function addComment(viewerId: string, id: string, textRaw: unknown) {
  await ready();
  const { viewer, flag } = await loadFlag(viewerId, id);
  const spec = commentFor(viewer);
  if (!spec) throw new Error("NOT_ALLOWED");
  const text = checkNote(textRaw, 1, 500, "COMMENT_REQUIRED");
  if (await notesReady()) {
    await prisma.repetitionFlagNote.create({ data: { flagId: id, authorId: viewerId, authorRole: viewer, kind: spec.kind as NoteKind, visibility: spec.visibility, body: text } });
  } else {
    await prisma.repetitionFlagEvent.create({ data: { flagId: id, actorId: viewerId, kind: "COMMENT", note: text } }); // before the migration: the first version's comment
  }
  auditNote({ summary: spec.kind === "HR_OBSERVATION" ? "Added an HR observation to a repetitive task flag" : spec.kind === "ADMIN_NOTE" ? "Added an Admin note to a repetitive task flag" : "Commented on a repetitive task flag", recordType: "RepetitionFlag", recordId: id, targetUserId: flag.userId });
  return flagDetail(viewerId, id);
}

/** The employee explains or clarifies. Everyone who can see the flag can read it; the employee sees only their own explanations. */
export async function explain(viewerId: string, id: string, textRaw: unknown) {
  await ready();
  if (!(await notesReady())) throw new Error("FEATURES_NOT_READY");
  const { flag } = await loadFlag(viewerId, id, { own: true });
  if (flag.userId !== viewerId) throw new Error("NOT_FOUND");
  if (flag.status === "FALSE_POSITIVE" || flag.status === "RESOLVED") throw new Error("FLAG_CLOSED");
  const text = checkNote(textRaw, 3, 1000, "EXPLANATION_REQUIRED");
  await prisma.repetitionFlagNote.create({ data: { flagId: id, authorId: viewerId, authorRole: "EMPLOYEE", kind: "EXPLANATION", visibility: "EMPLOYEE", body: text } });
  auditNote({ summary: "The employee explained a repetitive task flag", recordType: "RepetitionFlag", recordId: id, targetUserId: flag.userId, after: { explanation: text.slice(0, 200) } });
  // the reporting manager (or the company's HR/Admin when there is none) is told once per explanation
  const me = await prisma.user.findUnique({ where: { id: viewerId }, select: { firstName: true, lastName: true, employeeCode: true, reportsToId: true, platformId: true } });
  let to: string[] = [];
  if (me?.reportsToId) {
    const m = await prisma.user.findFirst({ where: { id: me.reportsToId, status: "ACTIVE" as never, role: { in: ["MANAGER", "ADMIN", "HR"] as never } }, select: { id: true } });
    if (m) to = [m.id];
  }
  if (to.length === 0 && me) to = await deciderIdsForCompany(me.platformId, viewerId);
  await tell(to, { type: "REPETITIVE_TASK_EXPLAINED", title: "Employee explanation added", body: `${fullName(me)}${me?.employeeCode ? ` (${me.employeeCode})` : ""} explained: ${flag.sampleTitle.slice(0, 80)}`, link: "/dashboard/approvals", key: `repflag:${id}:explained:${Date.now()}`, flagId: id });
  return flagDetail(viewerId, id);
}

/** A manager passes a suspicious pattern to HR. HR and Admin of the company are notified once. */
export async function escalate(viewerId: string, id: string, noteRaw: unknown) {
  await ready();
  const { viewer, flag } = await loadFlag(viewerId, id);
  if (viewer !== "MANAGER") throw new Error(viewer === "HR" ? "USE_ESCALATE_ADMIN" : "NOT_ALLOWED"); // HR escalates to Admin, in its own step
  if (flag.status === "FALSE_POSITIVE" || flag.status === "RESOLVED") throw new Error("FLAG_CLOSED");
  if (flag.escalatedAt) throw new Error("ALREADY_ESCALATED");
  const note = String(noteRaw ?? "").trim() ? checkNote(noteRaw, 1, 300, "NOTE_REQUIRED") : null;
  const res = await prisma.repetitionFlag.updateMany({ where: { id, escalatedAt: null }, data: { escalatedAt: new Date(), escalatedById: viewerId } });
  if (res.count === 0) throw new Error("ALREADY_ESCALATED");
  await prisma.repetitionFlagEvent.create({ data: { flagId: id, actorId: viewerId, kind: "ESCALATED", note } });
  auditNote({ summary: "Escalated a repetitive task flag to HR", recordType: "RepetitionFlag", recordId: id, targetUserId: flag.userId, after: { note } });
  const [emp, by] = await Promise.all([
    prisma.user.findUnique({ where: { id: flag.userId }, select: { firstName: true, lastName: true, employeeCode: true } }),
    prisma.user.findUnique({ where: { id: viewerId }, select: { firstName: true, lastName: true } }),
  ]);
  await tell(await deciderIdsForCompany(flag.platformId, viewerId), { type: "REPETITIVE_TASK_ESCALATED", title: "Repetitive task flag escalated to HR", body: `${fullName(by)} escalated ${fullName(emp)}${emp?.employeeCode ? ` (${emp.employeeCode})` : ""}: ${flag.sampleTitle.slice(0, 80)}`, link: "/dashboard/approvals", key: `repflag:${id}:escalated`, flagId: id });
  return flagDetail(viewerId, id);
}

/** HR passes a case to Admin for a closer look, with a recorded reason. It does not say the employee did anything wrong and changes nothing about them. */
export async function escalateToAdmin(viewerId: string, id: string, reasonRaw: unknown) {
  await ready();
  if (!(await notesReady())) throw new Error("FEATURES_NOT_READY");
  const { viewer, flag } = await loadFlag(viewerId, id);
  if (viewer !== "HR") throw new Error("NOT_ALLOWED");
  if (flag.status === "FALSE_POSITIVE" || flag.status === "RESOLVED") throw new Error("FLAG_CLOSED");
  const reason = checkNote(reasonRaw, 3, 300, "REASON_REQUIRED");
  const already = await prisma.repetitionFlagNote.findFirst({ where: { flagId: id, kind: "ESCALATION_ADMIN" }, select: { id: true } });
  if (already) throw new Error("ALREADY_ESCALATED_ADMIN");
  try {
    await prisma.repetitionFlagNote.create({ data: { flagId: id, authorId: viewerId, authorRole: "HR", kind: "ESCALATION_ADMIN", visibility: "HR_ADMIN", body: reason } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new Error("ALREADY_ESCALATED_ADMIN"); // two HR people at the same moment: one record
    throw e;
  }
  auditNote({ summary: "Escalated a repetitive task flag to Admin", recordType: "RepetitionFlag", recordId: id, targetUserId: flag.userId, after: { reason } });
  const [emp, by] = await Promise.all([
    prisma.user.findUnique({ where: { id: flag.userId }, select: { firstName: true, lastName: true, employeeCode: true } }),
    prisma.user.findUnique({ where: { id: viewerId }, select: { firstName: true, lastName: true } }),
  ]);
  await tell(await deciderIdsForCompany(flag.platformId, viewerId), { type: "REPETITIVE_TASK_ESCALATED", title: "Repetitive task flag escalated to Admin", body: `${fullName(by)} escalated ${fullName(emp)}${emp?.employeeCode ? ` (${emp.employeeCode})` : ""} for a closer look: ${flag.sampleTitle.slice(0, 80)}`, link: "/dashboard/approvals", key: `repflag:${id}:escalated-admin`, flagId: id });
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
