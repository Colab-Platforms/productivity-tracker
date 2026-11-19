import { prisma } from "../../lib/prisma.js";
import { accessFor } from "../../lib/companyAccess.js";
import { saveUpload, readStored, contentTypeFor, deleteStored } from "../../lib/storage.js";
import { notifyUsers } from "../../lib/notify.js";
import { auditNote } from "../../lib/auditContext.js";
import { visibleUserIds } from "../tracker/tracker.service.js";
import * as L from "./dept.logic.js";

// ---------------------------------------------------------------------------
// QUERY DESK: DEPARTMENT REQUESTS
//   Employee -> reporting manager -> Admin -> tagged department does the work -> employee confirms or reopens.
// Everything is enforced HERE (the screen only shows what comes back). Approval status and department work status are separate columns.
// Updates that move a request on are "guarded" (the update itself checks the status it expects), so two people pressing at the same
// moment record ONE decision. History (dept_request_events) is append-only.
// Before the migration (no dept tables) reads answer "not ready" and writes answer 503; nothing else in the Query Desk is affected.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/(dept_request|department)/.test(msg) && /does not exist|relation/.test(msg));
};
let readyValue = false;
let readyCheckedAt = 0;
export async function deptReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await Promise.all([prisma.deptRequest.findFirst({ select: { id: true } }), prisma.department.findFirst({ select: { id: true } })]);
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}
async function needReady() {
  if (!(await deptReady())) throw new Error("FEATURES_NOT_READY");
}

const nameOf = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);

async function who(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, platformId: true, firstName: true, lastName: true, status: true } });
  if (!u) throw new Error("NOT_FOUND");
  const a = await accessFor(userId);
  const role = String(u.role);
  const reportIds = role === "MANAGER" ? new Set(await visibleUserIds({ id: u.id, role, platformId: u.platformId })) : new Set<string>();
  const deptIds = (await deptReady()) ? (await prisma.departmentMember.findMany({ where: { userId } , select: { departmentId: true } })).map((m) => m.departmentId) : [];
  const viewer: L.Viewer = { id: u.id, role, access: { all: a.all, ids: a.ids }, deptIds, reportIds };
  return { viewer, platformId: u.platformId, name: nameOf(u) ?? "" };
}
type Who = Awaited<ReturnType<typeof who>>;

const asFacts = (r: { raisedById: string; platformId: string; departmentId: string; approvalStatus: string; workStatus: string | null; managerId: string | null; adminApproverIds: string[]; assigneeId: string | null; confirmedAt: Date | null }): L.Facts => ({
  raisedById: r.raisedById, platformId: r.platformId, departmentId: r.departmentId, approvalStatus: r.approvalStatus as L.Approval, workStatus: r.workStatus as L.Work | null,
  managerId: r.managerId, adminApproverIds: r.adminApproverIds, assigneeId: r.assigneeId, confirmedAt: r.confirmedAt,
});

type Upload = { fileName?: unknown; data?: unknown; mimeType?: unknown };
async function store(platformId: string, f: Upload | null | undefined) {
  if (!f || !f.data) return null;
  return saveUpload({ platformId, folder: "queries", originalName: String(f.fileName ?? "attachment").slice(0, 120), data: String(f.data), mimeType: f.mimeType ? String(f.mimeType) : undefined });
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type EvInput = { requestId: string; actorId: string | null; kind: string; fromValue?: string | null; toValue?: string | null; note?: string | null; visibility?: L.NoteVisibility; file?: { storageKey: string; fileName: string } | null };
async function addEvent(tx: Tx | typeof prisma, e: EvInput) {
  return tx.deptRequestEvent.create({
    data: {
      requestId: e.requestId, actorId: e.actorId, kind: e.kind, fromValue: e.fromValue ?? null, toValue: e.toValue ?? null, note: e.note ?? null,
      visibility: e.visibility ?? "ALL", attachmentKey: e.file?.storageKey ?? null, attachmentName: e.file?.fileName ?? null,
    },
    select: { id: true },
  });
}

/** Notifications use the existing inbox. The dedupe key is the history row's own id, so a repeat of the same event never notifies twice. */
async function tell(platformId: string, userIds: (string | null | undefined)[], requestId: string, eventId: string, type: string, title: string, body: string, exclude?: string) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x && x !== exclude))];
  if (ids.length === 0) return;
  try {
    await notifyUsers({ platformId, userIds: ids, type, title, body, link: `/dashboard/queries?tab=dept&id=${requestId}`, data: { requestId }, dedupeKey: `dq:${eventId}:${type}` });
  } catch (e) {
    console.error("[dept-requests] could not notify:", e);
  }
}

async function deptMemberIds(departmentId: string, exceptUserId?: string) {
  const rows = await prisma.departmentMember.findMany({ where: { departmentId, ...(exceptUserId ? { userId: { not: exceptUserId } } : {}) }, select: { userId: true } });
  if (rows.length === 0) return [];
  const active = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) }, status: "ACTIVE" }, select: { id: true } });
  return active.map((u) => u.id);
}

// ---------------------------------------------------------------------------------------------------------------------------
// DEPARTMENTS (the dropdown, and the Admin's screen to keep them)
// ---------------------------------------------------------------------------------------------------------------------------

