import { prisma } from "../../lib/prisma.js";
import { accessFor, deciderIdsForCompany, scopeWhere } from "../../lib/companyAccess.js";
import { approvalsReady, stepViews } from "../approvals/managerStep.js";
import { approverOk, firstLevelFor, stageOf, STAGE_LABEL, type FirstLevel, type Stage } from "./leaveFlow.logic.js";

// ---------------------------------------------------------------------------
// LEAVE FLOW (database side): first-level approver choice, projects on a request, the approval history and the single status shown.
// Before migration 20261103100000_org_hierarchy_workflows the two new tables do not exist: flowReady() is false and the leave module keeps
// its previous behaviour exactly.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/(leave_approval_events|leave_request_projects)/.test(msg) && /does not exist|relation/.test(msg));
};

let readyValue = false;
let readyCheckedAt = 0;
export async function flowReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await Promise.all([prisma.leaveApprovalEvent.findFirst({ select: { id: true } }), prisma.leaveRequestProject.findFirst({ select: { id: true } })]);
    readyValue = (await approvalsReady()) === true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

type Db = Pick<typeof prisma, "leaveApprovalEvent">;
export type EventInput = { platformId: string; requestId: string; actor: { id: string; name: string; role: string } | null; step: "REQUEST" | "MANAGER" | "ADMIN" | "HR"; action: "SUBMITTED" | "APPROVED" | "REJECTED" | "CANCELLED" | "AUTO_APPROVED"; comment?: string | null };

export async function recordEvent(db: Db, e: EventInput) {
  await db.leaveApprovalEvent.create({
    data: {
      platformId: e.platformId,
      requestId: e.requestId,
      actorId: e.actor?.id ?? null,
      actorName: e.actor?.name ?? "System",
      actorRole: e.actor?.role ?? "SYSTEM",
      step: e.step,
      action: e.action,
      comment: e.comment ?? null,
    },
  });
}

const nameOf = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();

export async function actorOf(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, firstName: true, lastName: true, role: true, platformId: true } });
  if (!u) throw new Error("USER_NOT_FOUND");
  return { id: u.id, name: nameOf(u), role: String(u.role), platformId: u.platformId };
}

// --- who may be tagged ------------------------------------------------------------------------------------

export type Requester = { id: string; role: string; platformId: string };

/** The people this requester may tag as first-level approver, and who is preselected. HR tags an Admin of a company they act on. */
export async function approverChoices(me: Requester) {
  const mode: FirstLevel = firstLevelFor(me.role);
  const base = { mode, role: me.role, editable: false, defaultId: null as string | null, options: [] as { id: string; name: string; code: string | null }[] };
  if (mode === "NONE") return base;
  const self = await prisma.user.findUnique({ where: { id: me.id }, select: { reportsTo: { select: { id: true, role: true, status: true, platformId: true } } } });
  const boss = self?.reportsTo ?? null;
  const bossOk = boss ? approverOk(me, { id: boss.id, role: String(boss.role), status: String(boss.status), platformId: boss.platformId }, true, true) : false;
  if (me.role === "HR") {
    const access = await accessFor(me.id);
    const admins = await prisma.user.findMany({ where: { ...scopeWhere(access), role: "ADMIN", status: "ACTIVE", id: { not: me.id } }, select: { id: true, firstName: true, lastName: true, employeeCode: true }, orderBy: [{ firstName: "asc" }] });
    return { ...base, editable: true, defaultId: bossOk ? boss!.id : null, options: admins.map((a) => ({ id: a.id, name: nameOf(a), code: a.employeeCode })) };
  }
  if (me.role === "MANAGER") {
    // The manager's leave goes to the Admin they report to. Not editable.
    if (!bossOk) return base;
    const a = await prisma.user.findUnique({ where: { id: boss!.id }, select: { id: true, firstName: true, lastName: true, employeeCode: true } });
    return { ...base, defaultId: boss!.id, options: a ? [{ id: a.id, name: nameOf(a), code: a.employeeCode }] : [] };
  }
  const managers = await prisma.user.findMany({ where: { platformId: me.platformId, role: "MANAGER", status: "ACTIVE", id: { not: me.id } }, select: { id: true, firstName: true, lastName: true, employeeCode: true }, orderBy: [{ firstName: "asc" }] });
  const options = managers.map((m) => ({ id: m.id, name: nameOf(m), code: m.employeeCode }));
  // the reporting manager is always offered (and preselected), even when they are of another company
  if (bossOk && !options.some((o) => o.id === boss!.id)) {
    const b = await prisma.user.findUnique({ where: { id: boss!.id }, select: { id: true, firstName: true, lastName: true, employeeCode: true } });
    if (b) options.unshift({ id: b.id, name: nameOf(b), code: b.employeeCode });
  }
  return { ...base, editable: true, defaultId: bossOk ? boss!.id : null, options };
}

/**
 * The first-level approver for a new request. A tagged person must be valid (BAD_APPROVER otherwise). With no tag the person's own reporting
 * line is used when it fits; if it does not, an employee or manager gets null (no step: straight to HR, flagged for manual configuration), while HR
 * must always choose an Admin (TAGGED_ADMIN_REQUIRED). An Admin has no approver (null, the request is approved automatically).
 */
