import { prisma } from "../../lib/prisma.js";
import { saveUpload, readStored, contentTypeFor } from "../../lib/storage.js";
import { notifyUsers } from "../../lib/notify.js";
import { auditNote } from "../../lib/auditContext.js";
import * as L from "./management.logic.js";

// ---------------------------------------------------------------------------
// TALK TO MANAGEMENT
// A private two-person conversation: the sender and the ONE Admin they chose. It lives in its own tables, never in tickets, so no
// HR / Query Desk query can return it. The audit log skips these routes (catalogue rule + auditNote skip) so the text never lands in a
// log HR can read. Notifications are generic: no message text and no name. Anyone else asking for a thread is told it does not exist.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/management_(threads|messages)/.test(msg) && /does not exist|relation/.test(msg));
};
let readyValue = false;
let readyCheckedAt = 0;
export async function managementReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await Promise.all([prisma.managementThread.findFirst({ select: { id: true } }), prisma.managementMessage.findFirst({ select: { id: true } })]);
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}
async function needReady() {
  if (!(await managementReady())) throw new Error("FEATURES_NOT_READY");
}

const nameOf = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : "Unknown");

type Upload = { fileName?: unknown; data?: unknown; mimeType?: unknown };
async function store(platformId: string, f: Upload | null | undefined) {
  if (!f || !f.data) return null;
  return saveUpload({ platformId, folder: "management", originalName: String(f.fileName ?? "attachment").slice(0, 120), data: String(f.data), mimeType: f.mimeType ? String(f.mimeType) : undefined });
}

async function tell(userId: string, type: string, title: string, body: string, threadId: string) {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { platformId: true } });
    if (!u) return;
    // Generic on purpose: no message text, no name.
    await notifyUsers({ platformId: u.platformId, userIds: [userId], type, title, body, link: `/dashboard/talk-to-management?id=${threadId}` });
  } catch (e) {
    console.error("[management-talk] could not notify:", e);
  }
}

/** Never log this request: the text is confidential. */
const quiet = () => auditNote({ skip: true });

async function loadThread(userId: string, threadId: string) {
  const t = await prisma.managementThread.findUnique({ where: { id: threadId } });
  // A stranger is told it does not exist, so ids cannot be probed.
  if (!t || !L.canViewThread(userId, t)) throw new Error("NOT_FOUND");
  return t;
}

/** Active Admins a person may write to (anyone but themselves). Names only. */
export async function listAdmins(userId: string) {
  const rows = await prisma.user.findMany({
    where: { role: "ADMIN", status: "ACTIVE", id: { not: userId } },
    select: { id: true, firstName: true, lastName: true, platform: { select: { name: true } } },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  return { admins: rows.map((r) => ({ id: r.id, name: nameOf(r), company: r.platform?.name ?? null })) };
}

export async function listThreads(userId: string) {
  if (!(await managementReady())) return { ready: false, asSender: [], asAdmin: [] };
  const rows = await prisma.managementThread.findMany({
    where: { OR: [{ senderId: userId }, { adminId: userId }] },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  const peopleIds = [...new Set(rows.flatMap((r) => [r.senderId, r.adminId]))];
  const [people, counts] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } }),
    prisma.managementMessage.groupBy({ by: ["threadId"], where: { threadId: { in: rows.map((r) => r.id) } }, _count: { _all: true } }),
  ]);
  const pm = new Map(people.map((p) => [p.id, p]));
  const cm = new Map(counts.map((c) => [c.threadId, c._count._all]));
  const shape = (r: (typeof rows)[number]) => ({
    id: r.id,
    subject: r.subject,
    status: r.status,
    statusLabel: L.STATUS_LABEL[r.status] ?? r.status,
    sender: { id: r.senderId, name: nameOf(pm.get(r.senderId)), employeeCode: pm.get(r.senderId)?.employeeCode ?? null },
    admin: { id: r.adminId, name: nameOf(pm.get(r.adminId)) },
    messageCount: cm.get(r.id) ?? 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    // the next move is the Admin's (waiting for them)
    needsYou: r.adminId === userId && r.status === "OPEN",
  });
  return { ready: true, asSender: rows.filter((r) => r.senderId === userId).map(shape), asAdmin: rows.filter((r) => r.adminId === userId).map(shape) };
}