export async function departmentsForPicker(userId: string) {
  const me = await who(userId);
  if (!(await deptReady())) return { ready: false, departments: [] as { id: string; name: string }[] };
  const rows = await prisma.department.findMany({ where: { platformId: me.platformId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  return { ready: true, departments: rows };
}

async function adminScope(userId: string) {
  const me = await who(userId);
  if (me.viewer.role !== "ADMIN") throw new Error("FORBIDDEN");
  return me;
}

export async function adminDepartments(userId: string) {
  const me = await adminScope(userId);
  if (!(await deptReady())) return { ready: false, departments: [], companies: [] };
  const platformIds = me.viewer.access.all ? undefined : me.viewer.access.ids;
  const rows = await prisma.department.findMany({ where: platformIds ? { platformId: { in: platformIds } } : {}, orderBy: [{ platformId: "asc" }, { name: "asc" }] });
  const members = await prisma.departmentMember.findMany({ where: { departmentId: { in: rows.map((r) => r.id) } }, select: { departmentId: true, userId: true } });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(members.map((m) => m.userId))] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } });
  const uName = new Map(users.map((u) => [u.id, { id: u.id, name: nameOf(u) ?? "", employeeCode: u.employeeCode }]));
  const plats = await prisma.platform.findMany({ where: platformIds ? { id: { in: platformIds } } : {}, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const pName = new Map(plats.map((p) => [p.id, p.name]));
  return {
    ready: true,
    companies: plats,
    departments: rows.map((d) => ({ id: d.id, name: d.name, isActive: d.isActive, platformId: d.platformId, company: pName.get(d.platformId) ?? "", members: members.filter((m) => m.departmentId === d.id).map((m) => uName.get(m.userId)).filter(Boolean) })),
  };
}

export async function createDepartment(userId: string, body: { name?: unknown; platformId?: unknown }) {
  const me = await adminScope(userId);
  await needReady();
  const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) throw new Error("BAD_DEPARTMENT_NAME");
  const platformId = body.platformId ? String(body.platformId) : me.platformId;
  if (!me.viewer.access.all && !me.viewer.access.ids.includes(platformId)) throw new Error("NOT_FOUND");
  const dup = await prisma.department.findFirst({ where: { platformId, name: { equals: name, mode: "insensitive" } }, select: { id: true } });
  if (dup) throw new Error("DEPARTMENT_EXISTS");
  const d = await prisma.department.create({ data: { platformId, name } });
  auditNote({ module: "Queries", action: "CREATE", recordType: "Department", recordId: d.id, summary: `Created the department ${name}` });
  return { id: d.id };
}

export async function updateDepartment(userId: string, deptId: string, body: { name?: unknown; isActive?: unknown; memberIds?: unknown }) {
  const me = await adminScope(userId);
  await needReady();
  const d = await prisma.department.findUnique({ where: { id: deptId } });
  if (!d || (!me.viewer.access.all && !me.viewer.access.ids.includes(d.platformId))) throw new Error("NOT_FOUND");
  const data: { name?: string; isActive?: boolean } = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 80) throw new Error("BAD_DEPARTMENT_NAME");
    const dup = await prisma.department.findFirst({ where: { platformId: d.platformId, name: { equals: name, mode: "insensitive" }, id: { not: d.id } }, select: { id: true } });
    if (dup) throw new Error("DEPARTMENT_EXISTS");
    data.name = name;
  }
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;
  let members: string[] | null = null;
  if (body.memberIds !== undefined) {
    if (!Array.isArray(body.memberIds) || body.memberIds.length > 200) throw new Error("BAD_MEMBERS");
    members = [...new Set(body.memberIds.map(String))];
    // every member must be an active person of the department's own company
    const ok = members.length ? await prisma.user.count({ where: { id: { in: members }, platformId: d.platformId, status: "ACTIVE" } }) : 0;
    if (ok !== members.length) throw new Error("BAD_MEMBERS");
  }
  const before = (await prisma.departmentMember.findMany({ where: { departmentId: d.id }, select: { userId: true } })).map((m) => m.userId);
  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length) await tx.department.update({ where: { id: d.id }, data });
    if (members) {
      await tx.departmentMember.deleteMany({ where: { departmentId: d.id, userId: { notIn: members } } });
      await tx.departmentMember.createMany({ data: members.map((userId) => ({ departmentId: d.id, userId })), skipDuplicates: true });
    }
  });
  auditNote({ module: "Queries", action: "UPDATE", recordType: "Department", recordId: d.id, summary: `Updated the department ${data.name ?? d.name}`, before: { name: d.name, isActive: d.isActive, members: before.length }, after: { name: data.name ?? d.name, isActive: data.isActive ?? d.isActive, members: members ? members.length : before.length } });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------------
// RAISE (Stage 1)
// ---------------------------------------------------------------------------------------------------------------------------

async function fallbackAdmins(platformId: string, requesterId: string) {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN", status: "ACTIVE", id: { not: requesterId } }, select: { id: true } });
  const out: string[] = [];
  for (const a of admins) {
    const ac = await accessFor(a.id);
    if (ac.all || ac.ids.includes(platformId)) out.push(a.id);
  }
  return out;
}

/**
 * Who a request from this person goes to: the reporting manager (if there is a manager step) and the Admin(s) for the final approval.
 * ONE function used by both the real submit and the form's read-only preview, so what the form promises is what happens.
 */
