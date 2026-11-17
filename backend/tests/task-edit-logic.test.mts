// Editing a submitted task and correction requests: the rules that need no database.
import assert from "node:assert/strict";
import {
  CHANGE_PREFIX, CORRECTION_FIELDS, DIRECT_FIELDS, checkReason, decodeChange, deriveRequests, diffSnapshots, editInfoOf, editRoute, editView, encodeChange,
  parseVersion, pendingRequest, pickChanged, versionOf, type ChangeEventRow, type ChangePayload, type Snapshot,
} from "../src/modules/tasks/tasks.edit.logic.js";

let pass = 0, fail = 0;
const t = (n: string, f: () => void) => { try { f(); pass++; console.log("PASS " + n); } catch (e) { fail++; console.log("FAIL " + n + " -> " + (e as Error).message); } };
const throwsCode = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return (e as Error).message; } };

const snap: Snapshot = { title: "Write report", description: null, projectId: "p1", project: "Alpha", managerId: "m1", manager: "Mgr One", date: "2026-11-17", hoursSpent: 2, priority: "MEDIUM", progress: "IN_PROGRESS", blockedReason: null };
const payload = (type: ChangePayload["type"], extra: Partial<ChangePayload> = {}): ChangePayload => ({ v: 1, type, changed: ["title"], before: { title: "a" }, after: { title: "b" }, approvalBefore: "PENDING", approvalAfter: "PENDING", ...extra });
const ev = (id: string, p: ChangePayload, at: string, actor = "u1"): ChangeEventRow => ({ id, actorId: actor, createdAt: new Date(at), payload: p });

