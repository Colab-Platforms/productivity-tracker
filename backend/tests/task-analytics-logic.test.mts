// Tasks & Performance: the counting rules (no database, no browser). Run: npx tsx tests/task-analytics-logic.test.mts
import { ageDays, byDay, byEmployee, byProject, countRows, isOverdue, narrow, overdueList, progressOf, type Row } from "../../frontend/app/dashboard/approvals/analytics.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c || x === undefined ? "" : "  -> " + JSON.stringify(x))); };
const TODAY = "2026-11-17";
let n = 0;
const R = (o: Partial<Row> & { userId?: string }): Row => ({ id: "t" + ++n, userId: "u1", who: "Asha", employeeCode: "E-1", project: "Alpha", approvalStatus: "APPROVED", status: "IN_PROGRESS", progress: "IN_PROGRESS", rating: null, date: TODAY, ...o });

console.log("## counts");
const rows: Row[] = [
  R({ approvalStatus: "PENDING", status: "PENDING", progress: "TODO" }),
  R({ progress: "TODO", status: "PENDING" }),
  R({ progress: "IN_PROGRESS" }),
  R({ progress: "COMPLETED", status: "COMPLETED", rating: 4 }),
  R({ progress: "COMPLETED", status: "COMPLETED", rating: 5 }),
  R({ progress: "COMPLETED", status: "COMPLETED", rating: null }),
  R({ progress: "BLOCKED" }),
  R({ approvalStatus: "REJECTED", progress: "IN_PROGRESS" }),
  R({ status: "CANCELLED", approvalStatus: "PENDING" }),
];
const c = countRows(rows, TODAY, 3);
ok("a withdrawn (cancelled) task is not a submission", c.submitted === 8, c);
ok("approved / pending / rejected add up to submitted", c.approved + c.pending + c.rejected === c.submitted && c.approved === 6 && c.pending === 1 && c.rejected === 1, c);
ok("progress counts leave out the rejected task and add up to the rest", c.todo + c.inProgress + c.completed + c.blocked === c.submitted - c.rejected && c.todo === 2 && c.inProgress === 1 && c.completed === 3 && c.blocked === 1, c);
ok("the average rating uses RATED tasks only (4 and 5 = 4.5, the unrated one is not a zero)", c.rated === 2 && c.avgRating === 4.5, c);
ok("open = not rejected and not completed", c.open === 4, c);
ok("nobody rated = no average, never 0", countRows([R({ progress: "COMPLETED", status: "COMPLETED" })], TODAY, 3).avgRating === null);
ok("progress reads old data safely (NOT_STARTED = To Do, status fallback)", progressOf(R({ progress: "NOT_STARTED" })) === "TODO" && progressOf(R({ progress: null, status: "COMPLETED" })) === "COMPLETED" && progressOf(R({ progress: null, status: "PENDING" })) === "TODO");

console.log("\n## overdue (old unfinished submitted tasks)");
ok("age is counted in calendar days", ageDays("2026-11-10", TODAY) === 7 && ageDays(TODAY, TODAY) === 0);
ok("open and older than N days is overdue; exactly N days is not", isOverdue(R({ date: "2026-11-13" }), TODAY, 3) && !isOverdue(R({ date: "2026-11-14" }), TODAY, 3) && !isOverdue(R({ date: "2026-11-15" }), TODAY, 3));
ok("a completed, rejected or cancelled task is never overdue", !isOverdue(R({ date: "2026-10-01", progress: "COMPLETED", status: "COMPLETED" }), TODAY, 3) && !isOverdue(R({ date: "2026-10-01", approvalStatus: "REJECTED" }), TODAY, 3) && !isOverdue(R({ date: "2026-10-01", status: "CANCELLED" }), TODAY, 3));
ok("a bigger N flags fewer tasks", countRows([R({ date: "2026-11-05" }), R({ date: "2026-11-12" })], TODAY, 3).overdue === 2 && countRows([R({ date: "2026-11-05" }), R({ date: "2026-11-12" })], TODAY, 7).overdue === 1);
ok("the overdue list is oldest first", overdueList([R({ date: "2026-11-12" }), R({ date: "2026-11-01" })], TODAY, 3).map((r) => r.age).join() === "16,5");

console.log("\n## grouping");
const mixed: Row[] = [
  R({ userId: "a", who: "Asha", project: "Alpha", progress: "COMPLETED", status: "COMPLETED", rating: 5 }),
  R({ userId: "a", who: "Asha", project: "Beta" }),
  R({ userId: "b", who: "Ben", employeeCode: "E-2", project: null }),
  R({ userId: "b", who: "Ben", employeeCode: "E-2", project: "Alpha", progress: "BLOCKED" }),
  R({ userId: "b", who: "Ben", employeeCode: "E-2", project: "Alpha", approvalStatus: "REJECTED" }),
];
const emp = byEmployee(mixed, TODAY, 3);
ok("one group per employee, most submissions first", emp.length === 2 && emp[0].label === "Ben" && emp[0].counts.submitted === 3 && emp[1].counts.submitted === 2, emp.map((g) => [g.label, g.counts.submitted]));
ok("two people with the same name stay two groups (grouped by id)", byEmployee([R({ userId: "x", who: "Sam" }), R({ userId: "y", who: "Sam" })], TODAY, 3).length === 2);
ok("employee averages are per person and rated-only", emp.find((g) => g.label === "Asha")!.counts.avgRating === 5 && emp.find((g) => g.label === "Ben")!.counts.avgRating === null);
const proj = byProject(mixed, TODAY, 3);
ok("project groups, with 'No project' for tasks without one", proj.map((g) => g.label).sort().join() === "Alpha,Beta,No project", proj.map((g) => g.label));
ok("the totals of the groups equal the overall totals (no task counted twice)", emp.reduce((s, g) => s + g.counts.submitted, 0) === countRows(mixed, TODAY, 3).submitted && proj.reduce((s, g) => s + g.counts.submitted, 0) === countRows(mixed, TODAY, 3).submitted);
ok("completion history per day: submitted and completed, oldest first, rejected left out", JSON.stringify(byDay([R({ date: "2026-11-16", progress: "COMPLETED", status: "COMPLETED" }), R({ date: "2026-11-16" }), R({ date: "2026-11-15" }), R({ date: "2026-11-15", approvalStatus: "REJECTED" })])) === JSON.stringify([{ day: "2026-11-15", submitted: 1, completed: 0 }, { day: "2026-11-16", submitted: 2, completed: 1 }]));

console.log("\n## filters");
ok("narrow by employee id", narrow(mixed, "a", "").length === 2 && narrow(mixed, "b", "").length === 3);
ok("narrow by project (and 'No project')", narrow(mixed, "", "Alpha").length === 3 && narrow(mixed, "", "No project").length === 1);
ok("both filters together only narrow further", narrow(mixed, "b", "Alpha").length === 2);
ok("empty filters change nothing", narrow(mixed, "", "").length === mixed.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
