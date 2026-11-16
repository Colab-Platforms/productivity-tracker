// Daily task entry rules: progress vs approval, hours, and who may review. No database.
import { BLOCKED_REASON_MAX, PROGRESS_LABEL, PROGRESS_VALUES, checkBlockedReason, mayReview, parseHours, parseProgress, pickDefaults, progressOf, storeProgress } from "../src/modules/tasks/tasks.entry.logic.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

console.log("\n## progress (is the work done?) is separate from approval");
ok("the four progress values are accepted: To Do, In Progress, Completed, Blocked", parseProgress("TODO") === "TODO" && parseProgress("COMPLETED") === "COMPLETED" && parseProgress("IN_PROGRESS") === "IN_PROGRESS" && parseProgress("BLOCKED") === "BLOCKED" && PROGRESS_VALUES.join() === "TODO,IN_PROGRESS,COMPLETED,BLOCKED");
ok("the labels are To Do / In Progress / Completed / Blocked", PROGRESS_LABEL.TODO === "To Do" && PROGRESS_LABEL.IN_PROGRESS === "In Progress" && PROGRESS_LABEL.COMPLETED === "Completed" && PROGRESS_LABEL.BLOCKED === "Blocked");
ok("the old name NOT_STARTED is not an accepted input (To Do replaces it)", parseProgress("NOT_STARTED") === "BAD");
ok("nothing sent = no progress; anything else is refused", parseProgress(undefined) === null && parseProgress("") === null && parseProgress("DONE") === "BAD" && parseProgress("PENDING") === "BAD");
ok("Completed is stored as a finished task, never blocked", storeProgress("COMPLETED").status === "COMPLETED" && storeProgress("COMPLETED").blocked === false);
ok("Blocked is an unfinished task (In Progress) with the blocked flag", storeProgress("BLOCKED").status === "IN_PROGRESS" && storeProgress("BLOCKED").blocked === true);
ok("In Progress is plain In Progress", storeProgress("IN_PROGRESS").status === "IN_PROGRESS" && storeProgress("IN_PROGRESS").blocked === false);
ok("To Do is stored as the not-started status (PENDING), never blocked: no new status, no migration", storeProgress("TODO").status === "PENDING" && storeProgress("TODO").blocked === false);
ok("shown progress: finished beats blocked; blocked beats in progress; a legacy not-started task says so", progressOf("COMPLETED", true) === "COMPLETED" && progressOf("IN_PROGRESS", true) === "BLOCKED" && progressOf("IN_PROGRESS", false) === "IN_PROGRESS" && progressOf("PENDING", false) === "TODO");
ok("a task already stored as PENDING reads To Do: nothing was converted, the stored value is the same", progressOf("PENDING", false) === "TODO" && storeProgress(progressOf("PENDING", false)).status === "PENDING");
ok("storing then reading gives the same progress for all four", PROGRESS_VALUES.every((p) => { const s = storeProgress(p); return progressOf(s.status, s.blocked) === p; }));

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

// ---- default project and reporting manager ----
const P1 = "p1", P2 = "p2", P3 = "p3", M1 = "m1", M2 = "m2", M3 = "m3";
const base = { reportsToId: null as string | null, linkedManagerIds: [] as string[], memberships: [] as { teamId: string; isPrimary: boolean }[], projectIds: [P1, P2, P3], managerIds: [M1, M2, M3] };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
ok("default project = the primary team", eq(pickDefaults({ ...base, memberships: [{ teamId: P1, isPrimary: false }, { teamId: P2, isPrimary: true }] }).projectId, P2) && pickDefaults({ ...base, memberships: [{ teamId: P2, isPrimary: true }] }).projectSource === "PRIMARY_TEAM");
ok("no primary team but exactly one team = that team", pickDefaults({ ...base, memberships: [{ teamId: P3, isPrimary: false }] }).projectId === P3 && pickDefaults({ ...base, memberships: [{ teamId: P3, isPrimary: false }] }).projectSource === "ONLY_TEAM");
ok("two teams and none primary is ambiguous: nothing is guessed", pickDefaults({ ...base, memberships: [{ teamId: P1, isPrimary: false }, { teamId: P2, isPrimary: false }] }).projectId === null);
ok("two primary teams is ambiguous too", pickDefaults({ ...base, memberships: [{ teamId: P1, isPrimary: true }, { teamId: P2, isPrimary: true }] }).projectId === null);
ok("no team at all = no default project", pickDefaults(base).projectId === null && pickDefaults(base).projectSource === null);
ok("a team the form does not offer (inactive, other deployment) is never the default", pickDefaults({ ...base, memberships: [{ teamId: "gone", isPrimary: true }] }).projectId === null);
ok("a primary team the form does not offer does not hide the one team that is offered", pickDefaults({ ...base, memberships: [{ teamId: "gone", isPrimary: true }, { teamId: P1, isPrimary: false }] }).projectId === P1);
ok("default manager = the reporting manager", pickDefaults({ ...base, reportsToId: M2 }).managerId === M2 && pickDefaults({ ...base, reportsToId: M2 }).managerSource === "REPORTING_MANAGER");
ok("a reporting manager who cannot be tagged (not offered: HR, employee, suspended) is not used", pickDefaults({ ...base, reportsToId: "hr-person" }).managerId === null);
ok("no reporting manager: exactly one additional manager is used", pickDefaults({ ...base, linkedManagerIds: [M3] }).managerId === M3 && pickDefaults({ ...base, linkedManagerIds: [M3] }).managerSource === "ADDITIONAL_MANAGER");
ok("two additional managers and no main one is ambiguous", pickDefaults({ ...base, linkedManagerIds: [M1, M2] }).managerId === null);
ok("the reporting manager wins over additional managers", pickDefaults({ ...base, reportsToId: M1, linkedManagerIds: [M2] }).managerId === M1);
ok("an unusable reporting manager falls back to a single usable additional manager", pickDefaults({ ...base, reportsToId: "suspended", linkedManagerIds: [M2, "also-unusable"] }).managerId === M2);
ok("project and manager are worked out independently", eq(pickDefaults({ ...base, reportsToId: M1 }), { projectId: null, managerId: M1, projectSource: null, managerSource: "REPORTING_MANAGER" }));

// ---- blocked reason ----
const code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return (e as Error).message; } };
ok("a blocked reason is required", code(() => checkBlockedReason(undefined)) === "BLOCKED_REASON_REQUIRED" && code(() => checkBlockedReason("")) === "BLOCKED_REASON_REQUIRED" && code(() => checkBlockedReason("   ")) === "BLOCKED_REASON_REQUIRED" && code(() => checkBlockedReason(12345)) === "BLOCKED_REASON_REQUIRED");
ok("at least 3 characters (after trimming)", code(() => checkBlockedReason("ab")) === "BLOCKED_REASON_REQUIRED" && code(() => checkBlockedReason("  ab ")) === "BLOCKED_REASON_REQUIRED" && checkBlockedReason("abc") === "abc");
ok("at most 500 characters", code(() => checkBlockedReason("x".repeat(BLOCKED_REASON_MAX + 1))) === "BLOCKED_REASON_TOO_LONG" && checkBlockedReason("x".repeat(BLOCKED_REASON_MAX)).length === BLOCKED_REASON_MAX);
ok("the reason is trimmed", checkBlockedReason("  Waiting for access to the CRM  ") === "Waiting for access to the CRM");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
