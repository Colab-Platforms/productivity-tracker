import { prisma } from "../../lib/prisma.js";
import { parseIsoDay } from "../../lib/dates.js";
import { accessFor, deciderIdsForCompany } from "../../lib/companyAccess.js";
import { saveUpload, readStored, contentTypeFor } from "../../lib/storage.js";
import { notifyUsers } from "../../lib/notify.js";
import { auditNote } from "../../lib/auditContext.js";
import { visibleUserIds } from "../tracker/tracker.service.js";
import * as tickets from "../tickets/tickets.service.js";
import * as corrections from "../attendance-corrections/corrections.service.js";
import * as L from "./queries.logic.js";

// ---------------------------------------------------------------------------
// COMPLAINT CENTRE (employees) / QUERY DESK (HR, Manager, Admin)
//
// ONE place for everything a person raises or has to answer. It sits on top of what already exists and copies nothing:
//   - tickets  (the existing tickets tables: HR queries, technical issues and the new categories),
//   - attendance corrections (the existing module: it keeps its own approval workflow, manager step first, then HR).
// A correction is only LISTED here and opened with its own screen; it is never turned into a ticket.
// Visibility and permissions are the pure rules in queries.logic.ts, enforced here on every read and write.
// Before the migration (no query_meta / query_events tables) everything still works: new categories fall back to the old ticket
// categories and there is simply no "waiting for information" or history yet.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/query_(meta|events)/.test(msg) && /does not exist|relation/.test(msg));
};
let readyValue = false;
let readyCheckedAt = 0;
export async function queriesReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await Promise.all([prisma.queryMeta.findFirst({ select: { ticketId: true } }), prisma.queryEvent.findFirst({ select: { id: true } })]);
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

const nameOf = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);

async function who(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, platformId: true, firstName: true, lastName: true } });
  if (!u) throw new Error("NOT_FOUND");
  const a = await accessFor(userId);
  const viewer: L.Viewer = { id: u.id, role: String(u.role), access: { all: a.all, ids: a.ids } };
  // A manager's team = the people on the teams they run plus their direct reports (the same rule as Live Team).
  const teamIds = viewer.role === "MANAGER" ? new Set(await visibleUserIds({ id: u.id, role: viewer.role, platformId: u.platformId })) : new Set<string>();
  return { viewer, teamIds, platformId: u.platformId, name: nameOf(u) ?? "", firstName: u.firstName };
}
type Who = Awaited<ReturnType<typeof who>>;

async function metaFor(ticketIds: string[]) {
  const out = new Map<string, { categoryKey: string; awaitingInfoSince: Date | null }>();
  if (ticketIds.length === 0 || !(await queriesReady())) return out;
  const rows = await prisma.queryMeta.findMany({ where: { ticketId: { in: ticketIds } }, select: { ticketId: true, categoryKey: true, awaitingInfoSince: true } });
  for (const r of rows) out.set(r.ticketId, { categoryKey: r.categoryKey, awaitingInfoSince: r.awaitingInfoSince });
  return out;
}

/** The category shown for a ticket: the legacy attendance-correction ticket stays that; otherwise what the person chose, else the old one. */
function categoryOf(ticketCategory: string, meta: { categoryKey: string } | undefined): L.PickerCategory {
  if (ticketCategory === "ATTENDANCE_CORRECTION") return "ATTENDANCE_CORRECTION";
  if (meta && L.isQueryCategory(meta.categoryKey)) return meta.categoryKey;
  return L.legacyCategory(ticketCategory);
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open", IN_PROGRESS: "In progress", WAITING_FOR_EMPLOYEE: "Waiting for employee", RESOLVED: "Resolved", CLOSED: "Closed", REJECTED: "Rejected",
};

// ---------------------------------------------------------------------------------------------------------------------------
// ONE LIST (tickets + corrections)
// ---------------------------------------------------------------------------------------------------------------------------

export type ListFilters = { category?: unknown; status?: unknown; from?: unknown; to?: unknown; q?: unknown; employee?: unknown; kind?: unknown; mine?: unknown };

type Item = {
  kind: "TICKET" | "CORRECTION";
  id: string;
  reference: string | null;
  category: L.PickerCategory;
  categoryLabel: string;
  subject: string;
  status: string;
  statusLabel: string;
  subStatus: string | null;
  raisedBy: { id: string; name: string; employeeCode: string | null };
  assignedTo: string | null;
  createdAt: Date;
  dueAt: Date | null;
  isOverdue: boolean;
  messageCount: number;
  // true when the next move is the viewer's: staff to answer, or an employee asked for more information
  needsYou: boolean;
  isMine: boolean;
};

