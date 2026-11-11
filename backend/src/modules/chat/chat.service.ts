import { prisma } from "../../lib/prisma.js";
import { getPinnedCompany } from "../../lib/deployment.js";
import { emitChatChange } from "../../lib/realtime.js";
import { isUuid } from "../../lib/params.js";
import { canEditNow, cleanIds, cleanMessage, cleanTitle, directKey, LIMITS, groupReactions, isReaction, makeLimiter, previewOf, quotePreview } from "./chat.logic.js";

// ---------------------------------------------------------------------------
// CHAT
//
// Any active person can message any other active person, in any company (a deployment pinned to one company stays inside it).
// Rules:
//   - A conversation is visible ONLY to the people in it. HR and Admin get no extra view: for anyone else it simply does not exist (NOT_FOUND).
//   - DIRECT = two people, the same pair always finds the same chat. GROUP = a title and 2 or more others; group admins add, remove and rename.
//   - A member only sees messages sent after they joined.
//   - Text only. The sender can delete their own message (it stays as "Message deleted"). Messages are kept.
//   - The live connection carries only "conversation X changed"; the content always comes through this service, which checks membership.
// Before the migration is applied every function answers FEATURES_NOT_READY and nothing else changes.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/chat_(conversations|members|messages|reactions)/.test(msg) && /does not exist|relation/.test(msg));
};
let readyValue = false;
let checkedAt = 0;
export async function chatReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - checkedAt < 15_000) return false;
  checkedAt = Date.now();
  try {
    await Promise.all([prisma.chatConversation.findFirst({ select: { id: true } }), prisma.chatMember.findFirst({ select: { id: true } }), prisma.chatMessage.findFirst({ select: { id: true } }), prisma.chatReaction.findFirst({ select: { id: true } })]);
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}
async function requireReady() {
  if (!(await chatReady())) throw new Error("FEATURES_NOT_READY");
}

const nameOf = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();
const canSend = makeLimiter(LIMITS.perMinute);
const canReact = makeLimiter(60);

/** Who can be messaged: active or invited people in an active company (and inside the pinned company, if the deployment is pinned). */
async function eligibleWhere() {
  const pinned = await getPinnedCompany();
  return { status: { in: ["ACTIVE", "INVITED"] as never[] }, platform: { isActive: true }, ...(pinned ? { platformId: pinned.id } : {}) };
}

async function me(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, firstName: true, lastName: true } });
  if (!u) throw new Error("USER_NOT_FOUND");
  return u;
}

/** The caller's live membership, or NOT_FOUND (not a member, left, or no such chat: all look the same). */
async function membership(userId: string, conversationId: string) {
  const m = await prisma.chatMember.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
  if (!m || m.leftAt) throw new Error("NOT_FOUND");
  const conv = await prisma.chatConversation.findUnique({ where: { id: conversationId } });
  if (!conv) throw new Error("NOT_FOUND");
  return { m, conv };
}

type Person = { name: string; firstName: string; designation: string | null; company: string | null };
/** The tables have no relation to users on purpose, so people are looked up by id. */
async function personsById(ids: string[]): Promise<Map<string, Person>> {
  const rows = ids.length ? await prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, firstName: true, lastName: true, designation: true, platform: { select: { name: true } } } }) : [];
  return new Map(rows.map((r) => [r.id, { name: nameOf(r), firstName: r.firstName, designation: r.designation, company: r.platform?.name ?? null }]));
}

