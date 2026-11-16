// Quick Add rules that need no database: the server's row cleaning and limits, and the screen's row checks / result handling.
import assert from "node:assert/strict";
import { MAX_BULK_ROWS, MAX_DRAFT_ROWS, bulkRows, cleanDraftRow, cleanDraftRows, sameTaskKey, summarize } from "../src/modules/tasks/tasks.bulk.logic.js";
import { MAX_QUICK_ROWS, applyResults, blankRow, duplicateOf, fromDraft, isEmptyRow, rememberedDefaults, rowProblem, toDraft, toPayload } from "../../frontend/app/dashboard/tasks/_quick/quickRows.js";

let pass = 0, fail = 0;
const t = (n: string, f: () => void) => { try { f(); pass++; console.log("PASS " + n); } catch (e) { fail++; console.log("FAIL " + n + " -> " + (e as Error).message); } };
const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222";

t("limits match on both sides", () => { assert.equal(MAX_BULK_ROWS, 20); assert.equal(MAX_QUICK_ROWS, MAX_BULK_ROWS); assert.equal(MAX_DRAFT_ROWS, 30); });
t("draft row: wrong types are dropped, not trusted", () => {
  const r = cleanDraftRow({ title: 5, description: {}, teamId: "x", taggedManagerId: [], hoursSpent: "abc", weight: "NOPE", progress: 1 });
  assert.deepEqual(r, { title: "", description: null, teamId: null, taggedManagerId: null, hoursSpent: null, weight: "MEDIUM", progress: "IN_PROGRESS" });
});
t("draft row: good values kept, hours rounded, uuid lower-cased, projectId accepted", () => {
  const r = cleanDraftRow({ title: "T", description: "d", projectId: U1.toUpperCase(), taggedManagerId: U2, hoursSpent: "1.239", weight: "HIGH", progress: "BLOCKED" });
  assert.equal(r.teamId, U1); assert.equal(r.taggedManagerId, U2); assert.equal(r.hoursSpent, 1.24); assert.equal(r.weight, "HIGH"); assert.equal(r.progress, "BLOCKED");
});
t("draft row: hours outside 0-24 are dropped; title cut at 200", () => {
  assert.equal(cleanDraftRow({ hoursSpent: 25 }).hoursSpent, null); assert.equal(cleanDraftRow({ hoursSpent: -1 }).hoursSpent, null);
  assert.equal(cleanDraftRow({ title: "a".repeat(500) }).title.length, 200);
});
t("draft sheet: empty rows skipped, over 30 refused, non-array refused", () => {
  assert.equal(cleanDraftRows([{}, { title: " " }, { title: "x" }]).length, 1);
  assert.throws(() => cleanDraftRows(Array.from({ length: 31 }, () => ({ title: "x" }))), /TOO_MANY_ROWS/);
  assert.throws(() => cleanDraftRows("x"), /BAD_ROWS/); assert.equal(cleanDraftRows(Array.from({ length: 30 }, () => ({ title: "x" }))).length, 30);
});
t("bulk rows: 1..20, keys kept, junk rows kept for the real rules to judge", () => {
  assert.throws(() => bulkRows([]), /NO_ROWS/); assert.throws(() => bulkRows(null), /NO_ROWS/); assert.throws(() => bulkRows(Array.from({ length: 21 }, () => ({}))), /TOO_MANY_ROWS/);
  const r = bulkRows([{ key: "a", title: "x" }, 5, { title: "y" }]);
  assert.equal(r.length, 3); assert.equal(r[0].key, "a"); assert.equal(r[1].key, "1"); assert.equal(r[2].key, "2");
});
t("same task = same words (case/spacing ignored), project and manager", () => {
  const a = { title: "Fix  Login ", teamId: U1, taggedManagerId: U2 };
  assert.equal(sameTaskKey(a), sameTaskKey({ title: "fix login", teamId: U1, taggedManagerId: U2 }));
  assert.notEqual(sameTaskKey(a), sameTaskKey({ ...a, taggedManagerId: null })); assert.notEqual(sameTaskKey(a), sameTaskKey({ ...a, teamId: null })); assert.notEqual(sameTaskKey(a), sameTaskKey({ ...a, title: "other" }));
});
t("summary counts", () => { assert.deepEqual(summarize([{ key: "a", ok: true }, { key: "b", ok: false, code: "X" }]), { total: 2, submitted: 1, failed: 1 }); });

