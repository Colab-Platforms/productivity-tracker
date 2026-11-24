// Overall Performance Score = Completion % x 60% + Manager rating % x 40%. Pure rules, no database. Covers the ten required scenarios plus the edges.
import { weightedPerformance, isCompletedTask, hasRating, percentText } from "../src/modules/tasks/tasks.weighted.js";
import { pctText, sampleText, scoreText } from "../../frontend/app/dashboard/_weighted/Weighted.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x) : "")); };
let n = 0;
const T = (status: string, rating: number | null, extra: Record<string, unknown> = {}) => ({ id: `t${++n}`, status, approvalStatus: "APPROVED", outcome: null, rating, completedAt: "2026-11-23T10:00:00Z", weight: "MEDIUM", ...extra });
const done = (rating: number | null, extra: Record<string, unknown> = {}) => T("COMPLETED", rating, extra);
const open = (extra: Record<string, unknown> = {}) => T("IN_PROGRESS", null, { completedAt: null, ...extra });
const many = (k: number, f: () => ReturnType<typeof T>) => Array.from({ length: k }, f);

console.log("## the ten required scenarios");
const s1 = weightedPerformance(many(4, () => done(5)));
ok("1. all completed, all rated 5/5 -> 100% (Final)", s1.percent === 100 && s1.status === "FINAL" && s1.completionPercent === 100 && s1.ratingPercent === 100, s1);
const s2 = weightedPerformance(many(5, () => done(3)));
ok("2. all completed, average rating 3/5 -> 100 x 0.6 + 60 x 0.4 = 84%", s2.percent === 84 && s2.completionContribution === 60 && s2.ratingContribution === 24 && s2.averageRating === 3, s2);
const s3 = weightedPerformance([...many(4, () => done(5)), ...many(4, () => open())]);
ok("3. half completed, completed tasks rated 5/5 -> 50 x 0.6 + 100 x 0.4 = 70%", s3.percent === 70 && s3.completionPercent === 50 && s3.ratingPercent === 100, s3);
const s4 = weightedPerformance([]);
ok("4. no eligible tasks -> N/A (not 0% and not 100%)", s4.percent === null && s4.status === "NO_TASKS" && percentText(s4) === "N/A" && s4.tasks === 0, s4);
const s5a = weightedPerformance(many(3, () => done(null)));
ok("5a. completed tasks, none rated -> Awaiting evaluation: no overall score, completion still shown", s5a.percent === null && s5a.status === "AWAITING_EVALUATION" && s5a.completionPercent === 100 && s5a.awaitingRating === 3 && percentText(s5a) === "Awaiting evaluation", s5a);
const s5b = weightedPerformance([done(5), done(4), done(null), done(null)]);
ok("5b. some completed tasks rated, some not -> Provisional, finalized ratings only, 2 outstanding", s5b.status === "PROVISIONAL" && s5b.provisional && s5b.awaitingRating === 2 && s5b.ratedTasks === 2 && s5b.percent === 96 && s5b.ratingPercent === 90, s5b);
ok("5c. an unrated task is NOT treated as 5 stars or as 0 stars (rating % is over rated tasks only)", weightedPerformance([done(3), done(null)]).ratingPercent === 60);
const s6 = weightedPerformance([done(5), { ...done(5), approvalStatus: "PENDING" }, { ...open(), approvalStatus: "PENDING" }]);
ok("6. submitted tasks waiting for approval are not eligible and never counted as completed", s6.tasks === 1 && s6.completed === 1 && s6.notScored.waitingForApproval === 2, s6);
const s7 = weightedPerformance([done(5), { ...done(5), approvalStatus: "REJECTED" }, { ...open(), approvalStatus: "REJECTED" }]);
ok("7. rejected tasks are not eligible and never counted as completed", s7.tasks === 1 && s7.completed === 1 && s7.notScored.rejected === 2, s7);
const mix = (w: string[]) => weightedPerformance(w.map((p, i) => ({ ...(i < 3 ? done(4) : open()), weight: p })));
const a8 = mix(["LOW", "LOW", "LOW", "LOW", "LOW"]), b8 = mix(["CRITICAL", "CRITICAL", "HIGH", "HIGH", "HIGH"]), c8 = mix(["CRITICAL", "LOW", "MEDIUM", "HIGH", "LOW"]);
ok("8. different priorities, identical completion and ratings -> identical score", a8.percent === b8.percent && b8.percent === c8.percent && a8.percent === 3 / 5 * 100 * 0.6 + 80 * 0.4, [a8.percent, b8.percent, c8.percent]);
const s9 = weightedPerformance([done(5)]);
ok("9. one completed task rated 5/5 -> 100%, clearly marked as 1 task", s9.percent === 100 && s9.tasks === 1 && sampleText(s9) === "(1 task)" && scoreText(s9) === "100% (1 task)" && scoreText(weightedPerformance(many(12, () => done(5)))) === "100% (12 tasks)", [s9, scoreText(s9)]);
const cutoff = new Date("2026-11-24T00:00:00Z");
const s10 = weightedPerformance([done(5, { completedAt: "2026-11-23T10:00:00Z" }), done(5, { completedAt: "2026-11-25T10:00:00Z" })], { cutoff });
ok("10. a task completed AFTER the report cutoff is unfinished in that report (1 of 2 = 50%)", s10.completed === 1 && s10.completionPercent === 50 && s10.completedAfterCutoff === 1 && s10.notCompleted === 1, s10);
ok("10b. without a cutoff (a live view) the same task counts", weightedPerformance([done(5, { completedAt: "2026-11-25T10:00:00Z" })]).completed === 1);
ok("10c. a completed task with no completion time (older data) still counts at a cutoff", weightedPerformance([done(5, { completedAt: null })], { cutoff }).completed === 1);