async function activeMemberIds(conversationId: string): Promise<string[]> {
  const rows = await prisma.chatMember.findMany({ where: { conversationId, leftAt: null }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

// --- reads --------------------------------------------------------------------------------------

export async function people(userId: string, q: unknown) {
  await requireReady();
  await me(userId);
  const text = typeof q === "string" ? q.trim().slice(0, 60) : "";
  const where = {
    ...(await eligibleWhere()),
    id: { not: userId },
    ...(text ? { OR: [{ firstName: { contains: text, mode: "insensitive" as const } }, { lastName: { contains: text, mode: "insensitive" as const } }, { employeeCode: { contains: text, mode: "insensitive" as const } }] } : {}),
  };
  const rows = await prisma.user.findMany({
    where,
    select: { id: true, firstName: true, lastName: true, designation: true, platform: { select: { name: true } } },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    take: 30,
  });
  return { people: rows.map((r) => ({ id: r.id, name: nameOf(r), designation: r.designation, company: r.platform?.name ?? null })) };
}

export async function unreadTotal(userId: string) {
  if (!(await chatReady())) return { unread: 0 };
  const mine = await prisma.chatMember.findMany({ where: { userId, leftAt: null }, select: { conversationId: true, lastReadAt: true, joinedAt: true } });
  const counts = await Promise.all(
    mine.map((m) =>
      prisma.chatMessage.count({ where: { conversationId: m.conversationId, senderId: { not: userId }, deletedAt: null, createdAt: { gt: m.lastReadAt > m.joinedAt ? m.lastReadAt : m.joinedAt } } })
    )
  );
  return { unread: counts.reduce((a, b) => a + b, 0) };
}

export async function listConversations(userId: string) {
  await requireReady();
  await me(userId);
  const mine = await prisma.chatMember.findMany({ where: { userId, leftAt: null }, select: { conversationId: true, lastReadAt: true, joinedAt: true } });
  if (mine.length === 0) return { ready: true, conversations: [] };
  const convs = await prisma.chatConversation.findMany({ where: { id: { in: mine.map((m) => m.conversationId) } }, orderBy: { lastMessageAt: "desc" }, take: 80 });
  const myRow = new Map(mine.map((m) => [m.conversationId, m]));
  const members = await prisma.chatMember.findMany({
    where: { conversationId: { in: convs.map((c) => c.id) }, leftAt: null },
    select: { conversationId: true, userId: true },
  });
  const who = await personsById(members.map((m) => m.userId));
  const byConv = new Map<string, typeof members>();
  for (const m of members) byConv.set(m.conversationId, [...(byConv.get(m.conversationId) ?? []), m]);

  const out = await Promise.all(
    convs.map(async (c) => {
      const mem = myRow.get(c.id)!;
      const since = mem.joinedAt;
      const [last, unread] = await Promise.all([
        prisma.chatMessage.findFirst({ where: { conversationId: c.id, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, select: { body: true, senderId: true, createdAt: true, deletedAt: true } }),
        prisma.chatMessage.count({ where: { conversationId: c.id, senderId: { not: userId }, deletedAt: null, createdAt: { gt: mem.lastReadAt > since ? mem.lastReadAt : since } } }),
      ]);
      const others = (byConv.get(c.id) ?? []).filter((x) => x.userId !== userId);
      const other = c.kind === "DIRECT" ? who.get(others[0]?.userId ?? "") : undefined;
      return {
        id: c.id,
        kind: c.kind,
        title: c.kind === "DIRECT" ? (other ? other.name : "Chat") : c.title ?? others.map((o) => who.get(o.userId)?.firstName ?? "").filter(Boolean).join(", "),
        subtitle: c.kind === "DIRECT" ? [other?.designation, other?.company].filter(Boolean).join(" · ") : `${(byConv.get(c.id) ?? []).length} people`,
        lastMessage: last ? { preview: previewOf(last.body, !!last.deletedAt), mine: last.senderId === userId, at: last.createdAt.toISOString() } : null,
        lastMessageAt: (last?.createdAt ?? c.lastMessageAt).toISOString(),
        unread,
      };
    })
  );
  // A direct chat nobody has written in yet is only visible to the person who opened it.
  const visible = out.filter((c) => c.lastMessage || c.kind !== "DIRECT" || convs.find((x) => x.id === c.id)?.createdById === userId);
  visible.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  return { ready: true, conversations: visible };
}

export async function getMessages(userId: string, conversationId: string, before?: unknown) {
  await requireReady();
  const { m, conv } = await membership(userId, conversationId);
  let cursor: Date | undefined;
  if (typeof before === "string" && before) {
    cursor = new Date(before);
    if (Number.isNaN(cursor.getTime())) throw new Error("BAD_CURSOR");
  }
  const rows = await prisma.chatMessage.findMany({
    where: { conversationId, createdAt: { gte: m.joinedAt, ...(cursor ? { lt: cursor } : {}) } },
    orderBy: { createdAt: "desc" },
    take: LIMITS.page + 1,
  });
  const hasMore = rows.length > LIMITS.page;
  const page = rows.slice(0, LIMITS.page).reverse();
  const members = await prisma.chatMember.findMany({
    where: { conversationId, leftAt: null },
    select: { userId: true, isAdmin: true, lastReadAt: true },
    orderBy: { joinedAt: "asc" },
  });
  // Replies quote the message they answer (even one further back than this page); reactions come with each message.
  const quotedIds = [...new Set(page.map((r) => r.replyToId).filter((x): x is string => !!x))];
  const quoted = quotedIds.length ? await prisma.chatMessage.findMany({ where: { id: { in: quotedIds }, conversationId }, select: { id: true, senderId: true, body: true, deletedAt: true } }) : [];
  const quotedBy = new Map(quoted.map((q) => [q.id, q]));
  const reactionRows = page.length ? await prisma.chatReaction.findMany({ where: { messageId: { in: page.map((r) => r.id) } }, select: { messageId: true, userId: true, emoji: true } }) : [];
  // Senders who have since left are still named on their old messages.
  const who = await personsById([...members.map((x) => x.userId), ...page.map((r) => r.senderId), ...quoted.map((q) => q.senderId), ...reactionRows.map((r) => r.userId)]);
  const nameFor = (id: string) => who.get(id)?.name ?? "Former member";
  const other = conv.kind === "DIRECT" ? who.get(members.find((x) => x.userId !== userId)?.userId ?? "") : undefined;
  return {
    conversation: {
      id: conv.id,
      kind: conv.kind,
      title: conv.kind === "DIRECT" ? (other ? other.name : "Chat") : conv.title ?? "Group",
      subtitle: conv.kind === "DIRECT" ? [other?.designation, other?.company].filter(Boolean).join(" · ") : `${members.length} people`,
      iAmAdmin: m.isAdmin,
    },
    members: members.map((x) => ({ id: x.userId, name: who.get(x.userId)?.name ?? "Former member", designation: who.get(x.userId)?.designation ?? null, company: who.get(x.userId)?.company ?? null, isAdmin: x.isAdmin, lastReadAt: x.lastReadAt.toISOString() })),
    messages: page.map((r) => ({ id: r.id, senderId: r.senderId, senderName: who.get(r.senderId)?.name ?? "Former member", body: r.deletedAt ? "" : r.body, createdAt: r.createdAt.toISOString(), deleted: !!r.deletedAt, edited: !!r.editedAt && !r.deletedAt,
      replyTo: r.replyToId && quotedBy.has(r.replyToId) ? { id: r.replyToId, senderName: nameFor(quotedBy.get(r.replyToId)!.senderId), preview: quotePreview(quotedBy.get(r.replyToId)!.body, !!quotedBy.get(r.replyToId)!.deletedAt), deleted: !!quotedBy.get(r.replyToId)!.deletedAt } : null,
      reactions: r.deletedAt ? [] : groupReactions(reactionRows.filter((x) => x.messageId === r.id), userId, nameFor),
    })),
    hasMore,
  };
}

// --- writes -------------------------------------------------------------------------------------

async function checkPeople(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const ok = await prisma.user.findMany({ where: { id: { in: ids }, ...(await eligibleWhere()) }, select: { id: true } });
  if (ok.length !== ids.length) throw new Error("PERSON_NOT_FOUND");
  return ids;
}

/** One person and no title = a direct chat (found again if it already exists). Otherwise a group: a title and at least one other person. */
export async function openConversation(userId: string, body: Record<string, unknown>) {
  await requireReady();
  await me(userId);
  const ids = cleanIds(body.userIds, userId);
  const title = cleanTitle(body.title);
  if (ids.length === 0) throw new Error("PERSON_REQUIRED");
  if (ids.length + 1 > LIMITS.groupMembers) throw new Error("TOO_MANY_MEMBERS");
  await checkPeople(ids);

  if (ids.length === 1 && !title) {
    const key = directKey(userId, ids[0]);
    const find = () => prisma.chatConversation.findUnique({ where: { directKey: key } });
    let conv = await find();
    if (!conv) {
      try {
        conv = await prisma.chatConversation.create({ data: { kind: "DIRECT", directKey: key, createdById: userId } });
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e;
        conv = await find();
      }
    }
    if (!conv) throw new Error("NOT_FOUND");
    for (const uid of [userId, ids[0]]) {
      await prisma.chatMember.upsert({ where: { conversationId_userId: { conversationId: conv.id, userId: uid } }, create: { conversationId: conv.id, userId: uid }, update: {} });
    }
    return { id: conv.id };
  }

  if (!title) throw new Error("TITLE_REQUIRED");
  const conv = await prisma.chatConversation.create({ data: { kind: "GROUP", title, createdById: userId } });
  await prisma.chatMember.createMany({ data: [{ conversationId: conv.id, userId, isAdmin: true }, ...ids.map((u) => ({ conversationId: conv.id, userId: u }))] });
  emitChatChange([userId, ...ids], conv.id);
  return { id: conv.id };
}

export async function sendMessage(userId: string, conversationId: string, body: Record<string, unknown>) {
  await requireReady();
  const text = cleanMessage(body.body);
  const { m, conv } = await membership(userId, conversationId);
  if (!canSend(userId)) throw new Error("SENDING_TOO_FAST");
  // A reply must point at a message of THIS conversation that the sender can see.
  let replyToId: string | null = null;
  if (body.replyToId !== undefined && body.replyToId !== null && body.replyToId !== "") {
    if (!isUuid(body.replyToId)) throw new Error("REPLY_NOT_FOUND");
    const target = await prisma.chatMessage.findFirst({ where: { id: String(body.replyToId), conversationId, createdAt: { gte: m.joinedAt } }, select: { id: true } });
    if (!target) throw new Error("REPLY_NOT_FOUND");
    replyToId = target.id;
  }
  // In a direct chat both people must still be allowed to chat (a suspended or exited person can neither send nor receive).
  const ids = await activeMemberIds(conversationId);
  if (conv.kind === "DIRECT" && ids.length < 2) throw new Error("NOT_FOUND");
  const now = new Date();
  const msg = await prisma.chatMessage.create({ data: { conversationId, senderId: userId, body: text, createdAt: now, replyToId } });
  await Promise.all([
    prisma.chatConversation.update({ where: { id: conversationId }, data: { lastMessageAt: now } }),
    prisma.chatMember.update({ where: { conversationId_userId: { conversationId, userId } }, data: { lastReadAt: now } }),
  ]);
  emitChatChange(ids, conversationId);
  return { id: msg.id, createdAt: msg.createdAt.toISOString() };
}

export async function markRead(userId: string, conversationId: string) {
  await requireReady();
  await membership(userId, conversationId);
  await prisma.chatMember.update({ where: { conversationId_userId: { conversationId, userId } }, data: { lastReadAt: new Date() } });
  // The other people's "seen" marker moves, and the reader's own other tabs clear their badge.
  emitChatChange(await activeMemberIds(conversationId), conversationId);
  return { ok: true };
}

export async function deleteMessage(userId: string, conversationId: string, messageId: string) {
  await requireReady();
  await membership(userId, conversationId);
  const msg = await prisma.chatMessage.findFirst({ where: { id: messageId, conversationId } });
  if (!msg) throw new Error("NOT_FOUND");
  if (msg.senderId !== userId) throw new Error("NOT_YOURS");
  if (!msg.deletedAt) await prisma.chatMessage.update({ where: { id: messageId }, data: { deletedAt: new Date(), body: "" } });
  emitChatChange(await activeMemberIds(conversationId), conversationId);
  return { ok: true };
}

/** Reacts with an emoji, or takes the reaction back if you already used that emoji on this message. */
export async function toggleReaction(userId: string, conversationId: string, messageId: string, body: Record<string, unknown>) {
  await requireReady();
  if (!isReaction(body.emoji)) throw new Error("BAD_EMOJI");
  const emoji: string = body.emoji;
  const { m } = await membership(userId, conversationId);
  if (!canReact(userId)) throw new Error("SENDING_TOO_FAST");
  const msg = await prisma.chatMessage.findFirst({ where: { id: messageId, conversationId, createdAt: { gte: m.joinedAt } }, select: { id: true, deletedAt: true } });
  if (!msg) throw new Error("NOT_FOUND");
  if (msg.deletedAt) throw new Error("MESSAGE_DELETED");
  const key = { messageId_userId_emoji: { messageId, userId, emoji } };
  const existing = await prisma.chatReaction.findUnique({ where: key });
  let reacted: boolean;
  if (existing) {
    await prisma.chatReaction.delete({ where: key }).catch(() => undefined);
    reacted = false;
  } else {
    try {
      await prisma.chatReaction.create({ data: { messageId, userId, emoji } });
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e; // a double click: it is already there
    }
    reacted = true;
  }
  emitChatChange(await activeMemberIds(conversationId), conversationId);
  return { reacted };
}

export async function editMessage(userId: string, conversationId: string, messageId: string, body: Record<string, unknown>) {
  await requireReady();
  const text = cleanMessage(body.body);
  await membership(userId, conversationId);
  const msg = await prisma.chatMessage.findFirst({ where: { id: messageId, conversationId } });
  if (!msg) throw new Error("NOT_FOUND");
  if (msg.senderId !== userId) throw new Error("NOT_YOURS");
  if (msg.deletedAt) throw new Error("MESSAGE_DELETED");
  if (!canEditNow(msg.createdAt)) throw new Error("EDIT_WINDOW_PASSED");
  if (text !== msg.body) {
    await prisma.chatMessage.update({ where: { id: messageId }, data: { body: text, editedAt: new Date() } });
    emitChatChange(await activeMemberIds(conversationId), conversationId);
  }
  return { ok: true };
}

async function groupAdmin(userId: string, conversationId: string) {
  const { m, conv } = await membership(userId, conversationId);
  if (conv.kind !== "GROUP") throw new Error("DIRECT_CANT_CHANGE");
  if (!m.isAdmin) throw new Error("NOT_ADMIN");
  return conv;
}

export async function renameGroup(userId: string, conversationId: string, body: Record<string, unknown>) {
  await requireReady();
  await groupAdmin(userId, conversationId);
  const title = cleanTitle(body.title);
  if (!title) throw new Error("TITLE_REQUIRED");
  await prisma.chatConversation.update({ where: { id: conversationId }, data: { title } });
  emitChatChange(await activeMemberIds(conversationId), conversationId);
  return { ok: true };
}

export async function addMembers(userId: string, conversationId: string, body: Record<string, unknown>) {
  await requireReady();
  await groupAdmin(userId, conversationId);
  const ids = cleanIds(body.userIds, userId);
  if (ids.length === 0) throw new Error("PERSON_REQUIRED");
  await checkPeople(ids);
  const current = new Set(await activeMemberIds(conversationId));
  const fresh = ids.filter((i) => !current.has(i));
  if (current.size + fresh.length > LIMITS.groupMembers) throw new Error("TOO_MANY_MEMBERS");
  const now = new Date();
  for (const uid of fresh) {
    // Someone added again starts clean: they see only what is sent from now on.
    await prisma.chatMember.upsert({
      where: { conversationId_userId: { conversationId, userId: uid } },
      create: { conversationId, userId: uid, joinedAt: now, lastReadAt: now },
      update: { leftAt: null, isAdmin: false, joinedAt: now, lastReadAt: now },
    });
  }
  emitChatChange([...current, ...fresh], conversationId);
  return { added: fresh.length };
}

/** Removes someone (admin) or leaves (yourself). A group never ends up without an admin while it still has people. */
export async function removeMember(userId: string, conversationId: string, targetId: string) {
  await requireReady();
  const { m, conv } = await membership(userId, conversationId);
  if (conv.kind !== "GROUP") throw new Error("DIRECT_CANT_CHANGE");
  if (targetId !== userId && !m.isAdmin) throw new Error("NOT_ADMIN");
  const target = await prisma.chatMember.findUnique({ where: { conversationId_userId: { conversationId, userId: targetId } } });
  if (!target || target.leftAt) throw new Error("NOT_FOUND");
  const before = await activeMemberIds(conversationId);
  await prisma.chatMember.update({ where: { conversationId_userId: { conversationId, userId: targetId } }, data: { leftAt: new Date(), isAdmin: false } });
  const left = await prisma.chatMember.findMany({ where: { conversationId, leftAt: null }, orderBy: { joinedAt: "asc" }, select: { userId: true, isAdmin: true } });
  if (left.length > 0 && !left.some((x) => x.isAdmin)) {
    await prisma.chatMember.update({ where: { conversationId_userId: { conversationId, userId: left[0].userId } }, data: { isAdmin: true } });
  }
  emitChatChange(before, conversationId); // includes the person who left, so their list updates too
  return { ok: true };
}

/** Who should hear that `userId` is typing in a conversation: its other members, or nobody if `userId` is not a member. */
export async function typingAudience(userId: string, conversationId: string): Promise<string[]> {
  if (!(await chatReady())) return [];
  const ids = await activeMemberIds(conversationId).catch(() => [] as string[]);
  return ids.includes(userId) ? ids.filter((x) => x !== userId) : [];
}