export async function listQueries(userId: string, f: ListFilters = {}) {
  const me = await who(userId);
  const { viewer } = me;
  const wantKind = f.kind === "TICKET" || f.kind === "CORRECTION" ? f.kind : null;
  const onlyMine = f.mine === true || f.mine === "1" || f.mine === "true";
  const items: Item[] = [];

  // ---- tickets ----
  if (wantKind !== "CORRECTION") {
    const where =
      viewer.role === "EMPLOYEE" || onlyMine
        ? { raisedById: userId }
        : viewer.role === "MANAGER"
          ? { OR: [{ raisedById: userId }, { assignedToId: userId }, { raisedById: { in: [...me.teamIds] } }] }
          : viewer.access.all
            ? {}
            : { OR: [{ raisedById: userId }, { platformId: { in: viewer.access.ids } }] };
    const rows = await prisma.ticket.findMany({
      where,
      select: {
        id: true, reference: true, platformId: true, category: true, status: true, subject: true, dueAt: true, resolvedAt: true, createdAt: true, raisedById: true, assignedToId: true,
        raisedBy: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        assignedTo: { select: { firstName: true, lastName: true } },
        _count: { select: { messages: true } },
        messages: { where: { isInternal: false }, orderBy: { createdAt: "desc" }, take: 1, select: { authorId: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 600,
    });
    const meta = await metaFor(rows.map((r) => r.id));
    const now = Date.now();
    for (const t of rows) {
      const m = meta.get(t.id);
      const category = categoryOf(String(t.category), m);
      if (!L.canViewQuery(viewer, { raisedById: t.raisedById, platformId: t.platformId, assignedToId: t.assignedToId, categoryKey: category }, me.teamIds)) continue;
      const awaitingInfo = !!m?.awaitingInfoSince;
      const status = L.displayStatus(String(t.status), awaitingInfo);
      const finished = L.statusIsFinished(String(t.status));
      const lastFromRaiser = t.messages.length === 0 || t.messages[0].authorId === t.raisedById;
      const handler = L.canHandleQuery(viewer, { raisedById: t.raisedById, platformId: t.platformId, assignedToId: t.assignedToId, categoryKey: category }, me.teamIds);
      items.push({
        kind: "TICKET", id: t.id, reference: t.reference, category, categoryLabel: L.CATEGORY_LABEL[category], subject: t.subject, status, statusLabel: STATUS_LABEL[status] ?? status, subStatus: null,
        raisedBy: { id: t.raisedBy.id, name: nameOf(t.raisedBy) ?? "", employeeCode: t.raisedBy.employeeCode },
        assignedTo: nameOf(t.assignedTo), createdAt: t.createdAt, dueAt: t.dueAt,
        isOverdue: !!t.dueAt && !t.resolvedAt && !finished && t.dueAt.getTime() < now,
        messageCount: t._count.messages,
        needsYou: !finished && (handler ? lastFromRaiser && !awaitingInfo : awaitingInfo && t.raisedById === userId),
        isMine: t.raisedById === userId,
      });
    }
  }

  // ---- attendance corrections: the existing module lists them; this only normalises how they look ----
  if (wantKind !== "TICKET") {
    const seen = new Set<string>();
    const add = (r: {
      id: string; date: string; typeLabel: string; status: string; createdAt: Date; reviewedBy?: string | null;
      managerStep?: { status: string; approvers: string[] } | null; employee?: { id: string; name: string; employeeCode: string | null };
    }, mineFlag: boolean) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      const open = r.status === "PENDING";
      const step = r.managerStep?.status ?? null;
      const status = open ? "OPEN" : r.status === "APPROVED" ? "RESOLVED" : r.status === "REJECTED" ? "REJECTED" : "CLOSED";
      const sub = open ? (step === "PENDING" ? "Waiting for manager" : step === "APPROVED" ? "Manager approved, waiting for HR" : "Waiting for HR") : r.status === "APPROVED" ? "Approved" : r.status === "REJECTED" ? "Rejected" : "Cancelled";
      items.push({
        kind: "CORRECTION", id: r.id, reference: null, category: "ATTENDANCE_CORRECTION", categoryLabel: L.CATEGORY_LABEL.ATTENDANCE_CORRECTION,
        subject: `${r.typeLabel}, ${r.date}`, status, statusLabel: STATUS_LABEL[status], subStatus: sub,
        raisedBy: r.employee ?? { id: userId, name: me.name, employeeCode: null }, assignedTo: r.reviewedBy ?? null, createdAt: new Date(r.createdAt), dueAt: null, isOverdue: false, messageCount: 0,
        needsYou: open && !mineFlag, isMine: mineFlag,
      });
    };
    const mine = (await corrections.listMine(userId)).requests;
    for (const r of mine) add(r as never, true);
    if (!onlyMine && viewer.role === "MANAGER") {
      const t = await corrections.managerRequests(userId);
      for (const r of [...(t.pending as never[]), ...(t.answered as never[])]) if (r) add(r, false);
    }
    if (!onlyMine && (viewer.role === "HR" || viewer.role === "ADMIN")) {
      for (const r of (await corrections.listForReview(userId, {})).requests) add(r as never, (r as { employee?: { id: string } }).employee?.id === userId);
    }
  }

  // ---- filters (the same for both kinds) ----
  const category = L.PICKER_CATEGORIES.find((c) => c === f.category);
  const status = String(f.status ?? "");
  const q = String(f.q ?? "").trim().toLowerCase().slice(0, 100);
  const employee = String(f.employee ?? "").trim().toLowerCase().slice(0, 100);
  const from = f.from ? parseIsoDay(f.from) : null;
  const to = f.to ? new Date(parseIsoDay(f.to).getTime() + 86_400_000) : null;
  const filtered = items
    .filter((i) => !category || i.category === category)
    .filter((i) => !status || i.status === status)
    .filter((i) => !from || i.createdAt.getTime() >= from.getTime())
    .filter((i) => !to || i.createdAt.getTime() < to.getTime())
    .filter((i) => !q || i.subject.toLowerCase().includes(q) || (i.reference ?? "").toLowerCase().includes(q))
    .filter((i) => !employee || i.raisedBy.name.toLowerCase().includes(employee) || (i.raisedBy.employeeCode ?? "").toLowerCase().includes(employee))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const staff = viewer.role !== "EMPLOYEE";
  return {
    label: staff ? "Query Desk" : "Complaint Centre",
    isStaff: staff,
    total: filtered.length,
    summary: {
      open: filtered.filter((i) => i.status === "OPEN" || i.status === "IN_PROGRESS").length,
      waitingForEmployee: filtered.filter((i) => i.status === "WAITING_FOR_EMPLOYEE").length,
      finished: filtered.filter((i) => ["RESOLVED", "CLOSED", "REJECTED"].includes(i.status)).length,
      needsYou: filtered.filter((i) => i.needsYou).length,
    },
    items: filtered.slice(0, 500),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// BADGE
// ---------------------------------------------------------------------------------------------------------------------------

export async function counts(userId: string) {
  const l = await listQueries(userId, {});
  return { badge: l.summary.needsYou, needsYou: l.summary.needsYou };
}

// ---------------------------------------------------------------------------------------------------------------------------
// RAISE
// ---------------------------------------------------------------------------------------------------------------------------

type Upload = { fileName?: unknown; data?: unknown; mimeType?: unknown };
async function store(platformId: string, f: Upload | null | undefined) {
  if (!f || !f.data) return null;
  return saveUpload({ platformId, folder: "queries", originalName: String(f.fileName ?? "attachment").slice(0, 120), data: String(f.data), mimeType: f.mimeType ? String(f.mimeType) : undefined });
}

async function event(o: { ticketId: string; platformId: string; actorId: string | null; kind: "CREATED" | "ASSIGNED" | "STATUS" | "INFO_REQUESTED" | "INFO_RECEIVED"; fromValue?: string | null; toValue?: string | null; note?: string | null }) {
  if (!(await queriesReady())) return;
  await prisma.queryEvent.create({ data: { ticketId: o.ticketId, platformId: o.platformId, actorId: o.actorId, kind: o.kind, fromValue: o.fromValue ?? null, toValue: o.toValue ?? null, note: o.note ?? null } });
}

async function tell(platformId: string, userIds: string[], ticketId: string, type: string, title: string, body: string) {
  try {
    await notifyUsers({ platformId, userIds, type, title, body, link: `/dashboard/queries?kind=ticket&id=${ticketId}`, data: { ticketId } });
  } catch (e) {
    console.error("[queries] could not notify:", e);
  }
}

export async function createQuery(userId: string, body: { category?: unknown; subject?: unknown; description?: unknown; priority?: unknown; attachment?: Upload | null }) {
  const me = await who(userId);
  // An attendance correction is raised with its own form and keeps its own approval workflow.
  if (body.category === "ATTENDANCE_CORRECTION") throw new Error("USE_CORRECTION_FORM");
  if (!L.isQueryCategory(body.category)) throw new Error("BAD_CATEGORY");
  const subject = String(body.subject ?? "").trim().replace(/\s+/g, " ");
  const description = String(body.description ?? "").trim();
  if (subject.length < 3) throw new Error("SUBJECT_REQUIRED");
  if (subject.length > 150) throw new Error("SUBJECT_TOO_LONG");
  if (description.length < 5) throw new Error("DESCRIPTION_REQUIRED");
  if (description.length > 4000) throw new Error("DESCRIPTION_TOO_LONG");
  const category = body.category;
  const file = await store(me.platformId, body.attachment); // checked first: a bad file stops the whole thing

  const created = await tickets.createTicket(userId, { category: L.TICKET_CATEGORY_FOR[category], subject, description, priority: typeof body.priority === "string" ? body.priority : undefined });

  if (await queriesReady()) await prisma.queryMeta.create({ data: { ticketId: created.id, platformId: me.platformId, categoryKey: category } });
  await event({ ticketId: created.id, platformId: me.platformId, actorId: userId, kind: "CREATED", toValue: category });
  if (file) await prisma.ticketMessage.create({ data: { ticketId: created.id, authorId: userId, body: "Attached a file with the query.", attachmentKey: file.storageKey, attachmentName: file.fileName } });

  const staff = created.assignedToId ? [created.assignedToId] : await deciderIdsForCompany(me.platformId, userId);
  await tell(me.platformId, staff.filter((id) => id !== userId), created.id, "QUERY_RAISED", `New query: ${subject}`, `${me.name} raised a ${L.CATEGORY_LABEL[category].toLowerCase()}: ${subject}`);
  auditNote({ module: "Queries", action: "CREATE", recordType: "Ticket", recordId: created.id, summary: `Raised a query (${L.CATEGORY_LABEL[category]}): ${subject}`, after: { category, reference: created.reference } });
  return { id: created.id, reference: created.reference };
}

// ---------------------------------------------------------------------------------------------------------------------------
// ONE QUERY
// ---------------------------------------------------------------------------------------------------------------------------

async function load(me: Who, ticketId: string) {
  const t = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      raisedBy: { select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true } },
      assignedTo: { select: { id: true, firstName: true, lastName: true } },
      messages: { orderBy: { createdAt: "asc" }, include: { author: { select: { id: true, firstName: true, lastName: true, role: true } } } },
    },
  });
  if (!t) throw new Error("NOT_FOUND");
  const meta = (await metaFor([t.id])).get(t.id);
  const category = categoryOf(String(t.category), meta);
  const facts: L.TicketFacts = { raisedById: t.raisedById, platformId: t.platformId, assignedToId: t.assignedToId, categoryKey: category };
  // Someone who may not see it is told it does not exist (so ids cannot be probed).
  if (!L.canViewQuery(me.viewer, facts, me.teamIds)) throw new Error("NOT_FOUND");
  return { t, meta, category, facts };
}