export async function resolveApprover(me: Requester, taggedId: unknown): Promise<string | null> {
  const mode = firstLevelFor(me.role);
  if (mode === "NONE") return null;
  const tagged = typeof taggedId === "string" && taggedId ? taggedId : null;
  const lookup = async (id: string) => {
    const c = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, status: true, platformId: true } });
    return c ? { id: c.id, role: String(c.role), status: String(c.status), platformId: c.platformId } : null;
  };
  if (me.role === "MANAGER") {
    // fixed by the reporting line: whatever was sent is ignored unless it is the same person
    const self = await prisma.user.findUnique({ where: { id: me.id }, select: { reportsToId: true } });
    const boss = self?.reportsToId ? await lookup(self.reportsToId) : null;
    if (tagged && tagged !== self?.reportsToId) throw new Error("BAD_APPROVER");
    return boss && approverOk(me, boss, true, true) ? boss.id : null;
  }
  if (tagged) {
    const c = await lookup(tagged);
    let companyOk = true;
    if (me.role === "HR" && c) {
      const access = await accessFor(me.id);
      companyOk = access.all || access.ids.includes(c.platformId);
    }
    const own = me.role !== "HR" && tagged === (await prisma.user.findUnique({ where: { id: me.id }, select: { reportsToId: true } }))?.reportsToId;
    if (!approverOk(me, c, companyOk, own)) throw new Error("BAD_APPROVER");
    return tagged;
  }
  if (me.role === "HR") throw new Error("TAGGED_ADMIN_REQUIRED");
  const self = await prisma.user.findUnique({ where: { id: me.id }, select: { reportsToId: true } });
  const boss = self?.reportsToId ? await lookup(self.reportsToId) : null;
  return boss && approverOk(me, boss, true, true) ? boss.id : null;
}

// --- projects -----------------------------------------------------------------------------------------------

/** The projects (teams) the person is an active member of. */
export async function myProjects(userId: string) {
  const rows = await prisma.teamMember.findMany({ where: { userId, isActive: true, team: { isActive: true } }, select: { team: { select: { id: true, name: true } } }, orderBy: { team: { name: "asc" } } });
  return rows.map((r) => ({ id: r.team.id, name: r.team.name }));
}

/** Only projects the person belongs to may be chosen (checked here, not only in the form). */
export async function validProjectIds(userId: string, ids: unknown): Promise<string[]> {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new Error("BAD_PROJECT");
  const wanted = [...new Set(ids as string[])];
  if (wanted.length === 0) return [];
  if (wanted.length > 20) throw new Error("BAD_PROJECT");
  const mine = new Set((await myProjects(userId)).map((p) => p.id));
  if (wanted.some((id) => !mine.has(id))) throw new Error("BAD_PROJECT");
  return wanted;
}

// --- who is told ----------------------------------------------------------------------------------------------

/** HR people (not Admins) who act on this company, never the requester. */
export async function hrIdsFor(platformId: string, exceptUserId: string): Promise<string[]> {
  const ids = await deciderIdsForCompany(platformId, exceptUserId);
  if (ids.length === 0) return [];
  const rows = await prisma.user.findMany({ where: { id: { in: ids }, role: "HR" }, select: { id: true } });
  return rows.map((r) => r.id);
}

// --- what a request shows -----------------------------------------------------------------------------------------

export type Decorated = {
  stage: Stage;
  stageLabel: string;
  requesterRole: string;
  tagged: string | null;
  firstLevel: FirstLevel;
  projects: { id: string; name: string }[];
  history: { at: Date; actor: string; role: string; step: string; action: string; comment: string | null }[];
};

/** Status, projects, tagged approver and approval history for a batch of requests (a few queries, never one per request). */
export async function decorate(rows: { id: string; userId: string; status: unknown }[]): Promise<Map<string, Decorated>> {
  const out = new Map<string, Decorated>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const ready = await flowReady();
  const [users, steps, projects, events] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, role: true } }),
    stepViews("LEAVE", ids),
    ready ? prisma.leaveRequestProject.findMany({ where: { requestId: { in: ids } } }) : Promise.resolve([]),
    ready ? prisma.leaveApprovalEvent.findMany({ where: { requestId: { in: ids } }, orderBy: { createdAt: "asc" } }) : Promise.resolve([]),
  ]);
  const teamIds = [...new Set(projects.map((p) => p.teamId))];
  const teams = teamIds.length ? await prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } }) : [];
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const roleOf = new Map(users.map((u) => [u.id, String(u.role)]));
  for (const r of rows) {
    const requesterRole = roleOf.get(r.userId) ?? "EMPLOYEE";
    const step = steps.get(r.id) ?? null;
    out.set(r.id, {
      stage: stageOf({ requesterRole, requestStatus: String(r.status), stepStatus: step?.status ?? null }),
      stageLabel: STAGE_LABEL[stageOf({ requesterRole, requestStatus: String(r.status), stepStatus: step?.status ?? null })],
      requesterRole,
      tagged: step?.approvers[0] ?? null,
      firstLevel: firstLevelFor(requesterRole),
      projects: projects.filter((p) => p.requestId === r.id).map((p) => ({ id: p.teamId, name: teamName.get(p.teamId) ?? "Project" })),
      history: events.filter((e) => e.requestId === r.id).map((e) => ({ at: e.createdAt, actor: e.actorName, role: e.actorRole, step: e.step, action: e.action, comment: e.comment })),
    });
  }
  return out;
}
