import { efficiencyIndex, timeCredit, outcomeOf, isAttributableDeletion, type EfficiencyTask } from "../src/modules/tasks/efficiency.logic.js";
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const cutoff = Date.parse("2026-11-24T18:29:59Z"), cutoffDay = "2026-11-24";
const T = (o: Partial<EfficiencyTask> & { id: string }): EfficiencyTask => ({ title: o.id, date: "2026-11-10", status: "COMPLETED", outcome: null, completedAt: Date.parse("2026-11-10T10:00:00Z"), blocked: false, blockedNote: null, rating: 5, qualityReverts: 0, requirementReverts: 0, unclassifiedReverts: 0, partialPercent: null, actualSeconds: 3600, expectedSeconds: 3600, ...o });
const att = { scheduledDays: 20, creditDays: 20 };
const run = (tasks: EfficiencyTask[], deletions: { id: string; title: string; reasonCode: string; reasonNote: string | null }[] = [], attendance: typeof att | null = att) => efficiencyIndex({ tasks, deletions, attendance, cutoff, cutoffDay });
const comp = (e: ReturnType<typeof run>, k: string) => e.components.find((c) => c.key === k)!;
const open = (id: string, o: Partial<EfficiencyTask> = {}) => T({ id, status: "IN_PROGRESS", completedAt: null, rating: null, ...o });

ok(timeCredit(3600, 3600) === 1 && timeCredit(3960, 3600) === 1, "up to 110% is full credit");
ok(timeCredit(7200, 3600) === 0 && timeCredit(9000, 3600) === 0, "200% or more earns nothing");
ok(Math.abs(timeCredit(5400, 3600) - 0.5555555) < 1e-3, "150% in between");
ok(timeCredit(60, 3600) === 1, "no bonus for finishing early");
ok(isAttributableDeletion({ reasonCode: "OTHER", reasonNote: "did not do the work" }) && !isAttributableDeletion({ reasonCode: "OTHER", reasonNote: "" }) && !isAttributableDeletion({ reasonCode: "DUPLICATE", reasonNote: "x yz" }), "only Other with a note is attributable");

const perfect = run(Array.from({ length: 6 }, (_, i) => T({ id: "p" + i })));
ok(perfect.percent === 100 && perfect.status === "FINAL", "perfect = 100 FINAL");
ok(comp(perfect, "partial").state === "NOT_APPLICABLE", "no partial tasks = not applicable");
ok(perfect.components.reduce((n, c) => n + c.weight, 0) === 100, "weights sum to 100");

const lowRated = run(Array.from({ length: 6 }, (_, i) => T({ id: "l" + i, rating: 3 })));
ok(lowRated.percent !== null && lowRated.percent < 90, "ratings of 3 do not give a near-perfect score: " + lowRated.percent);

const unrated = run([...Array.from({ length: 5 }, (_, i) => T({ id: "u" + i, rating: 4 })), T({ id: "u9", rating: null })]);
ok(unrated.status === "PROVISIONAL" && unrated.awaitingRating === 1, "one unrated completed task = provisional");
ok(comp(unrated, "rating").percent === 80, "unrated task is left out, not 5 stars");

const none = run(Array.from({ length: 6 }, (_, i) => T({ id: "n" + i, rating: null })));
ok(none.percent === null && none.status === "INCOMPLETE_EVIDENCE", "no rating at all = blank final");
ok(none.missing.some((m) => m.startsWith("Manager ratings")), "reason is named");

ok(run(Array.from({ length: 6 }, (_, i) => T({ id: "t" + i, expectedSeconds: null }))).percent === null, "no confirmed time = blank");
ok(run(Array.from({ length: 6 }, (_, i) => T({ id: "a" + i, actualSeconds: null }))).percent === null, "not tracked = blank");

const few = run([T({ id: "f1" }), T({ id: "f2" })]);
ok(few.status === "INSUFFICIENT_EVIDENCE" && few.percent === 100, "few tasks: shown but flagged, not penalised");
ok(run([]).status === "NO_TASKS" && run([]).percent === null, "no tasks");

