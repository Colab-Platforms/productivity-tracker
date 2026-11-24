// Weighted score with the manager's stars (option A): a completed task earns weight x stars / 5; unrated = full credit; partial = 0.5 regardless of stars. No database.
import { weightedPerformance, creditFor, ratingFactor, hasRating, percentText } from "../src/modules/tasks/tasks.weighted.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x) : "")); };
const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 0.006;
let n = 0;
const T = (weight: string, status: string, rating: number | null, extra: object = {}) => ({ id: `t${++n}`, weight, status, approvalStatus: "APPROVED", outcome: null, rating, ...extra });

ok("stars factor: 5 -> 1, 4 -> 0.8, 3 -> 0.6, 2 -> 0.4, 1 -> 0.2", [5, 4, 3, 2, 1].map(ratingFactor).join() === "1,0.8,0.6,0.4,0.2");
ok("no rating, 0, 6, 3.5 or a non-number is NOT a rating and takes nothing away", [null, undefined, 0, 6, 3.5, "x"].every((r) => ratingFactor(r as never) === 1 && !hasRating(r)));

// Komal's real case: five Medium + one High unrated/5 stars, one High at 3 stars
const komal = [T("MEDIUM", "COMPLETED", null), T("MEDIUM", "COMPLETED", null), T("MEDIUM", "COMPLETED", 5), T("MEDIUM", "COMPLETED", null), T("MEDIUM", "COMPLETED", null), T("HIGH", "COMPLETED", 3), T("HIGH", "COMPLETED", null)];
const k = weightedPerformance(komal);
ok("Komal 20-24 Nov: the 3-star High earns 3 of its 5 points, so 28 / 30 = 93.33% (it was 100% before)", near(k.percent, 93.33) && k.earned === 28 && k.possible === 30, k);
ok("the screen can say why: 2 points lost to ratings, 5 completed tasks still awaiting a rating", k.lostToRatings === 2 && k.awaitingRating === 5 && k.rated === 2, k);

// unrated is not 5 stars and not 0: it stays at full credit
const un = weightedPerformance([T("HIGH", "COMPLETED", null)]);
ok("an unrated completed task earns full credit and is reported as awaiting rating", un.percent === 100 && un.awaitingRating === 1 && un.rated === 0);

// 1 star
ok("a 1-star High earns 1 of 5 points (20%)", weightedPerformance([T("HIGH", "COMPLETED", 1)]).percent === 20);
// mixed priorities and stars, hand calculated: High 5*4/5=4, Medium 4*3/5=2.4, Low 1*5/5=1 => 7.4/10
ok("High 4 stars + Medium 3 stars + Low 5 stars = 7.4 / 10 = 74%", near(weightedPerformance([T("HIGH", "COMPLETED", 4), T("MEDIUM", "COMPLETED", 3), T("LOW", "COMPLETED", 5)]).percent, 74));

// not completed earns 0 whatever the stars; possible points are unchanged
ok("an In Progress task rated 5 stars still earns 0 (stars only scale a COMPLETED task)", creditFor(T("MEDIUM", "IN_PROGRESS", 5)) === 0 && creditFor(T("MEDIUM", "PENDING", 5)) === 0 && creditFor(T("MEDIUM", "COMPLETED", 5, { approvalStatus: "PENDING" })) === 0);
const v = weightedPerformance([...Array(17).fill(0).map(() => T("MEDIUM", "COMPLETED", null)), ...Array(3).fill(0).map(() => T("MEDIUM", "IN_PROGRESS", null))]);
ok("Vishwaa's case (17 of 20 Medium completed, nothing rated) is unchanged: 68 / 80 = 85%", v.percent === 85 && v.earned === 68 && v.possible === 80 && v.awaitingRating === 17);

// partial: the manager's mark is the judgement, stars are not applied on top
ok("a manager-marked partial stays at 50% with or without stars (no double penalty)", creditFor(T("MEDIUM", "COMPLETED", null, { outcome: "PARTIALLY_COMPLETED" })) === 0.5 && creditFor(T("MEDIUM", "COMPLETED", 3, { outcome: "PARTIALLY_COMPLETED" })) === 0.5 && creditFor(T("MEDIUM", "COMPLETED", 5, { outcome: "PARTIALLY_COMPLETED" })) === 0.5);
ok("a task graded FAILED in the old system still earns nothing", creditFor(T("MEDIUM", "COMPLETED", 5, { outcome: "FAILED" })) === 0);
// legacy read-through: an old COMPLETED grade reads as 5 stars, which is full credit
ok("an old 'Completed' grade (read as 5 stars) is full credit", creditFor(T("MEDIUM", "COMPLETED", 5, { outcome: "COMPLETED" })) === 1);

// a rating can never push the score outside 0..100, and nothing to score is N/A
ok("never above 100 or below 0", [1, 2, 3, 4, 5, null].every((r) => { const p = weightedPerformance([T("HIGH", "COMPLETED", r as number | null)]).percent!; return p >= 0 && p <= 100; }));
ok("no tasks is N/A, not 0 and not 100", percentText(weightedPerformance([])) === "N/A");
ok("counts of completed / partial / not completed are unchanged by ratings", (() => { const w = weightedPerformance([T("HIGH", "COMPLETED", 1), T("HIGH", "IN_PROGRESS", null), T("HIGH", "COMPLETED", null, { outcome: "PARTIALLY_COMPLETED" })]); return w.completed === 1 && w.partial === 1 && w.notCompleted === 1; })());
// the same task id twice is still counted once
const dup = T("MEDIUM", "COMPLETED", 5);
ok("the same task id arriving twice is still counted once", weightedPerformance([dup, dup]).possible === 4);
// per-priority lines carry the scaled points
const byP = weightedPerformance([T("HIGH", "COMPLETED", 3), T("MEDIUM", "COMPLETED", 5)]).byPriority;
ok("the per-priority breakdown shows the scaled points (High 3 / 5, Medium 4 / 4)", byP.find((x) => x.priority === "HIGH")!.earned === 3 && byP.find((x) => x.priority === "MEDIUM")!.earned === 4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