async function routeFor(userId: string, role: string, platformId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, reportsToId: true } });
  const boss = u?.reportsToId ? await prisma.user.findUnique({ where: { id: u.reportsToId }, select: { id: true, role: true, status: true, reportsToId: true } }) : null;
  const bossFacts: L.Boss = boss ? { id: boss.id, role: String(boss.role), status: String(boss.status) } : null;
  const managerId = L.firstApprover({ id: userId, role }, bossFacts);
  // The Admin above: the manager's own boss when there is a manager step, otherwise the requester's boss.
  let above: L.Boss = bossFacts;
  if (managerId && boss?.reportsToId) {
    const mb = await prisma.user.findUnique({ where: { id: boss.reportsToId }, select: { id: true, role: true, status: true } });
    above = mb ? { id: mb.id, role: String(mb.role), status: String(mb.status) } : null;
  } else if (managerId) above = null;
  const mapped = L.mappedAdmin(userId, above);
  const adminApproverIds = mapped ? [mapped] : await fallbackAdmins(platformId, userId);
  return { managerId, adminApproverIds, usedFallback: !mapped };
}

/** What the form shows about the signed-in person, read from their own record (never typed by them): name, ID, company and who approves. */
export async function formPreview(userId: string) {
  const me = await who(userId);
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, employeeCode: true, designation: true, platformId: true } });
  if (!u) throw new Error("NOT_FOUND");
  const company = await prisma.platform.findUnique({ where: { id: u.platformId }, select: { name: true } });
  const route = await routeFor(userId, me.viewer.role, me.platformId);
  const ids = [route.managerId, ...route.adminApproverIds].filter((x): x is string => !!x);
  const people = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const nm = new Map(people.map((p) => [p.id, nameOf(p) ?? ""]));
  return {
    employee: { name: nameOf(u) ?? "", employeeCode: u.employeeCode, designation: u.designation, company: company?.name ?? "" },
    reportingManager: route.managerId ? nm.get(route.managerId) ?? null : null,
    hasManagerStep: !!route.managerId,
    finalApprovers: route.adminApproverIds.map((a) => nm.get(a) ?? "").filter(Boolean),
    adminsMapped: !route.usedFallback,
  };
}

export async function createRequest(userId: string, body: { title?: unknown; description?: unknown; departmentId?: unknown; priority?: unknown; attachment?: Upload | null }) {
  await needReady();
  const me = await who(userId);
  const title = String(body.title ?? "").trim().replace(/\s+/g, " ");
  const description = String(body.description ?? "").trim();
  if (title.length < 3) throw new Error("TITLE_REQUIRED");
  if (title.length > 150) throw new Error("TITLE_TOO_LONG");
  if (description.length < 5) throw new Error("DESCRIPTION_REQUIRED");
  if (description.length > 4000) throw new Error("DESCRIPTION_TOO_LONG");
  if (!L.isPriority(body.priority)) throw new Error("BAD_PRIORITY");
  const departmentId = String(body.departmentId ?? "");
  if (!departmentId) throw new Error("DEPARTMENT_REQUIRED");
  // Only an active department of the person's OWN company can be tagged.
  const dept = await prisma.department.findFirst({ where: { id: departmentId, platformId: me.platformId, isActive: true } });
  if (!dept) throw new Error("BAD_DEPARTMENT");
  const file = await store(me.platformId, body.attachment); // checked first: a bad file stops the whole thing

  const { managerId, adminApproverIds, usedFallback } = await routeFor(userId, me.viewer.role, me.platformId);

  const seq = await prisma.$queryRaw<{ n: bigint }[]>`select nextval('dept_request_ref_seq') as n`;
  const reference = `DQ-${String(seq[0].n).padStart(6, "0")}`;
  const stage: L.Approval = managerId ? "PENDING_MANAGER" : "PENDING_ADMIN";
  const created = await prisma.$transaction(async (tx) => {
    const r = await tx.deptRequest.create({
      data: { platformId: me.platformId, reference, raisedById: userId, title, description, priority: body.priority as string, departmentId, approvalStatus: stage, managerId, adminApproverIds },
    });
    const note = [
      managerId ? null : "No reporting manager step (no manager is mapped for this person).",
      usedFallback ? "No Admin is mapped above this person, so every Admin of the company can give the final approval." : null,
    ].filter(Boolean).join(" ");
    const ev = await addEvent(tx, { requestId: r.id, actorId: userId, kind: "CREATED", toValue: dept.name, note: note || null, file });
    return { r, ev };
  });
  const firstWho = managerId ? [managerId] : adminApproverIds;
  await tell(me.platformId, firstWho, created.r.id, created.ev.id, managerId ? "DEPT_QUERY_MANAGER_REVIEW" : "DEPT_QUERY_ADMIN_REVIEW", `${reference}: ${managerId ? "approval needed" : "final approval needed"}`, `${me.name} raised "${title}" for ${dept.name} (${L.PRIORITY_LABEL[body.priority as string]} priority).`);
  auditNote({ module: "Queries", action: "CREATE", recordType: "DeptRequest", recordId: created.r.id, summary: `Raised a department request: ${title} (${dept.name})`, after: { reference, department: dept.name, stage } });
  return { id: created.r.id, reference, stage, stageLabel: L.APPROVAL_LABEL[stage] };
}

// ---------------------------------------------------------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------------------------------------------------------

export type ListFilters = { view?: unknown; approval?: unknown; work?: unknown; departmentId?: unknown; priority?: unknown; q?: unknown };