ok(run([T({ id: "x" })], [], null).status === "INCOMPLETE_EVIDENCE", "attendance unreadable = blank");
const five = Array.from({ length: 5 }, (_, i) => T({ id: "z" + i }));
ok(comp(run(five, [], { scheduledDays: 0, creditDays: 0 }), "attendance").state === "NOT_APPLICABLE", "no scheduled days = n/a");
ok(comp(run(five, [], { scheduledDays: 20, creditDays: 15 }), "attendance").percent === 75, "15/20 days = 75%");

const ret = run([...Array.from({ length: 4 }, (_, i) => T({ id: "r" + i })), open("rr", { qualityReverts: 2, date: "2026-11-05" })]);
ok(ret.returned === 1 && ret.notCompleted === 0, "returned is not also not-completed");
ok(comp(ret, "notCompleted").percent === 100, "returned task not overdue-penalised");
ok(comp(ret, "reverted").percent === 80, "4 first-pass of 5 reviewed");
ok(comp(run(Array.from({ length: 5 }, (_, i) => T({ id: "q" + i, requirementReverts: i === 0 ? 1 : 0 }))), "reverted").percent === 100, "requirement change not penalised");
ok(comp(run(Array.from({ length: 5 }, (_, i) => T({ id: "d" + i, qualityReverts: i === 0 ? 1 : 0 }))), "reverted").percent === 80, "fixed after a return is still not first pass");
const legacy = run(Array.from({ length: 5 }, (_, i) => T({ id: "g" + i, unclassifiedReverts: i === 0 ? 1 : 0 })));
ok(legacy.status === "PROVISIONAL" && comp(legacy, "reverted").percent === 100, "unclassified returns flagged, not counted");

const mix = run([...Array.from({ length: 4 }, (_, i) => T({ id: "o" + i })), open("late", { date: "2026-11-12" }), open("today", { date: "2026-11-24" }), open("dep", { date: "2026-11-12", blocked: true, blockedNote: "waiting for client data" })]);
const nc = comp(mix, "notCompleted");
ok(nc.numerator === 1 && nc.denominator === 5, "one overdue of five past-due, got " + nc.numerator + "/" + nc.denominator);

ok(outcomeOf(T({ id: "after", completedAt: cutoff + 86400000 }), cutoff) === "NOT_COMPLETED", "future completion not counted in a historical report");
ok(outcomeOf(T({ id: "pp", outcome: "PARTIALLY_COMPLETED", partialPercent: null }), cutoff) === "NOT_COMPLETED", "unverified partial earns nothing");
const part = run([...Array.from({ length: 4 }, (_, i) => T({ id: "c" + i })), open("pv", { outcome: "PARTIALLY_COMPLETED", partialPercent: 60 })]);
ok(part.partial === 1 && comp(part, "partial").percent === 60 && part.completed === 4, "verified partial = its progress %, not also completed");

const del = run(Array.from({ length: 4 }, (_, i) => T({ id: "e" + i })), [{ id: "d1", title: "d", reasonCode: "OTHER", reasonNote: "never did it" }, { id: "d2", title: "d", reasonCode: "DUPLICATE", reasonNote: null }]);
ok(del.attributableDeletions === 1 && comp(del, "deleted").percent === 80, "one attributable of 5, duplicate ignored");

const sample = run([T({ id: "s1", rating: 4 }), T({ id: "s2", rating: 4 }), T({ id: "s3", rating: 4 }), T({ id: "s4", rating: 4 }), open("s5")]);
const sc = sample.components.filter((c) => c.state === "SCORED");
const sumE = sc.reduce((n, c) => n + (c.earned ?? 0), 0), sumW = sc.reduce((n, c) => n + c.weight, 0);
ok(Math.abs((sample.percent as number) - Math.round((sumE / sumW) * 10000) / 100) < 0.011, "final reproduces from the breakdown");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
