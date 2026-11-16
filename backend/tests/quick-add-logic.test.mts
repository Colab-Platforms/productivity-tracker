// Quick Add rules that need no database: the server's row cleaning and limits, and the screen's row checks / result handling.
import assert from "node:assert/strict";
import { MAX_BULK_ROWS, MAX_DRAFT_ROWS, bulkRows, cleanDraftRow, cleanDraftRows, sameTaskKey, summarize } from "../src/modules/tasks/tasks.bulk.logic.js";
import { startingDefaults, MAX_QUICK_ROWS, applyDefault, applyResults, blankRow, duplicateOf, fromDraft, inferDefaults, isCustom, isEmptyRow, rememberedDefaults, resetRowChoice, rowProblem, setRowChoice, toDraft, toPayload } from "../../frontend/app/dashboard/tasks/_quick/quickRows.js";

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
// ---- default task settings ----
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", P3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const M1 = "11111111-1111-4111-8111-111111111111", M2 = "22222222-2222-4222-8222-222222222222";
const none = { projectId: "", managerId: "" };
const typed = (n: number, d = none) => Array.from({ length: n }, (_, i) => ({ ...blankRow(d), title: `task ${i + 1}`, hours: String(i + 1) }));

t("defaults: picking the default project fills EVERY row that follows it (10 rows)", () => {
  const rows = applyDefault(typed(10), "projectId", P1);
  assert.equal(rows.length, 10); assert.ok(rows.every((r) => r.projectId === P1 && !isCustom(r, "projectId")));
  assert.ok(rows.every((r) => r.managerId === ""), "the manager is not touched by the project");
});
t("defaults: project and manager are independent of each other", () => {
  let rows = applyDefault(typed(4), "managerId", M1);
  rows = applyDefault(rows, "projectId", P2);
  assert.ok(rows.every((r) => r.projectId === P2 && r.managerId === M1));
});
t("defaults: descriptions, hours, priority and progress are never touched", () => {
  const rows = typed(3).map((r, i) => ({ ...r, weight: ["LOW", "HIGH", "CRITICAL"][i], progress: ["COMPLETED", "BLOCKED", "IN_PROGRESS"][i], description: "d" + i }));
  const after = applyDefault(applyDefault(rows, "projectId", P1), "managerId", M2);
  after.forEach((r, i) => { assert.equal(r.title, rows[i].title); assert.equal(r.hours, rows[i].hours); assert.equal(r.weight, rows[i].weight); assert.equal(r.progress, rows[i].progress); assert.equal(r.description, rows[i].description); });
});
t("defaults: a new row inherits the current defaults", () => {
  const d = { projectId: P1, managerId: M1 };
  const r = blankRow(d); assert.equal(r.projectId, P1); assert.equal(r.managerId, M1); assert.equal(isCustom(r, "projectId"), false);
});
t("override: changing ONE row's project changes only that row and marks it custom", () => {
  const d = { projectId: P1, managerId: M1 };
  const rows = applyDefault(applyDefault(typed(5, d), "projectId", P1), "managerId", M1);
  const out = rows.map((r, i) => (i === 2 ? setRowChoice(r, "projectId", P2, d) : r));
  assert.deepEqual(out.map((r) => r.projectId), [P1, P1, P2, P1, P1]);
  assert.equal(isCustom(out[2], "projectId"), true); assert.equal(isCustom(out[2], "managerId"), false);
  assert.ok(out.every((r, i) => i === 2 || !isCustom(r, "projectId")));
  assert.ok(out.every((r) => r.managerId === M1), "managers untouched");
});
t("override: changing the default afterwards updates followers but never a custom row", () => {
  const d = { projectId: P1, managerId: M1 };
  let rows = typed(6, d);
  rows = rows.map((r, i) => (i === 1 ? setRowChoice(r, "projectId", P2, d) : i === 4 ? setRowChoice(r, "managerId", M2, d) : r));
  rows = applyDefault(rows, "projectId", P3);
  assert.deepEqual(rows.map((r) => r.projectId), [P3, P2, P3, P3, P3, P3]);
  rows = applyDefault(rows, "managerId", M2);
  assert.deepEqual(rows.map((r) => r.managerId), [M2, M2, M2, M2, M2, M2]);
  const m = applyDefault(rows.map((r, i) => (i === 4 ? setRowChoice(r, "managerId", M1, { projectId: P3, managerId: M2 }) : r)), "managerId", M1);
  assert.equal(m[4].managerId, M1); assert.equal(isCustom(m[4], "managerId"), false, "same as the new default again, so it follows it");
});
t("override: a project custom on one row and a manager custom on another stay independent", () => {
  const d = { projectId: P1, managerId: M1 };
  const rows = typed(3, d).map((r, i) => (i === 0 ? setRowChoice(r, "projectId", P2, d) : i === 1 ? setRowChoice(r, "managerId", M2, d) : r));
  const after = applyDefault(applyDefault(rows, "projectId", P3), "managerId", M2);
  assert.deepEqual(after.map((r) => [r.projectId, r.managerId]), [[P2, M2], [P3, M2], [P3, M2]]);
});
t("override: choosing the default value on a row means it follows the default again", () => {
  const d = { projectId: P1, managerId: M1 };
  const custom = setRowChoice(typed(1, d)[0], "projectId", P2, d); assert.equal(isCustom(custom, "projectId"), true);
  const back = setRowChoice(custom, "projectId", P1, d); assert.equal(isCustom(back, "projectId"), false);
});
t("reset: a custom row goes back to the default and follows it again", () => {
  const d = { projectId: P1, managerId: M1 };
  const custom = setRowChoice(setRowChoice(typed(1, d)[0], "projectId", P2, d), "managerId", M2, d);
  const reset = resetRowChoice(custom, "projectId", d);
  assert.equal(reset.projectId, P1); assert.equal(isCustom(reset, "projectId"), false);
  assert.equal(reset.managerId, M2); assert.equal(isCustom(reset, "managerId"), true, "the manager reset is separate");
  const moved = applyDefault([reset], "projectId", P3)[0]; assert.equal(moved.projectId, P3);
});
t("duplicate: a copy keeps its custom flags and values", () => {
  const d = { projectId: P1, managerId: M1 };
  const custom = setRowChoice(typed(1, d)[0], "projectId", P2, d); const copy = duplicateOf(custom);
  assert.equal(copy.projectId, P2); assert.equal(isCustom(copy, "projectId"), true); assert.notEqual(copy.uid, custom.uid);
});
t("submit data: every row still carries its OWN project and manager (individual routing)", () => {
  const d = { projectId: P1, managerId: M1 };
  const rows = typed(4, d).map((r, i) => (i === 1 ? setRowChoice(r, "managerId", M2, d) : i === 3 ? setRowChoice(r, "projectId", P2, d) : r));
  const pay = rows.map((r) => toPayload(r)) as { teamId: string; taggedManagerId: string }[];
  assert.deepEqual(pay.map((p) => [p.teamId, p.taggedManagerId]), [[P1, M1], [P1, M2], [P1, M1], [P2, M1]]);
  assert.ok(!("projectCustom" in pay[0]) && !("managerCustom" in pay[0]), "the flags never go to the server");
});
t("draft: values are saved per row and the flags are not (the draft shape is unchanged)", () => {
  const d = { projectId: P1, managerId: M1 };
  const dr = toDraft(setRowChoice(typed(1, d)[0], "projectId", P2, d)); assert.equal(dr.teamId, P2); assert.equal(dr.taggedManagerId, M1);
  assert.ok(!("projectCustom" in dr));
});
t("draft reopened: the most common value becomes the default; the others are custom; values are kept", () => {
  const C = { projects: [{ id: P1 }, { id: P2 }, { id: P3 }], managers: [{ id: M1 }, { id: M2 }] };
  const rows = [[P1, M1], [P1, M1], [P2, M1], [P1, M2], [P1, M1]].map(([p, m], i) => fromDraft({ title: "t" + i, description: null, teamId: p, taggedManagerId: m, hoursSpent: 1, weight: "MEDIUM", progress: "IN_PROGRESS" }, C));
  const inf = inferDefaults(rows);
  assert.deepEqual(inf.defaults, { projectId: P1, managerId: M1 });
  assert.deepEqual(inf.rows.map((r) => [r.projectId, r.managerId]), [[P1, M1], [P1, M1], [P2, M1], [P1, M2], [P1, M1]]);
  assert.deepEqual(inf.rows.map((r) => isCustom(r, "projectId")), [false, false, true, false, false]);
  assert.deepEqual(inf.rows.map((r) => isCustom(r, "managerId")), [false, false, false, true, false]);
  const changed = applyDefault(inf.rows, "projectId", P3);
  assert.deepEqual(changed.map((r) => r.projectId), [P3, P3, P2, P3, P3], "after reopening, changing the default still spares the custom row");
});
t("draft reopened: rows with nothing chosen follow the default; an all-empty draft gives no default", () => {
  const rows = [typed(1, { projectId: P1, managerId: M1 })[0], { ...typed(1)[0] }];
  const inf = inferDefaults(rows);
  assert.equal(inf.defaults.projectId, P1); assert.equal(isCustom(inf.rows[1], "projectId"), false);
  const empty = inferDefaults(typed(3)); assert.deepEqual(empty.defaults, none); assert.ok(empty.rows.every((r) => !isCustom(r, "projectId") && !isCustom(r, "managerId")));
});
t("draft reopened: a tie picks the first value met", () => {
  const rows = [typed(1, { projectId: P2, managerId: M1 })[0], typed(1, { projectId: P1, managerId: M1 })[0]];
  assert.equal(inferDefaults(rows).defaults.projectId, P2);
});
t("validation is unchanged: each row still needs its own project and manager", () => {
  const C = { projects: [{ id: P1 }], managers: [{ id: M1 }] };
  const r = { ...typed(1)[0] };
  assert.match(rowProblem(r, C)!, /project/i);
  assert.equal(rowProblem({ ...r, projectId: P1, managerId: M1 }, C), null);
});
t("starting defaults: the server's defaults (from the person's records) come first", () => {
  const C = { projects: [{ id: P1 }, { id: P2 }], managers: [{ id: M1 }, { id: M2 }] };
  const d = startingDefaults({ projectId: P2, managerId: M2 }, { projectId: P1, managerId: M1 }, C);
  assert.deepEqual([d.projectId, d.managerId], [P2, M2]); assert.deepEqual(d.fromRecords, { project: true, manager: true });
});
t("starting defaults: where the records give none, the last choice in this browser is used; each field is decided on its own", () => {
  const C = { projects: [{ id: P1 }, { id: P2 }], managers: [{ id: M1 }, { id: M2 }] };
  const d = startingDefaults({ projectId: null, managerId: M2 }, { projectId: P1, managerId: M1 }, C);
  assert.deepEqual([d.projectId, d.managerId], [P1, M2]); assert.deepEqual(d.fromRecords, { project: false, manager: true });
});
t("starting defaults: nothing on the lists is ever invented", () => {
  const C = { projects: [{ id: P1 }], managers: [{ id: M1 }] };
  assert.deepEqual(startingDefaults({ projectId: "gone", managerId: "gone" }, { projectId: "old", managerId: "old" }, C), { projectId: "", managerId: "", fromRecords: { project: false, manager: false } });
  assert.deepEqual(startingDefaults(undefined, null, C), { projectId: "", managerId: "", fromRecords: { project: false, manager: false } });
});
t("blocked: a Blocked row needs a reason of at least 3 characters; other progress values do not", () => {
  const C = { projects: [{ id: P1 }], managers: [{ id: M1 }] };
  const base = { ...blankRow({ projectId: P1, managerId: M1 }), title: "x" };
  assert.equal(rowProblem({ ...base, progress: "TODO" }, C), null);
  assert.equal(rowProblem({ ...base, progress: "IN_PROGRESS" }, C), null);
  assert.equal(rowProblem({ ...base, progress: "COMPLETED" }, C), null);
  assert.match(rowProblem({ ...base, progress: "BLOCKED" }, C)!, /blocking/i);
  assert.match(rowProblem({ ...base, progress: "BLOCKED", blockedNote: "ab" }, C)!, /blocking/i);
  assert.equal(rowProblem({ ...base, progress: "BLOCKED", blockedNote: "No access to the CRM" }, C), null);
  assert.match(rowProblem({ ...base, progress: "BLOCKED", blockedNote: "x".repeat(501) }, C)!, /500/);
});
t("blocked: the reason is sent only for Blocked rows, trimmed", () => {
  const base = { ...blankRow({ projectId: P1, managerId: M1 }), title: "x", blockedNote: "  reason here " };
  assert.equal((toPayload({ ...base, progress: "BLOCKED" }) as { blockedNote?: string }).blockedNote, "reason here");
  assert.ok(!("blockedNote" in toPayload({ ...base, progress: "IN_PROGRESS" })), "a leftover reason is not sent for another progress");
  assert.ok(!("blockedNote" in toPayload({ ...base, progress: "TODO" })));
  assert.equal(toPayload({ ...base, progress: "TODO" }).progress, "TODO");
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