export async function createThread(userId: string, body: { adminId?: unknown; subject?: unknown; message?: unknown; attachment?: Upload | null }) {
  quiet();
  await needReady();
  const adminId = String(body.adminId ?? "");
  const subject = L.cleanSubject(body.subject);
  const text = String(body.message ?? "").trim();
  if (!adminId) throw new Error("ADMIN_REQUIRED");
  if (subject.length < L.SUBJECT_MIN) throw new Error("SUBJECT_REQUIRED");
  if (subject.length > L.SUBJECT_MAX) throw new Error("SUBJECT_TOO_LONG");
  if (text.length < L.BODY_MIN) throw new Error("MESSAGE_REQUIRED");
  if (text.length > L.BODY_MAX) throw new Error("MESSAGE_TOO_LONG");
  if (!L.canTarget(userId, adminId)) throw new Error("BAD_ADMIN");
  const [me, admin] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { platformId: true } }),
    prisma.user.findFirst({ where: { id: adminId, role: "ADMIN", status: "ACTIVE" }, select: { id: true } }),
  ]);
  if (!me) throw new Error("NOT_FOUND");
  if (!admin) throw new Error("BAD_ADMIN");
  const file = await store(me.platformId, body.attachment); // checked first: a bad file stops the whole thing

  const thread = await prisma.$transaction(async (tx) => {
    const t = await tx.managementThread.create({ data: { platformId: me.platformId, senderId: userId, adminId, subject } });
    await tx.managementMessage.create({ data: { threadId: t.id, authorId: userId, body: text, ...(file ? { attachmentKey: file.storageKey, attachmentName: file.fileName } : {}) } });
    return t;
  });
  await tell(adminId, "MANAGEMENT_MESSAGE", "New confidential message", "Someone has written to you in Talk to Management.", thread.id);
  return { id: thread.id };
}

export async function getThread(userId: string, threadId: string) {
  await needReady();
  const t = await loadThread(userId, threadId);
  const [messages, people] = await Promise.all([
    prisma.managementMessage.findMany({ where: { threadId }, orderBy: { createdAt: "asc" } }),
    prisma.user.findMany({ where: { id: { in: [t.senderId, t.adminId] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } }),
  ]);
  const pm = new Map(people.map((p) => [p.id, p]));
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    statusLabel: L.STATUS_LABEL[t.status] ?? t.status,
    createdAt: t.createdAt,
    closedAt: t.closedAt,
    sender: { id: t.senderId, name: nameOf(pm.get(t.senderId)), employeeCode: pm.get(t.senderId)?.employeeCode ?? null },
    admin: { id: t.adminId, name: nameOf(pm.get(t.adminId)) },
    iAmAdmin: t.adminId === userId,
    canReply: L.canWrite(userId, t),
    canClose: L.canClose(userId, t),
    messages: messages.map((m) => ({
      id: m.id,
      authorId: m.authorId,
      authorName: nameOf(pm.get(m.authorId)),
      mine: m.authorId === userId,
      body: m.body,
      attachmentName: m.attachmentName,
      createdAt: m.createdAt,
    })),
  };
}

export async function reply(userId: string, threadId: string, body: { body?: unknown; attachment?: Upload | null }) {
  quiet();
  await needReady();
  const t = await loadThread(userId, threadId);
  const text = String(body.body ?? "").trim();
  if (text.length < L.BODY_MIN) throw new Error("MESSAGE_REQUIRED");
  if (text.length > L.BODY_MAX) throw new Error("MESSAGE_TOO_LONG");
  if (!L.canWrite(userId, t)) throw new Error("THREAD_CLOSED");
  const file = await store(t.platformId, body.attachment);
  const next = L.statusAfterMessage(userId, t);
  // The state is checked inside the write, so a thread closed a moment ago is not written to.
  const done = await prisma.$transaction(async (tx) => {
    const claim = await tx.managementThread.updateMany({ where: { id: threadId, status: { not: "CLOSED" } }, data: { status: next } });
    if (claim.count === 0) return false;
    await tx.managementMessage.create({ data: { threadId, authorId: userId, body: text, ...(file ? { attachmentKey: file.storageKey, attachmentName: file.fileName } : {}) } });
    return true;
  });
  if (!done) throw new Error("THREAD_CLOSED");
  const other = userId === t.adminId ? t.senderId : t.adminId;
  await tell(other, "MANAGEMENT_REPLY", "New confidential reply", "You have a new reply in Talk to Management.", threadId);
  return { ok: true };
}

export async function close(userId: string, threadId: string) {
  quiet();
  await needReady();
  const t = await loadThread(userId, threadId);
  if (!L.isAdminOf(userId, t)) throw new Error("FORBIDDEN");
  const res = await prisma.managementThread.updateMany({ where: { id: threadId, status: { not: "CLOSED" } }, data: { status: "CLOSED", closedAt: new Date() } });
  if (res.count === 0) throw new Error("THREAD_CLOSED");
  await tell(t.senderId, "MANAGEMENT_CLOSED", "Confidential conversation closed", "A Talk to Management conversation of yours was closed.", threadId);
  return { ok: true };
}

export async function openAttachment(userId: string, threadId: string, messageId: string) {
  await needReady();
  await loadThread(userId, threadId);
  const m = await prisma.managementMessage.findFirst({ where: { id: messageId, threadId }, select: { attachmentKey: true, attachmentName: true } });
  if (!m?.attachmentKey) throw new Error("NOT_FOUND");
  return { buffer: await readStored(m.attachmentKey), fileName: m.attachmentName ?? "attachment", mimeType: contentTypeFor(m.attachmentKey) };
}

/** How many threads are waiting for this Admin (sidebar badge). Zero before the tables exist. */
export async function waitingCount(userId: string) {
  if (!(await managementReady())) return { count: 0 };
  const count = await prisma.managementThread.count({ where: { adminId: userId, status: "OPEN" } });
  return { count };
}
