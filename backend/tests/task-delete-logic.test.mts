// Delete-task reason rules that need no database.
import assert from "node:assert/strict";
import { DELETE_REASONS, DELETE_REASON_CODES, NOTE_MAX, checkDeletion, reasonLabel } from "../src/modules/tasks/tasks.delete.logic.js";

let pass = 0, fail = 0;
const t = (n: string, f: () => void) => { try { f(); pass++; console.log("PASS " + n); } catch (e) { fail++; console.log("FAIL " + n + " -> " + (e as Error).message); } };
const code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return (e as Error).message; } };

t("the five reasons exist and have readable labels", () => {
  assert.deepEqual(DELETE_REASON_CODES, ["WRONG_EMPLOYEE", "WRONG_PROJECT", "MISTAKE", "DUPLICATE", "OTHER"]);
  assert.equal(reasonLabel("WRONG_PROJECT"), "Submitted under the wrong project");
  assert.equal(reasonLabel("MISTAKE"), DELETE_REASONS.MISTAKE);
  assert.equal(reasonLabel("UNKNOWN_X"), "UNKNOWN_X");
});
t("a reason from the list is always required", () => {
  assert.equal(code(() => checkDeletion({})), "BAD_DELETE_REASON");
  assert.equal(code(() => checkDeletion({ reasonCode: "" })), "BAD_DELETE_REASON");
  assert.equal(code(() => checkDeletion({ reasonCode: "wrong_employee" })), "BAD_DELETE_REASON");
  assert.equal(code(() => checkDeletion({ reasonCode: 5 as never })), "BAD_DELETE_REASON");
  assert.equal(code(() => checkDeletion({ reasonCode: "OTHER2" })), "BAD_DELETE_REASON");
});
t("for the listed reasons the note is optional and trimmed", () => {
  assert.deepEqual(checkDeletion({ reasonCode: "MISTAKE" }), { reasonCode: "MISTAKE", reasonNote: null });
  assert.deepEqual(checkDeletion({ reasonCode: "DUPLICATE", note: "   " }), { reasonCode: "DUPLICATE", reasonNote: null });
  assert.deepEqual(checkDeletion({ reasonCode: "WRONG_PROJECT", note: "  Alpha, not Beta " }), { reasonCode: "WRONG_PROJECT", reasonNote: "Alpha, not Beta" });
});
t("Other needs a written note of at least 3 characters", () => {
  assert.equal(code(() => checkDeletion({ reasonCode: "OTHER" })), "DELETE_NOTE_REQUIRED");
  assert.equal(code(() => checkDeletion({ reasonCode: "OTHER", note: "  ab " })), "DELETE_NOTE_REQUIRED");
  assert.equal(checkDeletion({ reasonCode: "OTHER", note: "abc" }).reasonNote, "abc");
});
t("a note over 300 characters is refused, 300 is fine", () => {
  assert.equal(code(() => checkDeletion({ reasonCode: "MISTAKE", note: "x".repeat(NOTE_MAX + 1) })), "DELETE_NOTE_TOO_LONG");
  assert.equal(checkDeletion({ reasonCode: "MISTAKE", note: "x".repeat(NOTE_MAX) }).reasonNote?.length, NOTE_MAX);
});
t("a non-text note is ignored, not trusted", () => {
  assert.equal(checkDeletion({ reasonCode: "MISTAKE", note: { a: 1 } as never }).reasonNote, null);
  assert.equal(code(() => checkDeletion({ reasonCode: "OTHER", note: 12345 as never })), "DELETE_NOTE_REQUIRED");
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