export async function listRequests(userId: string, f: ListFilters = {}) {
  if (!(await deptReady())) return { ready: false, items: [], counts: {}, total: 0 };
  const me = await who(userId);
  const v = me.viewer;
  const or: Record<string, unknown>[] = [{ raisedById: userId }, { managerId: userId }, { adminApproverIds: { has: userId } }, { assigneeId: userId }];
  if (v.deptIds.length) or.push({ departmentId: { in: v.deptIds }, approvalStatus: "APPROVED" });
  if (v.role === "MANAGER" && v.reportIds.size) or.push({ raisedById: { in: [...v.reportIds] } });
  if (v.role === "ADMIN" || v.role === "HR") or.push(v.access.all ? {} : { platformId: { in: v.access.ids } });
  const rows = await prisma.deptRequest.findMany({ where: { OR: or as never }, orderBy: { createdAt: "desc" }, take: 800 });
  const visible = rows.filter((r) => L.canView(v, asFacts(r)));

  const userIds = [...new Set(visible.flatMap((r) => [r.raisedById, r.assigneeId, r.managerId].filter((x): x is string => !!x)))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } }) : [];
  const uName = new Map(users.map((u) => [u.id, u]));
  const depts = await prisma.department.findMany({ where: { id: { in: [...new Set(visible.map((r) => r.departmentId))] } }, select: { id: true, name: true } });
  const dName = new Map(depts.map((d) => [d.id, d.name]));

  const counts: Record<string, number> = {};
  for (const view of L.VIEWS) counts[view] = visible.filter((r) => L.inView(view, v, asFacts(r))).length;

  const view = L.VIEWS.find((x) => x === f.view) ?? "ALL";
  const approval = String(f.approval ?? "");
  const work = String(f.work ?? "");
  const departmentId = String(f.departmentId ?? "");
  const priority = String(f.priority ?? "");
  const q = String(f.q ?? "").trim().toLowerCase().slice(0, 100);
  const items = visible
    .filter((r) => L.inView(view, v, asFacts(r)))
    .filter((r) => !approval || r.approvalStatus === approval)
    .filter((r) => !work || r.workStatus === work)
    .filter((r) => !departmentId || r.departmentId === departmentId)
    .filter((r) => !priority || r.priority === priority)
    .filter((r) => {
      if (!q) return true;
      const p = uName.get(r.raisedById);
      return r.title.toLowerCase().includes(q) || r.reference.toLowerCase().includes(q) || (p ? `${p.firstName} ${p.lastName} ${p.employeeCode ?? ""}`.toLowerCase().includes(q) : false);
    })
    .slice(0, 500)
    .map((r) => {
      const p = uName.get(r.raisedById);
      return {
        id: r.id, reference: r.reference, title: r.title, priority: r.priority, priorityLabel: L.PRIORITY_LABEL[r.priority],
        approvalStatus: r.approvalStatus, approvalLabel: L.APPROVAL_LABEL[r.approvalStatus as L.Approval],
        workStatus: r.workStatus, workLabel: r.workStatus ? L.WORK_LABEL[r.workStatus as L.Work] : null,
        stage: L.stageOf({ approvalStatus: r.approvalStatus as L.Approval, workStatus: r.workStatus as L.Work | null, confirmedAt: r.confirmedAt }),
        department: dName.get(r.departmentId) ?? "", departmentId: r.departmentId,
        raisedBy: { id: r.raisedById, name: nameOf(p) ?? "", employeeCode: p?.employeeCode ?? null },
        assignedTo: nameOf(r.assigneeId ? uName.get(r.assigneeId) : null),
        createdAt: r.createdAt, isMine: r.raisedById === userId,
        needsYou: L.canManagerDecide(v, asFacts(r)) || L.canAdminDecide(v, asFacts(r)) || L.canConfirm(v, asFacts(r)) || (L.canAccept(v, asFacts(r))) || (r.assigneeId === userId && r.workStatus === "REOPENED"),
      };
    });
  return { ready: true, view, total: items.length, counts, items, isDeptMember: v.deptIds.length > 0 };
}

/** How many department requests are waiting for this person (feeds the sidebar badge together with the existing queries). */
export async function needsYouCount(userId: string): Promise<number> {
  if (!(await deptReady())) return 0;
  const l = await listRequests(userId, {});
  return l.ready ? (l.items as { needsYou: boolean }[]).filter((i) => i.needsYou).length : 0;
}

// ---------------------------------------------------------------------------------------------------------------------------
// ONE REQUEST
// ---------------------------------------------------------------------------------------------------------------------------

async function load(me: Who, id: string) {
  const r = await prisma.deptRequest.findUnique({ where: { id } });
  if (!r) throw new Error("NOT_FOUND");
  const facts = asFacts(r);
  if (!L.canView(me.viewer, facts)) throw new Error("NOT_FOUND"); // not allowed = "does not exist", so ids cannot be probed
  return { r, facts };
}

