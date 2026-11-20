// Priority-weighted performance: the pure rules, written from the owner's examples. No database.
import { PRIORITY_WEIGHT, creditFor, percentText, priorityOf, weightedPerformance, weightOf, type WTask } from "../src/modules/tasks/tasks.weighted.ts";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 300) : "")); };
const t = (id: string, weight: string | null, status: string, approvalStatus = "APPROVED", outcome: string | null = null): WTask => ({ id, weight, status, approvalStatus, outcome });
const one = (w: string, status: string, outcome: string | null = null) => weightedPerformance([t("x", w, status, "APPROVED", outcome)]);

console.log("\n## the weights (exactly these, nowhere else)");
ok("Critical 5, High 5, Medium 4, Low 1", PRIORITY_WEIGHT.CRITICAL === 5 && PRIORITY_WEIGHT.HIGH === 5 && PRIORITY_WEIGHT.MEDIUM === 4 && PRIORITY_WEIGHT.LOW === 1);
ok("weightOf reads the stored words, any capitals", weightOf("critical") === 5 && weightOf("High") === 5 && weightOf("MEDIUM") === 4 && weightOf("low") === 1);

console.log("\n## what a task earns (the owner's list)");
ok("Critical completed = 5", one("CRITICAL", "COMPLETED").earned === 5);
ok("High completed = 5", one("HIGH", "COMPLETED").earned === 5);
ok("Medium completed = 4", one("MEDIUM", "COMPLETED").earned === 4);
ok("Low completed = 1", one("LOW", "COMPLETED").earned === 1);
ok("Critical partially completed = 2.5", one("CRITICAL", "COMPLETED", "PARTIALLY_COMPLETED").earned === 2.5);
ok("High partially completed = 2.5", one("HIGH", "IN_PROGRESS", "PARTIALLY_COMPLETED").earned === 2.5);
ok("Medium partially completed = 2", one("MEDIUM", "COMPLETED", "PARTIALLY_COMPLETED").earned === 2);
ok("Low partially completed = 0.5", one("LOW", "COMPLETED", "PARTIALLY_COMPLETED").earned === 0.5);
ok("Not started = 0 points at every priority, but its weight is still possible work", ["CRITICAL", "HIGH", "MEDIUM", "LOW"].every((p) => one(p, "PENDING").earned === 0 && one(p, "PENDING").possible === PRIORITY_WEIGHT[p as keyof typeof PRIORITY_WEIGHT]));

console.log("\n## the owner's worked example: 8.5 of 15 = 56.67%");
const example = weightedPerformance([t("A", "CRITICAL", "COMPLETED"), t("B", "LOW", "COMPLETED"), t("C", "HIGH", "IN_PROGRESS", "APPROVED", "PARTIALLY_COMPLETED"), t("D", "MEDIUM", "PENDING")]);
ok("earned 8.5", example.earned === 8.5, example);
ok("possible 15", example.possible === 15);
ok("weighted performance 56.67%", example.percent === 56.67 && percentText(example) === "56.67%", example.percent);
ok("4 scored tasks: 2 completed, 1 partial, 1 not completed", example.tasks === 4 && example.completed === 2 && example.partial === 1 && example.notCompleted === 1, example);
const byP = Object.fromEntries(example.byPriority.map((l) => [l.priority, l]));
ok("the priority breakdown: Critical 1 task 5/5, High 1 task 2.5/5, Medium 1 task 0/4, Low 1 task 1/1", byP.CRITICAL.tasks === 1 && byP.CRITICAL.earned === 5 && byP.CRITICAL.possible === 5 && byP.HIGH.earned === 2.5 && byP.HIGH.possible === 5 && byP.MEDIUM.earned === 0 && byP.MEDIUM.possible === 4 && byP.LOW.earned === 1 && byP.LOW.possible === 1, byP);
ok("the breakdown is listed Critical, High, Medium, Low and always has all four lines", example.byPriority.map((l) => l.priority).join() === "CRITICAL,HIGH,MEDIUM,LOW");
ok("the breakdown adds up to the totals", example.byPriority.reduce((n, l) => n + l.earned, 0) === example.earned && example.byPriority.reduce((n, l) => n + l.possible, 0) === example.possible && example.byPriority.reduce((n, l) => n + l.tasks, 0) === example.tasks);