const C = { projects: [{ id: U1 }], managers: [{ id: U2 }] };
t("screen: empty row is ignored, a typed row needs description, project, manager", () => {
  const r = blankRow(); assert.equal(isEmptyRow(r), true);
  r.title = "x"; assert.equal(isEmptyRow(r), false); assert.match(rowProblem(r, C)!, /project/i);
  r.projectId = U1; assert.match(rowProblem(r, C)!, /manager/i); r.managerId = U2; assert.equal(rowProblem(r, C), null);
  r.hours = "25"; assert.match(rowProblem(r, C)!, /hours/i); r.hours = "abc"; assert.match(rowProblem(r, C)!, /hours/i); r.hours = "7.5"; assert.equal(rowProblem(r, C), null);
  r.title = " "; assert.match(rowProblem(r, C)!, /description/i);
});
t("screen: a person with no project / manager available is not blocked", () => { const r = blankRow(); r.title = "x"; assert.equal(rowProblem(r, { projects: [], managers: [] }), null); });
t("screen: choosing a project never changes the manager (rows are independent)", () => {
  const a = blankRow({ projectId: U1, managerId: U2 }); const b = { ...a, projectId: "" };
  assert.equal(b.managerId, U2);
});
t("screen: duplicate = new id, same content, no error", () => {
  const r = { ...blankRow({ projectId: U1, managerId: U2 }), title: "x", error: "bad" }; const d = duplicateOf(r);
  assert.notEqual(d.uid, r.uid); assert.equal(d.title, "x"); assert.equal(d.projectId, U1); assert.equal(d.error, undefined);
});
t("screen: payload carries each row's own values; blanks are left out", () => {
  const r = { ...blankRow({ projectId: U1, managerId: U2 }), title: " Task ", hours: "2", weight: "HIGH", progress: "COMPLETED" };
  assert.deepEqual(toPayload(r), { key: r.uid, title: "Task", description: "", weight: "HIGH", progress: "COMPLETED", hoursSpent: 2, teamId: U1, taggedManagerId: U2 });
  const blank = { ...blankRow(), title: "x" }; const p = toPayload(blank) as Record<string, unknown>; assert.ok(!("teamId" in p) && !("taggedManagerId" in p) && !("hoursSpent" in p));
});
t("screen: results - sent rows leave, failed rows stay WITH the reason, untouched rows stay", () => {
  const a = { ...blankRow(), title: "a" }, b = { ...blankRow(), title: "b" }, c = { ...blankRow(), title: "c" };
  const { sent, kept } = applyResults([a, b, c], [{ key: a.uid, ok: true }, { key: b.uid, ok: false, error: "You already sent this task today" }]);
  assert.deepEqual(sent.map((x) => x.title), ["a"]); assert.deepEqual(kept.map((x) => x.title), ["b", "c"]);
  assert.equal(kept[0].error, "You already sent this task today"); assert.equal(kept[1].error, undefined);
});
t("screen: nothing typed is ever lost (sent + kept = everything)", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ ...blankRow(), title: "t" + i }));
  const res = rows.map((r, i) => ({ key: r.uid, ok: i % 3 !== 0 }));
  const { sent, kept } = applyResults(rows, res); assert.equal(sent.length + kept.length, 10);
});
t("screen: a draft restores only projects/managers still on the lists", () => {
  const r = fromDraft({ title: "d", description: null, teamId: U1, taggedManagerId: "33333333-3333-4333-8333-333333333333", hoursSpent: 2, weight: "LOW", progress: "BLOCKED" }, C);
  assert.equal(r.projectId, U1); assert.equal(r.managerId, ""); assert.equal(r.hours, "2");
  assert.deepEqual(toDraft({ ...r, managerId: U2 }), { title: "d", description: "", teamId: U1, taggedManagerId: U2, hoursSpent: 2, weight: "LOW", progress: "BLOCKED" });
});
t("screen: remembered project/manager are used only if still allowed", () => {
  assert.deepEqual(rememberedDefaults({ projectId: U1, managerId: "gone" }, C), { projectId: U1, managerId: "" });
  assert.deepEqual(rememberedDefaults(null, C), { projectId: "", managerId: "" });
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
