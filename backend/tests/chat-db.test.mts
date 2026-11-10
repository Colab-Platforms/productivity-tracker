// Chat against a real (TEST) database. Run with DATABASE_URL pointing at the test DB. Cleans up what it creates.
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import * as chat from "../src/modules/chat/chat.service.ts";

const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return (e as Error).message; } };
let n = 0;
const ok = (name: string) => { n++; console.log("ok -", name); };

const users = await prisma.user.findMany({ where: { status: { in: ["ACTIVE", "INVITED"] }, platform: { isActive: true } }, select: { id: true, platformId: true, role: true, firstName: true }, take: 400 });
const plats = new Set(users.map((u) => u.platformId));
console.log(`users ${users.length}, companies with users ${plats.size}`);
assert.ok(users.length >= 4, "need at least 4 active users in the test DB");
const [A, B, C, D] = users;
const other = users.find((u) => u.platformId !== A.platformId && ![B.id, C.id, D.id].includes(u.id));
const created: string[] = [];

try {
  assert.equal(await chat.chatReady(), true); ok("tables ready");

  const d1 = await chat.openConversation(A.id, { userIds: [B.id] });
  const d2 = await chat.openConversation(B.id, { userIds: [A.id] });
  created.push(d1.id);
  assert.equal(d1.id, d2.id); ok("direct chat is one per pair, from either side");
  assert.equal(await code(chat.openConversation(A.id, { userIds: [A.id] })), "PERSON_REQUIRED"); ok("cannot chat with yourself");
  assert.equal(await code(chat.openConversation(A.id, { userIds: ["00000000-0000-4000-8000-000000000000"] })), "PERSON_NOT_FOUND"); ok("unknown person refused");

  const listB0 = await chat.listConversations(B.id);
  assert.ok(!listB0.conversations.find((c) => c.id === d1.id)); ok("empty chat hidden from the other person");
  assert.ok((await chat.listConversations(A.id)).conversations.find((c) => c.id === d1.id)); ok("empty chat shown to opener");

  await chat.sendMessage(A.id, d1.id, { body: "  hello B  " });
  await chat.sendMessage(A.id, d1.id, { body: "second" });
  const lb = (await chat.listConversations(B.id)).conversations.find((c) => c.id === d1.id)!;
  assert.equal(lb.unread, 2); assert.equal(lb.lastMessage?.preview, "second"); assert.ok(lb.title.length > 0); ok("recipient sees chat with unread 2");
  assert.ok((await chat.unreadTotal(B.id)).unread >= 2); ok("unread total counts it");
  const la = (await chat.listConversations(A.id)).conversations.find((c) => c.id === d1.id)!;
  assert.equal(la.unread, 0); ok("sender has no unread from own message");
  await chat.markRead(B.id, d1.id);
  assert.equal((await chat.listConversations(B.id)).conversations.find((c) => c.id === d1.id)!.unread, 0); ok("mark read clears unread");
  const msgs = await chat.getMessages(B.id, d1.id);
  assert.equal(msgs.messages.length, 2); assert.equal(msgs.messages[0].body, "hello B"); ok("messages in order, trimmed");
  const mB = msgs.members.find((m) => m.id === B.id)!;
  assert.ok(new Date(mB.lastReadAt) >= new Date(msgs.messages[1].createdAt)); ok("members carry read time for seen ticks");

  assert.equal(await code(chat.getMessages(C.id, d1.id)), "NOT_FOUND");
  assert.equal(await code(chat.sendMessage(C.id, d1.id, { body: "x" })), "NOT_FOUND");
  assert.equal(await code(chat.markRead(C.id, d1.id)), "NOT_FOUND");
  assert.equal(await code(chat.deleteMessage(C.id, d1.id, msgs.messages[0].id)), "NOT_FOUND");
  ok("outsider gets NOT_FOUND on read/send/read-mark/delete");
  const admin = users.find((u) => (u.role === "ADMIN" || u.role === "HR") && ![A.id, B.id].includes(u.id));
  if (admin) { assert.equal(await code(chat.getMessages(admin.id, d1.id)), "NOT_FOUND"); ok("HR/Admin not in the chat cannot read it"); }

  assert.equal(await code(chat.sendMessage(A.id, d1.id, { body: "   " })), "MESSAGE_EMPTY");
  assert.equal(await code(chat.sendMessage(A.id, d1.id, { body: "x".repeat(4001) })), "MESSAGE_TOO_LONG");
  assert.equal(await code(chat.sendMessage(A.id, d1.id, { body: 12 })), "MESSAGE_EMPTY"); ok("bad messages refused");

  assert.equal(await code(chat.deleteMessage(B.id, d1.id, msgs.messages[0].id)), "NOT_YOURS"); ok("cannot delete someone else's message");
  await chat.deleteMessage(A.id, d1.id, msgs.messages[0].id);
  const after = await chat.getMessages(B.id, d1.id);
  assert.equal(after.messages[0].deleted, true); assert.equal(after.messages[0].body, ""); ok("deleted message shows as deleted, text gone");

  // edit
  await chat.sendMessage(A.id, d1.id, { body: "typo mesage" });
  const ed = (await chat.getMessages(A.id, d1.id)).messages.find((m) => m.body === "typo mesage")!;
  assert.equal(ed.edited, false);
  assert.equal(await code(chat.editMessage(B.id, d1.id, ed.id, { body: "hacked" })), "NOT_YOURS"); ok("cannot edit someone else's message");
  assert.equal(await code(chat.editMessage(C.id, d1.id, ed.id, { body: "hacked" })), "NOT_FOUND"); ok("outsider cannot edit");
  assert.equal(await code(chat.editMessage(A.id, d1.id, ed.id, { body: "   " })), "MESSAGE_EMPTY"); ok("edit to empty refused");
  assert.equal(await code(chat.editMessage(A.id, d1.id, ed.id, { body: "x".repeat(4001) })), "MESSAGE_TOO_LONG"); ok("edit too long refused");
  await chat.editMessage(A.id, d1.id, ed.id, { body: "  fixed message  " });
  const edAfter = (await chat.getMessages(B.id, d1.id)).messages.find((m) => m.id === ed.id)!;
  assert.equal(edAfter.body, "fixed message"); assert.equal(edAfter.edited, true); ok("edit changes text and marks it edited");
  await chat.editMessage(A.id, d1.id, ed.id, { body: "fixed message" }); ok("saving identical text is harmless");
  assert.ok((await chat.listConversations(B.id)).conversations.find((c) => c.id === d1.id)!.lastMessage?.preview === "fixed message"); ok("chat list preview shows the edited text");
  await prisma.chatMessage.update({ where: { id: ed.id }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
  await prisma.chatMember.updateMany({ where: { conversationId: d1.id }, data: { joinedAt: new Date(Date.now() - 3600_000) } }); // so the backdated message is still visible to them
  assert.equal(await code(chat.editMessage(A.id, d1.id, ed.id, { body: "too late" })), "EDIT_WINDOW_PASSED"); ok("cannot edit after 15 minutes");
  await chat.deleteMessage(A.id, d1.id, ed.id);
  assert.equal(await code(chat.editMessage(A.id, d1.id, ed.id, { body: "back" })), "MESSAGE_DELETED"); ok("cannot edit a deleted message");
  assert.equal((await chat.getMessages(B.id, d1.id)).messages.find((m) => m.id === ed.id)!.edited, false); ok("deleted message is not shown as edited");

  if (other) {
    const x = await chat.openConversation(A.id, { userIds: [other.id] });
    created.push(x.id);
    await chat.sendMessage(other.id, x.id, { body: "hi from another company" });
    assert.equal((await chat.getMessages(A.id, x.id)).messages.length, 1); ok("chat across companies works");
  } else console.log("skip - only one company has users in the test DB");

  assert.equal(await code(chat.openConversation(A.id, { userIds: [B.id, C.id] })), "TITLE_REQUIRED"); ok("group needs a name");
  const g = await chat.openConversation(A.id, { userIds: [B.id, C.id], title: "  Launch  team " });
  created.push(g.id);
  let gm = await chat.getMessages(A.id, g.id);
  assert.equal(gm.conversation.title, "Launch team"); assert.equal(gm.conversation.iAmAdmin, true); assert.equal(gm.members.length, 3); ok("group created, creator is admin");
  await chat.sendMessage(B.id, g.id, { body: "before D" });
  assert.equal(await code(chat.addMembers(B.id, g.id, { userIds: [D.id] })), "NOT_ADMIN"); ok("non-admin cannot add");
  assert.equal(await code(chat.renameGroup(B.id, g.id, { title: "x" })), "NOT_ADMIN"); ok("non-admin cannot rename");
  await new Promise((r) => setTimeout(r, 30));
  await chat.addMembers(A.id, g.id, { userIds: [D.id, D.id, B.id] });
  gm = await chat.getMessages(D.id, g.id);
  assert.equal(gm.messages.length, 0); ok("new member does not see earlier messages");
  await chat.sendMessage(B.id, g.id, { body: "after D" });
  assert.equal((await chat.getMessages(D.id, g.id)).messages.length, 1); ok("new member sees messages from then on");
  await chat.renameGroup(A.id, g.id, { title: "Renamed" });
  assert.equal((await chat.getMessages(A.id, g.id)).conversation.title, "Renamed"); ok("admin renames");
  await chat.removeMember(A.id, g.id, C.id);
  assert.equal(await code(chat.getMessages(C.id, g.id)), "NOT_FOUND"); ok("removed member loses access");
  assert.equal(await code(chat.removeMember(B.id, g.id, D.id)), "NOT_ADMIN"); ok("non-admin cannot remove others");
  await chat.removeMember(B.id, g.id, B.id); ok("member can leave");
  await chat.removeMember(A.id, g.id, A.id);
  const afterAdminLeft = await chat.getMessages(D.id, g.id);
  assert.equal(afterAdminLeft.conversation.iAmAdmin, true); ok("last admin leaving promotes someone");
  assert.equal(await code(chat.removeMember(A.id, d1.id, B.id)), "DIRECT_CANT_CHANGE"); ok("direct chat cannot be changed");
  assert.equal(await code(chat.addMembers(A.id, d1.id, { userIds: [C.id] })), "DIRECT_CANT_CHANGE"); ok("cannot add to direct chat");

  for (let i = 0; i < 4; i++) await chat.sendMessage(D.id, g.id, { body: `m${i}` });
  const page = await chat.getMessages(D.id, g.id, new Date(Date.now() + 1000).toISOString());
  assert.ok(page.messages.length >= 5); assert.equal(page.hasMore, false); ok("paging cursor works");
  assert.equal(await code(chat.getMessages(D.id, g.id, "not-a-date")), "BAD_CURSOR"); ok("bad cursor refused");

  const found = await chat.people(A.id, A.firstName.slice(0, 2));
  assert.ok(!found.people.find((p) => p.id === A.id)); ok("people search never lists yourself");
} finally {
  if (created.length) await prisma.chatConversation.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
}
console.log(`${n} checks passed`);
