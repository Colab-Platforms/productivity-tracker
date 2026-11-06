// Daily task entry rules: progress vs approval, hours, and who may review. No database.
import { mayReview, parseHours, parseProgress, progressOf, storeProgress } from "../src/modules/tasks/tasks.entry.logic.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

console.log("\n## progress (is the work done?) is separate from approval");
ok("the three progress values are accepted", parseProgress("COMPLETED") === "COMPLETED" && parseProgress("IN_PROGRESS") === "IN_PROGRESS" && parseProgress("BLOCKED") === "BLOCKED");
ok("nothing sent = no progress; anything else is refused", parseProgress(undefined) === null && parseProgress("") === null && parseProgress("DONE") === "BAD" && parseProgress("PENDING") === "BAD");
ok("Completed is stored as a finished task, never blocked", storeProgress("COMPLETED").status === "COMPLETED" && storeProgress("COMPLETED").blocked === false);
ok("Blocked is an unfinished task (In Progress) with the blocked flag", storeProgress("BLOCKED").status === "IN_PROGRESS" && storeProgress("BLOCKED").blocked === true);
ok("In Progress is plain In Progress", storeProgress("IN_PROGRESS").status === "IN_PROGRESS" && storeProgress("IN_PROGRESS").blocked === false);
ok("shown progress: finished beats blocked; blocked beats in progress; a legacy not-started task says so", progressOf("COMPLETED", true) === "COMPLETED" && progressOf("IN_PROGRESS", true) === "BLOCKED" && progressOf("IN_PROGRESS", false) === "IN_PROGRESS" && progressOf("PENDING", false) === "NOT_STARTED");

console.log("\n## hours spent");
ok("0 to 24 is fine, kept to two decimals", parseHours(0) === 0 && parseHours(24) === 24 && parseHours("2.5") === 2.5 && parseHours(1.234) === 1.23);
ok("nothing sent = null", parseHours(undefined) === null && parseHours("") === null && parseHours(null) === null);
ok("negative, above 24, text and NaN are refused", parseHours(-1) === "BAD" && parseHours(24.5) === "BAD" && parseHours("abc") === "BAD" && parseHours(NaN) === "BAD" && parseHours(Infinity) === "BAD");

console.log("\n## who may approve or reject");
ok("a task tagged to an active manager: only that manager", mayReview({ actorId: "m1", taggedId: "m1", taggedActive: true, legacyOk: false }));
ok("...not another manager, even one who runs the project", !mayReview({ actorId: "m2", taggedId: "m1", taggedActive: true, legacyOk: true }));
ok("...not HR or an Admin (no 'by role' route in)", !mayReview({ actorId: "hr", taggedId: "m1", taggedActive: true, legacyOk: false }));
ok("tagged to someone who can no longer sign in: the earlier rule applies", mayReview({ actorId: "m2", taggedId: "m1", taggedActive: false, legacyOk: true }) && !mayReview({ actorId: "m2", taggedId: "m1", taggedActive: false, legacyOk: false }));
ok("no tag (older tasks): the earlier rule decides", mayReview({ actorId: "m2", taggedId: null, taggedActive: false, legacyOk: true }) && !mayReview({ actorId: "hr", taggedId: null, taggedActive: false, legacyOk: false }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
