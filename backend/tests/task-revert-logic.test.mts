// Task revert / reopen: the pure rules. No database.
import { checkRemark, decodeRevertNote, encodeRevertNote, reopenedView, revertBlock, REVERT_MARK_PREFIX } from "../src/modules/tasks/tasks.revert.logic.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

console.log("\n## remark");
ok("a normal remark is accepted and trimmed", JSON.stringify(checkRemark("  Section 3 is missing  ")) === JSON.stringify({ text: "Section 3 is missing" }));
ok("missing / empty / spaces / 2 characters are required-errors", ["", "   ", "ab", undefined, null, 5].every((v) => (checkRemark(v) as { error?: string }).error === "REMARK_REQUIRED"));
ok("exactly 3 and exactly 300 characters are accepted", "text" in checkRemark("abc") && "text" in checkRemark("x".repeat(300)));
ok("301 characters is too long", (checkRemark("x".repeat(301)) as { error?: string }).error === "REMARK_TOO_LONG");

console.log("\n## the marker on the task");
const a = encodeRevertNote("PARTIAL", "  rest is open ");
ok("partial is stored with its marker and a trimmed remark", a === "[Reopened: partial] rest is open" && a.startsWith(REVERT_MARK_PREFIX));
const b = encodeRevertNote("NOT_FULL", "marked by mistake");
ok("not fully completed has its own marker", b === "[Reopened: not full] marked by mistake" && b.startsWith(REVERT_MARK_PREFIX));
ok("both decode back to kind, label and remark", decodeRevertNote(a)?.label === "Partially completed" && decodeRevertNote(a)?.remark === "rest is open" && decodeRevertNote(b)?.label === "Not fully completed");
ok("an ordinary grade note is never mistaken for a revert", decodeRevertNote("Looks good") === null && decodeRevertNote(null) === null && decodeRevertNote("") === null);
ok("a remark that itself looks like a marker cannot fake a different kind", decodeRevertNote(encodeRevertNote("PARTIAL", "[Reopened: not full] x"))?.type === "PARTIAL");

console.log("\n## when a task may be reverted");
const base = { approvalStatus: "APPROVED", status: "COMPLETED", reviewNote: null as string | null, selfManaged: false };
ok("an approved, completed task can be reverted", revertBlock(base) === null);
ok("graded or not makes no difference (reviewNote is a grade note)", revertBlock({ ...base, reviewNote: "Looks good" }) === null);
ok("a manager's own self-managed task is excluded", revertBlock({ ...base, selfManaged: true }) === "SELF_MANAGED");
ok("a task never approved cannot be reverted", revertBlock({ ...base, approvalStatus: "PENDING" }) === "NOT_APPROVED");
ok("a task still in progress (never finished) is 'not finished'", revertBlock({ ...base, status: "IN_PROGRESS" }) === "NOT_FINISHED_YET");
ok("a task already reopened cannot be reverted again", revertBlock({ ...base, status: "IN_PROGRESS", reviewNote: a }) === "ALREADY_REOPENED");
ok("once the employee finishes it again it can be reverted again (a new cycle, not a duplicate)", revertBlock({ ...base, status: "COMPLETED", reviewNote: a }) === null);

console.log("\n## what the screens show");
ok("reopened and unfinished: kind and remark, not resubmitted", JSON.stringify(reopenedView({ status: "IN_PROGRESS", outcome: null, reviewNote: a })) === JSON.stringify({ type: "PARTIAL", label: "Partially completed", remark: "rest is open", resubmitted: false }));
ok("finished again and waiting: flagged resubmitted", reopenedView({ status: "COMPLETED", outcome: null, reviewNote: b })?.resubmitted === true);
ok("a fresh grade replaces the reopened view", reopenedView({ status: "COMPLETED", outcome: "COMPLETED", reviewNote: b }) === null);
ok("an ordinary task has no reopened view", reopenedView({ status: "IN_PROGRESS", outcome: null, reviewNote: null }) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