console.log("\n## more rules");
ok("completion and rating weights are 60 / 40 and add up", (() => { const w = weightedPerformance([done(4), open()]); return w.completionContribution === 30 && w.ratingContribution === 32 && w.percent === 62; })());
ok("eligible tasks but nothing completed -> 0% Final (nothing to rate), not N/A", (() => { const w = weightedPerformance(many(3, () => open())); return w.percent === 0 && w.status === "FINAL" && w.completionPercent === 0 && w.ratingPercent === null; })());
ok("a manager-marked partial is not completed (it stays in the denominator)", (() => { const w = weightedPerformance([done(5), done(5, { outcome: "PARTIALLY_COMPLETED" })]); return w.completed === 1 && w.tasks === 2 && w.partial === 1; })());
ok("a task graded FAILED in the old system is not completed", !isCompletedTask(done(5, { outcome: "FAILED" })));
ok("a cancelled task is not eligible at all", weightedPerformance([done(5), T("CANCELLED", null)]).tasks === 1);
ok("To Do, In Progress and Blocked are eligible but not completed", weightedPerformance([T("PENDING", null), T("IN_PROGRESS", null), done(5)]).completed === 1);
ok("only ratings 1..5 count: 0, 6, 3.5 and text are not ratings", [null, undefined, 0, 6, 3.5, "x"].every((r) => !hasRating(r)) && [1, 2, 3, 4, 5].every(hasRating));
ok("a rating on a task that is not completed is ignored", weightedPerformance([open({ rating: 1 }), done(5)]).ratingPercent === 100);
ok("a rating of 1 is 20% and moves the score down", weightedPerformance([done(1)]).percent === 100 * 0.6 + 20 * 0.4);
ok("the same task id arriving twice is counted once", (() => { const d = done(5); return weightedPerformance([d, d]).tasks === 1; })());
ok("never above 100 or below 0", [1, 2, 3, 4, 5].every((r) => { const p = weightedPerformance([done(r), open()]).percent!; return p >= 0 && p <= 100; }));
ok("rounds to two decimals", weightedPerformance([done(4), done(5), done(5)]).percent === 97.33);
ok("the screen wording: 84% / Awaiting evaluation / N/A", pctText(s2) === "84%" && pctText(s5a) === "Awaiting evaluation" && pctText(s4) === "N/A");
ok("a provisional score says so beside the sample size", scoreText(s5b) === "96% (4 tasks) · provisional", scoreText(s5b));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