console.log("\n## rounding");
ok("1 of 3 points = 33.33%", weightedPerformance([t("1", "LOW", "COMPLETED"), t("2", "LOW", "PENDING"), t("3", "LOW", "PENDING")]).percent === 33.33);
ok("2 of 3 = 66.67%", weightedPerformance([t("1", "LOW", "COMPLETED"), t("2", "LOW", "COMPLETED"), t("3", "LOW", "PENDING")]).percent === 66.67);
ok("everything done = 100%, nothing done = 0%", one("HIGH", "COMPLETED").percent === 100 && one("HIGH", "PENDING").percent === 0);

console.log("\n## what is NOT scored");
const mixed = weightedPerformance([t("1", "HIGH", "COMPLETED", "PENDING"), t("2", "HIGH", "COMPLETED", "REJECTED"), t("3", "CRITICAL", "COMPLETED"), t("4", "HIGH", "CANCELLED")]);
ok("a task waiting for approval is not treated as completed work and is not in the possible points", mixed.tasks === 1 && mixed.earned === 5 && mixed.possible === 5, mixed);
ok("a rejected task earns no points and is not in the possible points", mixed.notScored.rejected === 1);
ok("waiting-for-approval and rejected tasks are counted on their own so they are not 'lost'", mixed.notScored.waitingForApproval === 1 && mixed.notScored.rejected === 1);
ok("a cancelled task is not scored", creditFor(t("c", "HIGH", "CANCELLED")) === 0 && mixed.tasks === 1);
ok("a pending task that is marked completed still earns nothing", creditFor(t("p", "HIGH", "COMPLETED", "PENDING")) === 0);
ok("a rejected task that is marked completed still earns nothing", creditFor(t("r", "HIGH", "COMPLETED", "REJECTED")) === 0);
ok("In Progress earns nothing until a manager marks it partial or it is finished", creditFor(t("i", "HIGH", "IN_PROGRESS")) === 0);
ok("a task graded Failed in the old system earns nothing", creditFor(t("f", "HIGH", "COMPLETED", "APPROVED", "FAILED")) === 0);
ok("a partial mark cannot earn on a task that was never started", creditFor(t("n", "HIGH", "PENDING", "APPROVED", "PARTIALLY_COMPLETED")) === 0);
ok("an outcome of Completed is the same as unmarked", creditFor(t("c2", "HIGH", "COMPLETED", "APPROVED", "COMPLETED")) === 1);
ok("star ratings do not exist in the rules: the score cannot depend on them", !("rating" in ({} as Record<string, unknown>)) && one("MEDIUM", "COMPLETED").earned === 4);

console.log("\n## duplicates, empty lists and missing priorities");
const dup = weightedPerformance([t("same", "HIGH", "COMPLETED"), t("same", "HIGH", "COMPLETED"), t("other", "LOW", "PENDING")]);
ok("the same task id twice is counted once", dup.tasks === 2 && dup.earned === 5 && dup.possible === 6, dup);
ok("records without an id are not merged", weightedPerformance([{ weight: "LOW", status: "COMPLETED", approvalStatus: "APPROVED" }, { weight: "LOW", status: "COMPLETED", approvalStatus: "APPROVED" }]).tasks === 2);
const empty = weightedPerformance([]);
ok("no tasks = N/A, not 0% and not 100%", empty.percent === null && percentText(empty) === "N/A" && empty.possible === 0 && empty.tasks === 0, empty);
ok("only unscorable tasks = N/A too", weightedPerformance([t("a", "HIGH", "COMPLETED", "PENDING"), t("b", "HIGH", "COMPLETED", "REJECTED")]).percent === null);
ok("a missing priority becomes Medium (4), never a high weight", priorityOf(null) === "MEDIUM" && priorityOf(undefined) === "MEDIUM" && priorityOf("") === "MEDIUM" && weightOf(null) === 4);
ok("an unknown priority word becomes Medium too", priorityOf("URGENT") === "MEDIUM" && one("URGENT", "COMPLETED").earned === 4);
ok("a missing priority is scored as Medium inside the sum", weightedPerformance([t("m", null, "COMPLETED")]).earned === 4);

console.log("\n## one weight table");
ok("weights are plain numbers 5, 5, 4, 1 whatever the section", [PRIORITY_WEIGHT.CRITICAL, PRIORITY_WEIGHT.HIGH, PRIORITY_WEIGHT.MEDIUM, PRIORITY_WEIGHT.LOW].join() === "5,5,4,1");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
