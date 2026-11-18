// Repetitive task flags: who sees and does what (pure rules, no database). Run: npx tsx tests/repetition-access.test.mts
import { actionsFor, canEscalateToAdmin, canEscalateToHr, canReview, canSee, commentFor, eventNoteVisible, eventVisible, viewerOf } from "../src/modules/tasks/repetition.access.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c || x === undefined ? "" : "  -> " + JSON.stringify(x))); };

console.log("## the viewer");
ok("the person the flag is about is always an EMPLOYEE viewer, whatever their role", viewerOf("HR", true) === "EMPLOYEE" && viewerOf("ADMIN", true) === "EMPLOYEE" && viewerOf("MANAGER", true) === "EMPLOYEE");
ok("others keep their role; an unknown role is the least privileged", viewerOf("MANAGER", false) === "MANAGER" && viewerOf("HR", false) === "HR" && viewerOf("ADMIN", false) === "ADMIN" && viewerOf("EMPLOYEE", false) === "EMPLOYEE" && viewerOf("AUDITOR", false) === "EMPLOYEE");

console.log("\n## who reads which note");
ok("the employee reads only the level meant for everyone (their explanation)", canSee("EMPLOYEE", "EMPLOYEE") && !canSee("EMPLOYEE", "STAFF") && !canSee("EMPLOYEE", "HR_ADMIN"));
ok("a manager reads employee-level and staff notes but NOT HR/Admin-only notes", canSee("MANAGER", "EMPLOYEE") && canSee("MANAGER", "STAFF") && !canSee("MANAGER", "HR_ADMIN"));
ok("HR and Admin read everything", (["EMPLOYEE", "STAFF", "HR_ADMIN"] as const).every((v) => canSee("HR", v) && canSee("ADMIN", v)));

console.log("\n## what a comment becomes");
ok("manager comment = staff level; HR observation and Admin note = HR/Admin only", commentFor("MANAGER")?.visibility === "STAFF" && commentFor("HR")?.visibility === "HR_ADMIN" && commentFor("ADMIN")?.visibility === "HR_ADMIN");
ok("each role writes its own kind", commentFor("MANAGER")?.kind === "MANAGER_COMMENT" && commentFor("HR")?.kind === "HR_OBSERVATION" && commentFor("ADMIN")?.kind === "ADMIN_NOTE");
ok("the employee cannot comment as a reviewer", commentFor("EMPLOYEE") === null);

console.log("\n## history events as the viewer may read them");
ok("the employee sees detection and status changes only, never comments or escalation", eventVisible("EMPLOYEE", "DETECTED") && eventVisible("EMPLOYEE", "STATUS") && eventVisible("EMPLOYEE", "UPDATED") && !eventVisible("EMPLOYEE", "COMMENT") && !eventVisible("EMPLOYEE", "ESCALATED"));
ok("and a status change reaches them without the reviewer's note", !eventNoteVisible("EMPLOYEE", "STATUS") && eventNoteVisible("EMPLOYEE", "DETECTED"));
ok("staff see every event with its note", (["DETECTED", "UPDATED", "STATUS", "COMMENT", "ESCALATED"] as const).every((k) => eventVisible("MANAGER", k) && eventNoteVisible("HR", k)));

console.log("\n## escalation");
ok("only a manager escalates to HR, only HR escalates to Admin", canEscalateToHr("MANAGER") && !canEscalateToHr("HR") && !canEscalateToHr("ADMIN") && !canEscalateToHr("EMPLOYEE") && canEscalateToAdmin("HR") && !canEscalateToAdmin("MANAGER") && !canEscalateToAdmin("ADMIN") && !canEscalateToAdmin("EMPLOYEE"));
ok("managers, HR and Admin review; the employee does not", canReview("MANAGER") && canReview("HR") && canReview("ADMIN") && !canReview("EMPLOYEE"));

console.log("\n## the buttons each viewer gets");
const open = { status: "NEW", escalatedToHr: false, escalatedToAdmin: false };
ok("manager on an open flag: review, comment, escalate to HR; no escalate to Admin", JSON.stringify(actionsFor("MANAGER", open, true)) === JSON.stringify({ status: true, comment: true, escalateHr: true, escalateAdmin: false, explain: false }));
ok("HR on an open flag: review, comment, escalate to Admin; no escalate to HR", JSON.stringify(actionsFor("HR", open, true)) === JSON.stringify({ status: true, comment: true, escalateHr: false, escalateAdmin: true, explain: false }));
ok("Admin: review and comment only", JSON.stringify(actionsFor("ADMIN", open, true)) === JSON.stringify({ status: true, comment: true, escalateHr: false, escalateAdmin: false, explain: false }));
ok("employee: explain only", JSON.stringify(actionsFor("EMPLOYEE", open, true)) === JSON.stringify({ status: false, comment: false, escalateHr: false, escalateAdmin: false, explain: true }));
ok("before the migration (no notes table): no explanation and no escalation to Admin", !actionsFor("EMPLOYEE", open, false).explain && !actionsFor("HR", open, false).escalateAdmin);
ok("an escalated flag cannot be escalated again", !actionsFor("MANAGER", { ...open, escalatedToHr: true }, true).escalateHr && !actionsFor("HR", { ...open, escalatedToAdmin: true }, true).escalateAdmin);
ok("a closed flag (false positive, resolved) offers no escalation and no explanation", ["FALSE_POSITIVE", "RESOLVED"].every((s) => { const a1 = actionsFor("MANAGER", { ...open, status: s }, true), a2 = actionsFor("HR", { ...open, status: s }, true), a3 = actionsFor("EMPLOYEE", { ...open, status: s }, true); return !a1.escalateHr && !a2.escalateAdmin && !a3.explain; }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
