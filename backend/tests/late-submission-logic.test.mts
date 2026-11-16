// Previous-day (late) task submission rules that need no database: the server's date window and reason rules, and the screen's mirror of them.
import assert from "node:assert/strict";
import { DEFAULT_ALLOWED_DAYS, MAX_BACKDATE_DAYS, checkBackdate, daysBefore, parseAllowedDays } from "../src/modules/tasks/tasks.late.logic.js";
import { LATE_REASON_MAX, lateState, reasonProblem } from "../../frontend/app/dashboard/tasks/_quick/quickRows.js";

let pass = 0, fail = 0;
const t = (n: string, f: () => void) => { try { f(); pass++; console.log("PASS " + n); } catch (e) { fail++; console.log("FAIL " + n + " -> " + (e as Error).message); } };
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const TODAY = day("2026-11-16");
const ago = (n: number) => new Date(TODAY.getTime() - n * 86400000);
const code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return (e as Error).message; } };

t("constants: default 3 days, hard limit 14", () => { assert.equal(DEFAULT_ALLOWED_DAYS, 3); assert.equal(MAX_BACKDATE_DAYS, 14); });
t("days before today are counted in calendar days", () => { assert.equal(daysBefore(TODAY, ago(1)), 1); assert.equal(daysBefore(TODAY, ago(3)), 3); assert.equal(daysBefore(TODAY, TODAY), 0); assert.equal(daysBefore(TODAY, ago(-2)), -2); });
t("today and the future are not previous dates", () => {
  assert.equal(code(() => checkBackdate({ forDate: TODAY, today: TODAY, allowedDays: 3 })), "BACKDATE_NOT_PAST");
  assert.equal(code(() => checkBackdate({ forDate: ago(-1), today: TODAY, allowedDays: 3 })), "BACKDATE_NOT_PAST");
});
t("yesterday and exactly 3 days back are inside the window; reason optional", () => {
  const y = checkBackdate({ forDate: ago(1), today: TODAY, allowedDays: 3 });
  assert.deepEqual(y, { lateByDays: 1, outsideWindow: false, reason: null });
  const e = checkBackdate({ forDate: ago(3), today: TODAY, allowedDays: 3, reason: "  forgot  " });
  assert.deepEqual(e, { lateByDays: 3, outsideWindow: false, reason: "forgot" });
});
t("4 days back is outside the window: a reason (3+ characters) is required", () => {
  assert.equal(code(() => checkBackdate({ forDate: ago(4), today: TODAY, allowedDays: 3 })), "LATE_REASON_REQUIRED");
  assert.equal(code(() => checkBackdate({ forDate: ago(4), today: TODAY, allowedDays: 3, reason: "  " })), "LATE_REASON_REQUIRED");
  assert.equal(code(() => checkBackdate({ forDate: ago(4), today: TODAY, allowedDays: 3, reason: "ab" })), "LATE_REASON_REQUIRED");
  assert.deepEqual(checkBackdate({ forDate: ago(4), today: TODAY, allowedDays: 3, reason: "On leave, then a server outage" }), { lateByDays: 4, outsideWindow: true, reason: "On leave, then a server outage" });
});
t("14 days is the oldest accepted, 15 is never accepted (even with a reason)", () => {
  assert.equal(checkBackdate({ forDate: ago(14), today: TODAY, allowedDays: 3, reason: "long leave" }).lateByDays, 14);
  assert.equal(code(() => checkBackdate({ forDate: ago(15), today: TODAY, allowedDays: 3, reason: "long leave" })), "BACKDATE_TOO_OLD");
  assert.equal(code(() => checkBackdate({ forDate: ago(400), today: TODAY, allowedDays: 14, reason: "x".repeat(50) })), "BACKDATE_TOO_OLD");
});
t("reason longer than 300 is refused", () => {
  assert.equal(code(() => checkBackdate({ forDate: ago(1), today: TODAY, allowedDays: 3, reason: "x".repeat(301) })), "LATE_REASON_TOO_LONG");
  assert.equal(checkBackdate({ forDate: ago(1), today: TODAY, allowedDays: 3, reason: "x".repeat(300) }).reason?.length, 300);
});
t("the company setting changes the window", () => {
  assert.equal(checkBackdate({ forDate: ago(5), today: TODAY, allowedDays: 5 }).outsideWindow, false);
  assert.equal(code(() => checkBackdate({ forDate: ago(1), today: TODAY, allowedDays: 0 })), "LATE_REASON_REQUIRED");
  assert.equal(checkBackdate({ forDate: ago(1), today: TODAY, allowedDays: 14 }).outsideWindow, false);
});
t("setting values: whole numbers 0 to 14 only", () => {
  for (const ok of [0, 3, 14, "7"]) assert.notEqual(parseAllowedDays(ok), "BAD");
  for (const bad of [-1, 15, 2.5, "x", "", null, undefined, NaN, {}]) assert.equal(parseAllowedDays(bad as never), "BAD");
});

t("screen mirrors the server: past / too old / outside", () => {
  assert.deepEqual(lateState("2026-11-15", "2026-11-16", 3, 14), { lateByDays: 1, notPast: false, tooOld: false, outside: false });
  assert.equal(lateState("2026-11-13", "2026-11-16", 3, 14).outside, false);
  assert.equal(lateState("2026-11-12", "2026-11-16", 3, 14).outside, true);
  assert.equal(lateState("2026-11-02", "2026-11-16", 3, 14).tooOld, false);
  assert.equal(lateState("2026-11-01", "2026-11-16", 3, 14).tooOld, true);
  assert.equal(lateState("2026-11-16", "2026-11-16", 3, 14).notPast, true);
  assert.equal(lateState("2026-11-20", "2026-11-16", 3, 14).notPast, true);
  assert.equal(lateState("", "2026-11-16", 3, 14).notPast, true);
});
t("screen and server agree for every distance from -2 to 16 days", () => {
  for (let n = -2; n <= 16; n++) {
    const date = new Date(TODAY.getTime() - n * 86400000).toISOString().slice(0, 10);
    const s = lateState(date, "2026-11-16", 3, 14);
    const server = code(() => checkBackdate({ forDate: ago(n), today: TODAY, allowedDays: 3, reason: "a reason" }));
    assert.equal(s.notPast, server === "BACKDATE_NOT_PAST", `notPast at ${n}`);
    assert.equal(s.tooOld, server === "BACKDATE_TOO_OLD", `tooOld at ${n}`);
    if (server === "none") assert.equal(s.outside, checkBackdate({ forDate: ago(n), today: TODAY, allowedDays: 3, reason: "a reason" }).outsideWindow, `outside at ${n}`);
  }
});
t("screen reason rule: required only outside the window; 300 max", () => {
  assert.equal(reasonProblem("", false), null); assert.equal(reasonProblem("", true), "Add a reason for submitting this late.");
  assert.equal(reasonProblem("ab", true) !== null, true); assert.equal(reasonProblem("abc", true), null);
  assert.equal(reasonProblem("x".repeat(LATE_REASON_MAX + 1), false) !== null, true);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
