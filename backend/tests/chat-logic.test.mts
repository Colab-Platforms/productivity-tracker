// Chat rules, no database. Run: DATABASE_URL=postgresql://u:p@127.0.0.1:1/x npx tsx tests/chat-logic.test.mts
import assert from "node:assert/strict";
import { canEditNow, EDIT_WINDOW_MS, cleanIds, cleanMessage, cleanTitle, directKey, isUnread, LIMITS, makeLimiter, previewOf } from "../src/modules/chat/chat.logic.ts";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const throws = (fn: () => unknown, code: string) => assert.throws(fn, (e: Error) => e.message === code);

t("directKey same for both orders", () => assert.equal(directKey("b", "a"), directKey("a", "b")));
t("message trimmed", () => assert.equal(cleanMessage("  hi \r\n there  "), "hi \n there"));
t("empty / blank / non-text message refused", () => { throws(() => cleanMessage(""), "MESSAGE_EMPTY"); throws(() => cleanMessage("   \n "), "MESSAGE_EMPTY"); throws(() => cleanMessage(5), "MESSAGE_EMPTY"); throws(() => cleanMessage(null), "MESSAGE_EMPTY"); });
t("message length limit", () => { cleanMessage("a".repeat(LIMITS.message)); throws(() => cleanMessage("a".repeat(LIMITS.message + 1)), "MESSAGE_TOO_LONG"); });
t("title rules", () => { assert.equal(cleanTitle(undefined), null); assert.equal(cleanTitle("  Team   A "), "Team A"); assert.equal(cleanTitle("   "), null); throws(() => cleanTitle(3), "TITLE_INVALID"); throws(() => cleanTitle("x".repeat(81)), "TITLE_TOO_LONG"); });
t("ids: unique, strings only, never self", () => assert.deepEqual(cleanIds(["a", "b", "a", 3, "me", null], "me"), ["a", "b"]));
t("ids: not a list = empty", () => assert.deepEqual(cleanIds("a", "me"), []));
t("preview", () => { assert.equal(previewOf("a\n b", false), "a b"); assert.equal(previewOf("secret", true), "Message deleted"); assert.equal(previewOf("x".repeat(500), false).length, LIMITS.preview); });
t("unread: others after last read only", () => {
  const read = new Date("2026-01-01T10:00:00Z");
  const after = new Date("2026-01-01T10:00:01Z");
  const before = new Date("2026-01-01T09:00:00Z");
  assert.equal(isUnread({ senderId: "o", createdAt: after, deletedAt: null }, "me", read), true);
  assert.equal(isUnread({ senderId: "o", createdAt: before, deletedAt: null }, "me", read), false);
  assert.equal(isUnread({ senderId: "me", createdAt: after, deletedAt: null }, "me", read), false);
  assert.equal(isUnread({ senderId: "o", createdAt: after, deletedAt: new Date() }, "me", read), false);
});
t("limiter: blocks after max in a minute, per person, frees later", () => {
  let now = 0;
  const ok = makeLimiter(3, () => now);
  assert.ok(ok("a") && ok("a") && ok("a"));
  assert.equal(ok("a"), false);
  assert.equal(ok("b"), true);
  now = 61_000;
  assert.equal(ok("a"), true);
});
t("edit window: 15 minutes after sending, not after", () => {
  const sent = new Date("2026-01-01T10:00:00Z");
  assert.equal(canEditNow(sent, sent.getTime() + EDIT_WINDOW_MS), true);
  assert.equal(canEditNow(sent, sent.getTime() + EDIT_WINDOW_MS + 1), false);
  assert.equal(EDIT_WINDOW_MS, 900_000);
});
console.log(`${n} checks passed`);