export async function getRequest(userId: string, id: string) {
  await needReady();
  const me = await who(userId);
  const v = me.viewer;
  const { r, facts } = await load(me, id);
  const events = await prisma.deptRequestEvent.findMany({ where: { requestId: id }, orderBy: { createdAt: "asc" } });
  const shown = events.filter((e) => L.canSeeNote(v, facts, e.visibility as L.NoteVisibility));
  const ids = [...new Set([r.raisedById, r.assigneeId, r.managerId, ...r.adminApproverIds, ...shown.map((e) => e.actorId)].filter((x): x is string => !!x))];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true } });
  const uName = new Map(users.map((u) => [u.id, u]));
  const dept = await prisma.department.findUnique({ where: { id: r.departmentId }, select: { name: true } });

  const canReassign = L.canReassign(v, facts);
  const members = canReassign ? await deptMemberIds(r.departmentId, r.raisedById) : [];
  const memberRows = members.length ? await prisma.user.findMany({ where: { id: { in: members } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const oversight = L.isOversight(v, facts);

  return {
    id: r.id, reference: r.reference, title: r.title, description: r.description, priority: r.priority, priorityLabel: L.PRIORITY_LABEL[r.priority],
    approvalStatus: r.approvalStatus, approvalLabel: L.APPROVAL_LABEL[r.approvalStatus as L.Approval],
    workStatus: r.workStatus, workLabel: r.workStatus ? L.WORK_LABEL[r.workStatus as L.Work] : null,
    stage: L.stageOf({ approvalStatus: r.approvalStatus as L.Approval, workStatus: r.workStatus as L.Work | null, confirmedAt: r.confirmedAt }),
    department: dept?.name ?? "", departmentId: r.departmentId,
    raisedBy: { id: r.raisedById, name: nameOf(uName.get(r.raisedById)) ?? "", employeeCode: uName.get(r.raisedById)?.employeeCode ?? null },
    // Who is responsible for the current step.
    responsible:
      r.approvalStatus === "PENDING_MANAGER" ? [nameOf(r.managerId ? uName.get(r.managerId) : null)].filter(Boolean)
        : r.approvalStatus === "PENDING_ADMIN" ? r.adminApproverIds.map((a) => nameOf(uName.get(a))).filter(Boolean)
          : r.assigneeId ? [nameOf(uName.get(r.assigneeId))].filter(Boolean) : [],
    manager: r.managerId ? nameOf(uName.get(r.managerId)) : null,
    admins: r.adminApproverIds.map((a) => nameOf(uName.get(a))).filter(Boolean),
    assignedTo: r.assigneeId ? { id: r.assigneeId, name: nameOf(uName.get(r.assigneeId)) ?? "" } : null,
    createdAt: r.createdAt, managerDecidedAt: r.managerDecidedAt, adminDecidedAt: r.adminDecidedAt, startedAt: r.startedAt, completedAt: r.completedAt, confirmedAt: r.confirmedAt, reopenCount: r.reopenCount,
    timeline: shown.map((e) => {
      const a = e.actorId ? uName.get(e.actorId) : null;
      return { id: e.id, kind: e.kind, by: nameOf(a), byRole: a ? String(a.role) : null, from: e.fromValue, to: e.toValue, note: e.note, visibility: e.visibility, at: e.createdAt, attachment: e.attachmentKey ? { name: e.attachmentName ?? "attachment" } : null };
    }),
    commentModes: L.commentVisibilities(v, facts),
    reassignOptions: memberRows.filter((m) => m.id !== r.assigneeId).map((m) => ({ id: m.id, name: nameOf(m) ?? "" })),
    permissions: {
      canManagerDecide: L.canManagerDecide(v, facts),
      canAdminDecide: L.canAdminDecide(v, facts),
      canAccept: L.canAccept(v, facts),
      canUpdateProgress: L.canUpdateProgress(v, facts),
      canReassign,
      canConfirm: L.canConfirm(v, facts),
      canReopen: L.canReopen(v, facts),
      canComment: L.commentVisibilities(v, facts).length > 0,
      isOversight: oversight,
      allowedProgress: L.canUpdateProgress(v, facts) ? L.SETTABLE_WORK.filter((s) => L.progressAllowed(r.workStatus as L.Work | null, s)) : [],
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// APPROVALS (Stages 2 and 3)
// ---------------------------------------------------------------------------------------------------------------------------

const noteOf = (v: unknown, min: number, max = 1000) => {
  const t = String(v ?? "").trim();
  if (t.length > max) throw new Error("NOTE_TOO_LONG");
  if (t.length < min) throw new Error("NOTE_REQUIRED");
  return t;
};

export async function managerDecide(userId: string, id: string, body: { approve?: unknown; note?: unknown }) {
  await needReady();
  const me = await who(userId);
  const { r, facts } = await load(me, id);
  if (!L.canManagerDecide(me.viewer, facts)) throw new Error(r.approvalStatus === "PENDING_MANAGER" ? "NOT_FOUND" : "STEP_ALREADY_DECIDED");
  const approve = body.approve === true;
  if (body.approve !== true && body.approve !== false) throw new Error("DECISION_REQUIRED");
  const note = approve ? noteOf(body.note, 0) : noteOf(body.note, 3);
  const res = await prisma.$transaction(async (tx) => {
    // guarded: only moves it if it is STILL waiting for this manager
    const upd = await tx.deptRequest.updateMany({
      where: { id, approvalStatus: "PENDING_MANAGER", managerId: userId },
      data: { approvalStatus: approve ? "PENDING_ADMIN" : "REJECTED", managerDecidedAt: new Date() },
    });
    if (upd.count !== 1) throw new Error("STEP_ALREADY_DECIDED");
    const ev = await addEvent(tx, { requestId: id, actorId: userId, kind: approve ? "MANAGER_APPROVED" : "MANAGER_REJECTED", fromValue: "PENDING_MANAGER", toValue: approve ? "PENDING_ADMIN" : "REJECTED", note: note || null, visibility: approve ? "APPROVERS" : "ALL" });
    return ev;
  });
  if (approve) await tell(r.platformId, r.adminApproverIds, id, res.id, "DEPT_QUERY_ADMIN_REVIEW", `${r.reference}: final approval needed`, `${me.name} approved "${r.title}". It now needs your final approval.`);
  else await tell(r.platformId, [r.raisedById], id, res.id, "DEPT_QUERY_REJECTED", `${r.reference}: not approved`, `Your reporting manager did not approve "${r.title}". Reason: ${note}`);
  auditNote({ module: "Queries", action: "UPDATE", recordType: "DeptRequest", recordId: id, targetUserId: r.raisedById, before: { approvalStatus: "PENDING_MANAGER" }, after: { approvalStatus: approve ? "PENDING_ADMIN" : "REJECTED" }, summary: `${approve ? "Approved" : "Rejected"} ${r.reference} as the reporting manager` });
  return { ok: true, approvalStatus: approve ? "PENDING_ADMIN" : "REJECTED" };
}

export async function adminDecide(userId: string, id: string, body: { approve?: unknown; note?: unknown }) {
  await needReady();
  const me = await who(userId);
  const { r, facts } = await load(me, id);
  if (!L.canAdminDecide(me.viewer, facts)) {
    // The Admin can never skip the manager step, and a request already decided cannot be decided again.
    if (r.approvalStatus === "PENDING_MANAGER" && me.viewer.role === "ADMIN") throw new Error("WAITING_FOR_MANAGER");
    if (r.approvalStatus !== "PENDING_ADMIN") throw new Error("STEP_ALREADY_DECIDED");
    throw new Error("NOT_FOUND");
  }
  if (body.approve !== true && body.approve !== false) throw new Error("DECISION_REQUIRED");
  const approve = body.approve === true;
  const note = approve ? noteOf(body.note, 0) : noteOf(body.note, 3);
  const ev = await prisma.$transaction(async (tx) => {
    const upd = await tx.deptRequest.updateMany({
      where: { id, approvalStatus: "PENDING_ADMIN", adminApproverIds: { has: userId } },
      data: approve ? { approvalStatus: "APPROVED", workStatus: "AWAITING_ACTION", adminDecidedAt: new Date() } : { approvalStatus: "REJECTED", adminDecidedAt: new Date() },
    });
    if (upd.count !== 1) throw new Error("STEP_ALREADY_DECIDED");
    return addEvent(tx, { requestId: id, actorId: userId, kind: approve ? "ADMIN_APPROVED" : "ADMIN_REJECTED", fromValue: "PENDING_ADMIN", toValue: approve ? "APPROVED" : "REJECTED", note: note || null, visibility: approve ? "APPROVERS" : "ALL" });
  });
  if (approve) {
    // ONLY now is the tagged department told.
    const members = await deptMemberIds(r.departmentId, r.raisedById);
    await tell(r.platformId, members, id, ev.id, "DEPT_QUERY_FOR_DEPARTMENT", `${r.reference}: new approved request`, `"${r.title}" was approved and is waiting for your department.`);
    await tell(r.platformId, [r.raisedById], id, ev.id, "DEPT_QUERY_APPROVED", `${r.reference}: approved`, `"${r.title}" was approved and sent to the department.`);
  } else {
    await tell(r.platformId, [r.raisedById, r.managerId], id, ev.id, "DEPT_QUERY_REJECTED", `${r.reference}: not approved`, `The Admin did not approve "${r.title}". Reason: ${note}`);
  }
  auditNote({ module: "Queries", action: "UPDATE", recordType: "DeptRequest", recordId: id, targetUserId: r.raisedById, before: { approvalStatus: "PENDING_ADMIN" }, after: { approvalStatus: approve ? "APPROVED" : "REJECTED" }, summary: `${approve ? "Approved" : "Rejected"} ${r.reference} as the Admin` });
  return { ok: true, approvalStatus: approve ? "APPROVED" : "REJECTED" };
}

// ---------------------------------------------------------------------------------------------------------------------------
// DEPARTMENT WORK (Stage 5)
// ---------------------------------------------------------------------------------------------------------------------------

export async function accept(userId: string, id: string) {
  await needReady();
  const me = await who(userId);
  const { r, facts } = await load(me, id);
  if (!L.canAccept(me.viewer, facts)) throw new Error(r.assigneeId ? "ALREADY_TAKEN" : "FORBIDDEN");
  const ev = await prisma.$transaction(async (tx) => {
    const upd = await tx.deptRequest.updateMany({ where: { id, assigneeId: null, workStatus: { in: ["AWAITING_ACTION", "REOPENED"] } }, data: { assigneeId: userId, workStatus: "NOT_STARTED" } });
    if (upd.count !== 1) throw new Error("ALREADY_TAKEN");
    return addEvent(tx, { requestId: id, actorId: userId, kind: "ACCEPTED", fromValue: r.workStatus, toValue: "NOT_STARTED", note: me.name });
  });
  await tell(r.platformId, [r.raisedById], id, ev.id, "DEPT_QUERY_ACCEPTED", `${r.reference}: picked up`, `${me.name} accepted "${r.title}" and will work on it.`);
  auditNote({ module: "Queries", action: "UPDATE", recordType: "DeptRequest", recordId: id, targetUserId: r.raisedById, summary: `Accepted ${r.reference} for the department` });
  return { ok: true };
}

export async function setProgress(userId: string, id: string, body: { status?: unknown; note?: unknown; attachment?: Upload | null }) {
  await needReady();
  const me = await who(userId);
  const { r, facts } = await load(me, id);
  if (!L.canUpdateProgress(me.viewer, facts)) throw new Error("FORBIDDEN");
  const to = String(body.status ?? "");
  if (!L.progressAllowed(r.workStatus as L.Work | null, to)) throw new Error("BAD_PROGRESS");
  const note = noteOf(body.note, L.progressNeedsNote(to) ? 3 : 0, 2000);
  const file = await store(r.platformId, body.attachment);
  const from = r.workStatus as string;
  const ev = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const upd = await tx.deptRequest.updateMany({
      where: { id, assigneeId: userId, workStatus: from },
      data: { workStatus: to, ...(to === "IN_PROGRESS" && !r.startedAt ? { startedAt: now } : {}), ...(to === "COMPLETED" ? { completedAt: now } : {}) },
    });
    if (upd.count !== 1) throw new Error("STEP_ALREADY_DECIDED");
    return addEvent(tx, { requestId: id, actorId: userId, kind: "PROGRESS", fromValue: from, toValue: to, note: note || null, file });
  });
  const label = L.WORK_LABEL[to as L.Work];
  if (to === "COMPLETED") await tell(r.platformId, [r.raisedById], id, ev.id, "DEPT_QUERY_COMPLETED", `${r.reference}: completed`, `"${r.title}" was marked completed. Please confirm it is resolved, or reopen it with a reason.`);
  else await tell(r.platformId, [r.raisedById], id, ev.id, "DEPT_QUERY_PROGRESS", `${r.reference}: ${label.toLowerCase()}`, `"${r.title}" is now ${label.toLowerCase()}.${note ? ` ${note}` : ""}`);
  auditNote({ module: "Queries", action: "UPDATE", recordType: "DeptRequest", recordId: id, targetUserId: r.raisedById, before: { workStatus: from }, after: { workStatus: to }, summary: `Set ${r.reference} to ${label.toLowerCase()}` });
  return { ok: true, workStatus: to };
}

export async function reassign(userId: string, id: string, body: { assigneeId?: unknown; note?: unknown }) {
  await needReady();
  const me = await who(userId);
  const { r, facts } = await load(me, id);
  if (!L.canReassign(me.viewer, facts)) throw new Error("FORBIDDEN");
  const to = String(body.assigneeId ?? "");
  if (!to) throw new Error("ASSIGNEE_REQUIRED");
  if (to === r.assigneeId) throw new Error("NOTHING_TO_CHANGE");
  // The new owner must be an ACTIVE member of THIS department and not the person who raised it.
  const members = await deptMemberIds(r.departmentId, r.raisedById);
  if (!members.includes(to)) throw new Error("BAD_ASSIGNEE");
  const note = noteOf(body.note, 0);
  const target = await prisma.user.findUnique({ where: { id: to }, select: { firstName: true, lastName: true } });
  const ev = await prisma.$transaction(async (tx) => {
    const upd = await tx.deptRequest.updateMany({ where: { id, assigneeId: r.assigneeId, workStatus: { not: "COMPLETED" } }, data: { assigneeId: to, ...(r.workStatus === "AWAITING_ACTION" ? { workStatus: "NOT_STARTED" } : {}) } });
    if (upd.count !== 1) throw new Error("STEP_ALREADY_DECIDED");
    return addEvent(tx, { requestId: id, actorId: userId, kind: "ASSIGNED", fromValue: r.assigneeId, toValue: to, note: `${nameOf(target)}${note ? `: ${note}` : ""}` });
  });
  await tell(r.platformId, [to], id, ev.id, "DEPT_QUERY_ASSIGNED", `${r.reference} assigned to you`, `${me.name} handed "${r.title}" to you.`, userId);
  await tell(r.platformId, [r.raisedById], id, ev.id, "DEPT_QUERY_PROGRESS", `${r.reference}: new owner`, `"${r.title}" is now handled by ${nameOf(target)}.`);
  auditNote({ module: "Queries", action: "UPDATE", recordType: "DeptRequest", recordId: id, targetUserId: r.raisedById, summary: `Reassigned ${r.reference} to ${nameOf(target)}` });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------------
// COMMENTS
// ---------------------------------------------------------------------------------------------------------------------------

export async function comment(userId: string, id: string, body: { body?: unknown; visibility?: unknown; attachment?: Upload | null }) {
  await needReady();
  const me = await who(userId);
  const { r, facts } = await load(me, id);
  const allowed = L.commentVisibilities(me.viewer, facts);
  if (allowed.length === 0) throw new Error("FORBIDDEN");
  const text = String(body.body ?? "").trim();
  if (text.length < 1) throw new Error("MESSAGE_REQUIRED");
  if (text.length > 2000) throw new Error("MESSAGE_TOO_LONG");
  const vis = (body.visibility ? String(body.visibility) : "ALL") as L.NoteVisibility;
  if (!allowed.includes(vis)) throw new Error("FORBIDDEN");
  const file = await store(r.platformId, body.attachment);
  const ev = await addEvent(prisma, { requestId: id, actorId: userId, kind: "COMMENT", note: text, visibility: vis, file });
  if (vis === "ALL") {
    // the other side hears about it: the employee when staff write, the department/assignee when the employee writes
    const others = r.raisedById === userId ? [r.assigneeId, ...(r.assigneeId ? [] : r.approvalStatus === "APPROVED" ? await deptMemberIds(r.departmentId, r.raisedById) : [r.managerId, ...r.adminApproverIds])] : [r.raisedById];
    await tell(r.platformId, others, id, ev.id, "DEPT_QUERY_COMMENT", `${r.reference}: new comment`, `${me.name} commented on "${r.title}".`, userId);
  }
  auditNote({ module: "Queries", action: "UPDATE", recordType: "DeptRequest", recordId: id, targetUserId: r.raisedById, summary: `Commented on ${r.reference}` });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------------
// EMPLOYEE'S ANSWER (Stage 6)
// ---------------------------------------------------------------------------------------------------------------------------

export async function confirm(userId: string, id: string) {
  await needReady();
  const me = await who(userId);
  const { r, facts } = await load(me, id);
  if (!L.canConfirm(me.viewer, facts)) throw new Error(r.raisedById === userId ? "NOT_COMPLETED_YET" : "FORBIDDEN");
  const ev = await prisma.$transaction(async (tx) => {
    const upd = await tx.deptRequest.updateMany({ where: { id, raisedById: userId, workStatus: "COMPLETED", confirmedAt: null }, data: { confirmedAt: new Date() } });
    if (upd.count !== 1) throw new Error("STEP_ALREADY_DECIDED");
    return addEvent(tx, { requestId: id, actorId: userId, kind: "CONFIRMED", note: "Confirmed as resolved" });
  });
  await tell(r.platformId, [r.assigneeId], id, ev.id, "DEPT_QUERY_CONFIRMED", `${r.reference}: confirmed`, `${me.name} confirmed "${r.title}" is resolved.`);
  auditNote({ module: "Queries", action: "UPDATE", recordType: "DeptRequest", recordId: id, summary: `Confirmed ${r.reference} as resolved` });
  return { ok: true };
}

export async function reopen(userId: string, id: string, body: { note?: unknown }) {
  await needReady();
  const me = await who(userId);
  const { r, facts } = await load(me, id);
  if (!L.canReopen(me.viewer, facts)) throw new Error(r.raisedById === userId ? "NOT_COMPLETED_YET" : "FORBIDDEN");
  const note = noteOf(body.note, 3);
  const ev = await prisma.$transaction(async (tx) => {
    const upd = await tx.deptRequest.updateMany({ where: { id, raisedById: userId, workStatus: "COMPLETED", confirmedAt: null }, data: { workStatus: "REOPENED", completedAt: null, reopenCount: { increment: 1 } } });
    if (upd.count !== 1) throw new Error("STEP_ALREADY_DECIDED");
    return addEvent(tx, { requestId: id, actorId: userId, kind: "REOPENED", fromValue: "COMPLETED", toValue: "REOPENED", note });
  });
  const dept = r.assigneeId ? [r.assigneeId] : await deptMemberIds(r.departmentId, r.raisedById);
  await tell(r.platformId, [...dept, r.managerId, ...r.adminApproverIds], id, ev.id, "DEPT_QUERY_REOPENED", `${r.reference}: reopened`, `${me.name} reopened "${r.title}". Reason: ${note}`, userId);
  auditNote({ module: "Queries", action: "UPDATE", recordType: "DeptRequest", recordId: id, summary: `Reopened ${r.reference}`, after: { reason: note } });
  return { ok: true };
}

export async function openAttachment(userId: string, id: string, eventId: string) {
  await needReady();
  const me = await who(userId);
  const { facts } = await load(me, id);
  const e = await prisma.deptRequestEvent.findFirst({ where: { id: eventId, requestId: id }, select: { attachmentKey: true, attachmentName: true, visibility: true } });
  if (!e?.attachmentKey || !L.canSeeNote(me.viewer, facts, e.visibility as L.NoteVisibility)) throw new Error("NOT_FOUND");
  return { buffer: await readStored(e.attachmentKey), fileName: e.attachmentName ?? "attachment", mimeType: contentTypeFor(e.attachmentKey) };
}

// DELETE (permanent). Anyone who may SEE a department request may delete it; an id they may not see answers "not found". It removes the request,
// its whole history and attachment files, and notifications pointing at it. A readable copy of what was removed is written to the audit log
// (immutable), so the deletion always leaves a trace.
export async function deleteRequest(userId: string, id: string, body: { confirm?: unknown }) {
  if (body?.confirm !== true) throw new Error("CONFIRM_REQUIRED");
  await needReady();
  const me = await who(userId);
  const { r } = await load(me, id);
  const events = await prisma.deptRequestEvent.findMany({ where: { requestId: id }, select: { attachmentKey: true } });
  const keys = events.map((e) => e.attachmentKey).filter((k): k is string => !!k);
  const dept = await prisma.department.findUnique({ where: { id: r.departmentId }, select: { name: true } });
  auditNote({
    recordType: "DeptRequest",
    recordId: id,
    targetUserId: r.raisedById,
    summary: `Permanently deleted department request ${r.reference}: ${r.title.slice(0, 80)}`,
    before: {
      reference: r.reference,
      title: r.title.slice(0, 200),
      description: r.description.slice(0, 280),
      department: dept?.name ?? null,
      approvalStatus: r.approvalStatus,
      workStatus: r.workStatus,
      priority: r.priority,
      historyEntries: events.length,
      attachments: keys.length,
      createdAt: r.createdAt,
    },
  });
  await prisma.$transaction(async (tx) => {
    await tx.deptRequest.delete({ where: { id } }); // its history goes with it (cascade)
    await tx.notification.deleteMany({ where: { link: { contains: id } } });
  });
  for (const k of keys) await deleteStored(k).catch((e) => console.error("[dept] could not remove a file:", e));
  return { ok: true };
}