export async function getQuery(userId: string, ticketId: string) {
  const me = await who(userId);
  const { t, meta, category, facts } = await load(me, ticketId);
  const handler = L.canHandleQuery(me.viewer, facts, me.teamIds);
  const manage = L.canManageQuery(me.viewer, facts);
  const canAssign = (me.viewer.role === "HR" || me.viewer.role === "ADMIN") && (me.viewer.access.all || me.viewer.access.ids.includes(t.platformId)) && t.raisedById !== userId;
  const awaitingInfo = !!meta?.awaitingInfoSince;
  const finished = L.statusIsFinished(String(t.status));
  const closedForReplies = String(t.status) === "CLOSED" || String(t.status) === "REJECTED";

  const events = (await queriesReady())
    ? await prisma.queryEvent.findMany({ where: { ticketId }, orderBy: { createdAt: "asc" }, select: { id: true, actorId: true, kind: true, fromValue: true, toValue: true, note: true, createdAt: true } })
    : [];
  const actorIds = [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x))];
  const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const actorName = new Map(actors.map((a) => [a.id, nameOf(a) ?? ""]));

  let assignees: { id: string; name: string; role: string }[] = [];
  if (canAssign) {
    const rows = await prisma.user.findMany({
      where: { platformId: t.platformId, status: "ACTIVE", role: { in: category === "PAYROLL" ? ["HR", "ADMIN"] : ["HR", "ADMIN", "MANAGER"] } },
      select: { id: true, firstName: true, lastName: true, role: true },
      orderBy: [{ role: "asc" }, { firstName: "asc" }],
    });
    assignees = rows.map((r) => ({ id: r.id, name: nameOf(r) ?? "", role: String(r.role) }));
  }

  return {
    id: t.id,
    reference: t.reference,
    kind: "TICKET" as const,
    category,
    categoryLabel: L.CATEGORY_LABEL[category],
    status: L.displayStatus(String(t.status), awaitingInfo),
    rawStatus: String(t.status),
    statusLabel: STATUS_LABEL[L.displayStatus(String(t.status), awaitingInfo)],
    priority: String(t.priority),
    subject: t.subject,
    description: t.description,
    resolutionNote: t.resolutionNote,
    raisedBy: { id: t.raisedBy.id, name: nameOf(t.raisedBy) ?? "", employeeCode: t.raisedBy.employeeCode },
    assignedTo: t.assignedTo ? { id: t.assignedTo.id, name: nameOf(t.assignedTo) ?? "" } : null,
    createdAt: t.createdAt, dueAt: t.dueAt, firstReplyAt: t.firstReplyAt, resolvedAt: t.resolvedAt, closedAt: t.closedAt,
    awaitingInfoSince: meta?.awaitingInfoSince ?? null,
    // The legacy attendance-correction ticket keeps its own screen action; new ones are never raised this way.
    legacyCorrection: String(t.category) === "ATTENDANCE_CORRECTION",
    messages: t.messages
      // Internal notes are for the people handling it, never for the person who raised it.
      .filter((m) => !m.isInternal || handler)
      .map((m) => ({ id: m.id, body: m.body, isInternal: m.isInternal, createdAt: m.createdAt, author: nameOf(m.author) ?? "", authorId: m.author.id, authorIsStaff: String(m.author.role) !== "EMPLOYEE", attachment: m.attachmentKey ? { name: m.attachmentName ?? "attachment" } : null })),
    // Everything that happened to it, oldest first (status changes, assignments, information requests).
    events: events.map((e) => ({ id: e.id, kind: e.kind, by: e.actorId ? actorName.get(e.actorId) ?? null : null, from: e.fromValue, to: e.toValue, note: e.note, at: e.createdAt })),
    assignees,
    permissions: {
      canReply: (t.raisedById === userId || handler) && !closedForReplies,
      canAddInternalNote: handler,
      canRequestInfo: handler && !finished && (await queriesReady()),
      canChangeStatus: manage,
      canAssign,
      canReopen: manage && finished,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// REPLY, REQUEST INFORMATION, STATUS, ASSIGN, ATTACHMENT
// ---------------------------------------------------------------------------------------------------------------------------

export async function reply(userId: string, ticketId: string, body: { body?: unknown; internal?: unknown; attachment?: Upload | null }) {
  const me = await who(userId);
  const { t, meta, facts } = await load(me, ticketId);
  const text = String(body.body ?? "").trim();
  if (text.length < 1) throw new Error("MESSAGE_REQUIRED");
  if (text.length > 4000) throw new Error("MESSAGE_TOO_LONG");
  const handler = L.canHandleQuery(me.viewer, facts, me.teamIds);
  const isRaiser = t.raisedById === userId;
  if (!isRaiser && !handler) throw new Error("NOT_FOUND");
  if (String(t.status) === "CLOSED" || String(t.status) === "REJECTED") throw new Error("QUERY_CLOSED");
  const internal = body.internal === true && handler;
  const file = await store(t.platformId, body.attachment);

  const awaitingInfo = !!meta?.awaitingInfoSince;
  const reopen = isRaiser && String(t.status) === "RESOLVED";
  const staffReply = !isRaiser && !internal;
  await prisma.$transaction(async (tx) => {
    await tx.ticketMessage.create({ data: { ticketId, authorId: userId, body: text, isInternal: internal, ...(file ? { attachmentKey: file.storageKey, attachmentName: file.fileName } : {}) } });
    const data: Record<string, unknown> = {};
    if (staffReply && !t.firstReplyAt) data.firstReplyAt = new Date();
    if (staffReply && String(t.status) === "OPEN") data.status = "IN_PROGRESS";
    if (reopen) { data.status = "IN_PROGRESS"; data.resolvedAt = null; }
    if (Object.keys(data).length) await tx.ticket.update({ where: { id: ticketId }, data });
  });
  if (isRaiser && awaitingInfo) {
    await prisma.queryMeta.update({ where: { ticketId }, data: { awaitingInfoSince: null, awaitingInfoById: null } });
    await event({ ticketId, platformId: t.platformId, actorId: userId, kind: "INFO_RECEIVED" });
  }
  if (reopen) await event({ ticketId, platformId: t.platformId, actorId: userId, kind: "STATUS", fromValue: "RESOLVED", toValue: "IN_PROGRESS", note: "Reopened by the person who raised it" });

  if (!internal) {
    const others = isRaiser
      ? (t.assignedToId ? [t.assignedToId] : await deciderIdsForCompany(t.platformId, userId))
      : [t.raisedById];
    await tell(t.platformId, others.filter((id) => id !== userId), ticketId, isRaiser ? "QUERY_REPLY_STAFF" : "QUERY_REPLY", `${t.reference}: new reply`, `${me.name} replied to "${t.subject}".`);
  }
  return { ok: true };
}

export async function requestInfo(userId: string, ticketId: string, body: { message?: unknown }) {
  const me = await who(userId);
  const { t, facts } = await load(me, ticketId);
  if (!L.canHandleQuery(me.viewer, facts, me.teamIds)) throw new Error("NOT_FOUND");
  if (!(await queriesReady())) throw new Error("FEATURES_NOT_READY");
  if (L.statusIsFinished(String(t.status))) throw new Error("QUERY_CLOSED");
  const text = String(body.message ?? "").trim();
  if (text.length < 3) throw new Error("MESSAGE_REQUIRED");
  if (text.length > 4000) throw new Error("MESSAGE_TOO_LONG");
  await prisma.$transaction(async (tx) => {
    await tx.ticketMessage.create({ data: { ticketId, authorId: userId, body: text, isInternal: false } });
    await tx.queryMeta.upsert({
      where: { ticketId },
      update: { awaitingInfoSince: new Date(), awaitingInfoById: userId },
      create: { ticketId, platformId: t.platformId, categoryKey: facts.categoryKey === "ATTENDANCE_CORRECTION" ? "OTHER" : facts.categoryKey, awaitingInfoSince: new Date(), awaitingInfoById: userId },
    });
    await tx.ticket.update({ where: { id: ticketId }, data: { ...(t.firstReplyAt ? {} : { firstReplyAt: new Date() }), ...(String(t.status) === "OPEN" ? { status: "IN_PROGRESS" } : {}) } });
  });
  await event({ ticketId, platformId: t.platformId, actorId: userId, kind: "INFO_REQUESTED", note: text.slice(0, 300) });
  await tell(t.platformId, [t.raisedById], ticketId, "QUERY_INFO_REQUESTED", `${t.reference}: more information needed`, `${me.name} needs more information about "${t.subject}". Open it and reply.`);
  auditNote({ module: "Queries", action: "UPDATE", recordType: "Ticket", recordId: ticketId, targetUserId: t.raisedById, summary: `Asked for more information on ${t.reference}` });
  return { ok: true };
}

const SETTABLE = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "REJECTED"] as const;

export async function setStatus(userId: string, ticketId: string, body: { status?: unknown; note?: unknown }) {
  const me = await who(userId);
  const { t, meta, facts } = await load(me, ticketId);
  if (!L.canManageQuery(me.viewer, facts)) throw new Error("FORBIDDEN");
  const next = SETTABLE.find((s) => s === body.status);
  if (!next) throw new Error("BAD_STATUS");
  const current = String(t.status);
  if (next === current) throw new Error("NOTHING_TO_CHANGE");
  const note = String(body.note ?? "").trim().slice(0, 1000);
  // Telling the person WHY a query is resolved or rejected is what makes the answer useful.
  if ((next === "RESOLVED" || next === "REJECTED") && note.length < 3) throw new Error("NOTE_REQUIRED");
  await prisma.$transaction(async (tx) => {
    await tx.ticket.update({
      where: { id: ticketId },
      data: {
        status: next,
        ...(next === "RESOLVED" ? { resolvedAt: new Date() } : {}),
        ...(next === "CLOSED" ? { closedAt: new Date() } : {}),
        ...(next === "OPEN" || next === "IN_PROGRESS" ? { resolvedAt: null, closedAt: null } : {}),
        ...(note ? { resolutionNote: note } : {}),
      },
    });
    if (note) await tx.ticketMessage.create({ data: { ticketId, authorId: userId, body: `${STATUS_LABEL[next]}: ${note}`, isInternal: false } });
  });
  if (meta?.awaitingInfoSince && L.statusIsFinished(next)) await prisma.queryMeta.update({ where: { ticketId }, data: { awaitingInfoSince: null, awaitingInfoById: null } });
  await event({ ticketId, platformId: t.platformId, actorId: userId, kind: "STATUS", fromValue: current, toValue: next, note: note || null });
  await tell(t.platformId, [t.raisedById], ticketId, "QUERY_STATUS", `${t.reference}: ${STATUS_LABEL[next].toLowerCase()}`, `Your query "${t.subject}" is now ${STATUS_LABEL[next].toLowerCase()}.${note ? ` ${note}` : ""}`);
  auditNote({ module: "Queries", action: "UPDATE", recordType: "Ticket", recordId: ticketId, targetUserId: t.raisedById, before: { status: current }, after: { status: next }, summary: `Set ${t.reference} to ${STATUS_LABEL[next].toLowerCase()}` });
  return { ok: true, status: next };
}

export async function assign(userId: string, ticketId: string, body: { assigneeId?: unknown }) {
  const me = await who(userId);
  const { t, facts } = await load(me, ticketId);
  const staffInScope = (me.viewer.role === "HR" || me.viewer.role === "ADMIN") && (me.viewer.access.all || me.viewer.access.ids.includes(t.platformId));
  if (!staffInScope || t.raisedById === userId) throw new Error("FORBIDDEN");
  const assigneeId = String(body.assigneeId ?? "");
  if (!assigneeId) throw new Error("ASSIGNEE_REQUIRED");
  const a = await prisma.user.findUnique({ where: { id: assigneeId }, select: { id: true, role: true, platformId: true, status: true, firstName: true, lastName: true } });
  if (!a || !L.canAssignTo({ role: String(a.role), platformId: a.platformId, status: String(a.status) }, { platformId: t.platformId, categoryKey: facts.categoryKey })) throw new Error("BAD_ASSIGNEE");
  if (a.id === t.assignedToId) throw new Error("NOTHING_TO_CHANGE");
  await prisma.ticket.update({ where: { id: ticketId }, data: { assignedToId: a.id } });
  await event({ ticketId, platformId: t.platformId, actorId: userId, kind: "ASSIGNED", fromValue: t.assignedToId, toValue: a.id, note: nameOf(a) });
  await tell(t.platformId, [a.id], ticketId, "QUERY_ASSIGNED", `${t.reference} assigned to you`, `${me.name} assigned "${t.subject}" to you.`);
  auditNote({ module: "Queries", action: "UPDATE", recordType: "Ticket", recordId: ticketId, targetUserId: t.raisedById, summary: `Assigned ${t.reference} to ${nameOf(a)}` });
  return { ok: true };
}

export async function openAttachment(userId: string, ticketId: string, messageId: string) {
  const me = await who(userId);
  const { facts, t } = await load(me, ticketId);
  const m = await prisma.ticketMessage.findFirst({ where: { id: messageId, ticketId }, select: { attachmentKey: true, attachmentName: true, isInternal: true } });
  if (!m?.attachmentKey) throw new Error("NOT_FOUND");
  if (m.isInternal && !L.canHandleQuery(me.viewer, facts, me.teamIds)) throw new Error("NOT_FOUND");
  void t;
  return { buffer: await readStored(m.attachmentKey), fileName: m.attachmentName ?? "attachment", mimeType: contentTypeFor(m.attachmentKey) };
}

export const categories = () => ({
  categories: L.PICKER_CATEGORIES.map((key) => ({ key, label: L.CATEGORY_LABEL[key], opensCorrectionForm: key === "ATTENDANCE_CORRECTION" })),
});