t("which route an edit takes: pending and sent back edit directly; approved and rated need a correction", () => {
  assert.equal(editRoute("PENDING", false), "DIRECT");
  assert.equal(editRoute("REJECTED", false), "DIRECT");
  assert.equal(editRoute("APPROVED", false), "CORRECTION");
  assert.equal(editRoute("APPROVED", true), "CORRECTION");
  assert.equal(editRoute("PENDING", true), "CORRECTION", "a rated task never edits directly, whatever the status says");
});
t("the date and the approving manager are editable directly but never through a correction", () => {
  assert.ok(DIRECT_FIELDS.includes("date") && DIRECT_FIELDS.includes("managerId"));
  assert.ok(!CORRECTION_FIELDS.includes("date" as never) && !CORRECTION_FIELDS.includes("managerId" as never));
  for (const f of ["title", "description", "projectId", "hoursSpent", "priority", "progress", "blockedReason"]) assert.ok(CORRECTION_FIELDS.includes(f as never), f);
});
t("diff lists only what changed, in a stable order, and treats null and blank the same", () => {
  assert.deepEqual(diffSnapshots(snap, { ...snap }), []);
  assert.deepEqual(diffSnapshots(snap, { ...snap, hoursSpent: 3, title: "New" }), ["title", "hoursSpent"]);
  assert.deepEqual(diffSnapshots(snap, { ...snap, description: null }), []);
  assert.deepEqual(diffSnapshots(snap, { ...snap, managerId: "m2" }, CORRECTION_FIELDS), [], "a correction never looks at the manager");
  assert.deepEqual(diffSnapshots(snap, { ...snap, managerId: "m2" }), ["managerId"]);
});
t("pickChanged carries the readable project and manager names with a changed id", () => {
  const next = { ...snap, projectId: "p2", project: "Beta", managerId: "m2", manager: "Mgr Two" };
  assert.deepEqual(pickChanged(next, ["projectId", "managerId"]), { projectId: "p2", project: "Beta", managerId: "m2", manager: "Mgr Two" });
  assert.deepEqual(pickChanged(next, ["hoursSpent"]), { hoursSpent: 2 });
});
t("a history row round-trips, starts with a fixed marker, and a normal note or broken JSON is ignored", () => {
  const p = payload("CORRECTION_REQUESTED", { reason: "typo" });
  const note = encodeChange(p);
  assert.ok(note.startsWith(CHANGE_PREFIX + '{"v":1,"type":"CORRECTION_'), "the database can find these rows by their start");
  assert.deepEqual(decodeChange(note), p);
  assert.equal(decodeChange("Progress: To Do -> Blocked"), null);
  assert.equal(decodeChange(CHANGE_PREFIX + "{not json"), null);
  assert.equal(decodeChange(CHANGE_PREFIX + '{"v":2,"type":"EDIT","changed":[]}'), null);
  assert.equal(decodeChange(null), null);
});
t("a correction request is pending until a decision row names it; the answer is recorded once per request", () => {
  const events = [ev("r1", payload("CORRECTION_REQUESTED"), "2026-11-17T09:00:00Z"), ev("d1", payload("CORRECTION_APPROVED", { requestId: "r1" }), "2026-11-17T10:00:00Z", "mgr"), ev("r2", payload("CORRECTION_REQUESTED"), "2026-11-17T11:00:00Z")];
  const reqs = deriveRequests(events);
  assert.deepEqual(reqs.map((r) => [r.id, r.state]), [["r1", "APPROVED"], ["r2", "PENDING"]]);
  assert.equal(pendingRequest(events)?.id, "r2");
  assert.equal(pendingRequest(events.slice(0, 2)), null);
  const declined = deriveRequests([ev("r1", payload("CORRECTION_REQUESTED"), "2026-11-17T09:00:00Z"), ev("d1", payload("CORRECTION_REJECTED", { requestId: "r1" }), "2026-11-17T10:00:00Z", "mgr")]);
  assert.equal(declined[0].state, "REJECTED");
  assert.equal(deriveRequests([ev("d9", payload("CORRECTION_APPROVED", { requestId: "nope" }), "2026-11-17T10:00:00Z")]).length, 0, "a decision with no request is ignored");
});
t("the Edited label counts real changes only (edits and approved corrections), not requests or declines", () => {
  const events = [
    ev("e1", payload("EDIT"), "2026-11-17T08:00:00Z"),
    ev("r1", payload("CORRECTION_REQUESTED"), "2026-11-17T09:00:00Z"),
    ev("d1", payload("CORRECTION_REJECTED", { requestId: "r1" }), "2026-11-17T10:00:00Z", "mgr"),
    ev("r2", payload("CORRECTION_REQUESTED"), "2026-11-17T11:00:00Z"),
  ];
  const info = editInfoOf(events);
  assert.equal(info.editCount, 1);
  assert.equal(info.editedAt, "2026-11-17T08:00:00.000Z");
  assert.equal(info.pendingCorrection, true);
  assert.deepEqual(editInfoOf([]), { editedAt: null, editCount: 0, pendingCorrection: false });
});
t("a reason or refusal note is 3 to 300 characters once trimmed", () => {
  assert.equal(checkReason("  fix the typo  "), "fix the typo");
  assert.equal(throwsCode(() => checkReason("")), "CORRECTION_REASON_REQUIRED");
  assert.equal(throwsCode(() => checkReason("  ab ")), "CORRECTION_REASON_REQUIRED");
  assert.equal(throwsCode(() => checkReason(undefined)), "CORRECTION_REASON_REQUIRED");
  assert.equal(throwsCode(() => checkReason("x".repeat(301))), "CORRECTION_REASON_TOO_LONG");
  assert.equal(checkReason("x".repeat(300)).length, 300);
});
t("the version token is the later of the task and its entry details, and is read back from a number, a digit string or an ISO date", () => {
  const a = new Date("2026-11-17T10:00:00Z"), b = new Date("2026-11-17T10:05:00Z");
  assert.equal(versionOf(a, b), b.getTime());
  assert.equal(versionOf(b, a), b.getTime());
  assert.equal(versionOf(a, null), a.getTime());
  assert.equal(parseVersion(a.getTime()), a.getTime());
  assert.equal(parseVersion(String(a.getTime())), a.getTime());
  assert.equal(parseVersion(a.toISOString()), a.getTime());
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(parseVersion("not a date"), null);
});
t("the row fields: assigned tasks cannot be edited by their owner; the Edited label appears only after a real change", () => {
  const base = { updatedAt: new Date("2026-11-17T10:00:00Z"), approvalStatus: "PENDING", rating: null, assignedById: null };
  assert.equal(editView(base, undefined, undefined).editRoute, "DIRECT");
  assert.equal(editView({ ...base, approvalStatus: "APPROVED" }, undefined, undefined).editRoute, "CORRECTION");
  assert.equal(editView({ ...base, approvalStatus: "APPROVED", rating: 4 }, undefined, undefined).editRoute, "CORRECTION");
  assert.equal(editView({ ...base, assignedById: "boss" }, undefined, undefined).editRoute, null);
  assert.equal(editView(base, undefined, undefined).edited, null);
  const v = editView(base, undefined, { editedAt: "2026-11-17T11:00:00.000Z", editCount: 2, pendingCorrection: true });
  assert.deepEqual(v.edited, { at: "2026-11-17T11:00:00.000Z", count: 2 });
  assert.equal(v.pendingCorrection, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
