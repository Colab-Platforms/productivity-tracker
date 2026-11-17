// Repetitive task detection: the pure rules, no database. Run: npx tsx tests/repetition-logic.test.mts
import { DEFAULT_SETTINGS, canMove, checkSettings, compare, coveredBy, detect, isOpen, titleSimilarity, words, type TaskLite } from "../src/modules/tasks/repetition.logic.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c || x === undefined ? "" : "  -> " + JSON.stringify(x))); };
const S = DEFAULT_SETTINGS;
let n = 0;
const T = (title: string, date: string, o: Partial<TaskLite> = {}): TaskLite => ({ id: "t" + ++n, userId: "u1", teamId: "p1", date, title, description: null, status: "IN_PROGRESS", approvalStatus: "APPROVED", ...o });

console.log("## cleaning");
ok("filler and progress words are dropped, endings trimmed", words("Continued work on the HRMS dashboards").join(" ") === "hrm dashboard", words("Continued work on the HRMS dashboards"));
ok("build / develop / implement are the same word", words("developing")[0] === words("implementation")[0] && words("coding")[0] === "build");
ok("fix / debug are the same word", words("fixing")[0] === words("debugging")[0]);

console.log("\n## the owner's example");
const ex = ["Working on HRMS dashboard", "HRMS dashboard development", "Continued work on HRMS dashboard"];
ok("the three wordings read as the same work", compare({ title: ex[0], description: null }, { title: ex[1], description: null }, 60).sameWork && compare({ title: ex[0], description: null }, { title: ex[2], description: null }, 60).sameWork && compare({ title: ex[1], description: null }, { title: ex[2], description: null }, 60).sameWork, ex.map((a, i) => ex.map((b) => titleSimilarity(a, b))));
ok("exact duplicates score 100", titleSimilarity("Prepare monthly deck", "Prepare monthly deck") === 100);
ok("a different task does not match", titleSimilarity("Working on HRMS dashboard", "Prepare vendor invoices") < 30);

console.log("\n## detection");
let c = detect([T(ex[0], "2026-11-10"), T(ex[1], "2026-11-11"), T(ex[2], "2026-11-12")], S);
ok("3 similar tasks in 3 days: one candidate with count 3", c.length === 1 && c[0].count === 3 && c[0].spanDays === 3, c);
ok("the reason is in words and names the numbers", /3 entries/.test(c[0]?.reason ?? "") && /none of them was completed/.test(c[0]?.reason ?? ""), c[0]?.reason);
ok("exact duplicates across 3 dates are flagged", detect([T("Update client report", "2026-11-10"), T("Update client report", "2026-11-11"), T("Update client report", "2026-11-13")], S).length === 1);
ok("two similar tasks are below the threshold", detect([T(ex[0], "2026-11-10"), T(ex[1], "2026-11-11")], S).length === 0);
ok("3 similar tasks spread over 12 days are outside the 7-day window", detect([T(ex[0], "2026-11-01"), T(ex[1], "2026-11-07"), T(ex[2], "2026-11-13")], S).length === 0);
ok("exactly 7 days apart counts as inside the window (day 1 to day 7)", detect([T(ex[0], "2026-11-01"), T(ex[1], "2026-11-04"), T(ex[2], "2026-11-07")], S).length === 1);
ok("8 days apart does not", detect([T(ex[0], "2026-11-01"), T(ex[1], "2026-11-04"), T(ex[2], "2026-11-08")], S).length === 0);
ok("three genuinely different tasks that share one word are NOT flagged", detect([T("Fix login bug on HRMS", "2026-11-10"), T("Design HRMS reports page", "2026-11-11"), T("Write HRMS onboarding docs", "2026-11-12")], S).length === 0);
ok("same heading but clearly different details are different activities", detect([
  T("HRMS dashboard", "2026-11-10", { description: "Add attendance chart with weekly bars and tooltips for managers" }),
  T("HRMS dashboard", "2026-11-11", { description: "Repair payroll export spreadsheet columns and totals formatting" }),
  T("HRMS dashboard", "2026-11-12", { description: "Prepare database backup restore documentation and runbook steps" }),
], S).length === 0);
ok("same heading and same details ARE flagged", detect([
  T("HRMS dashboard", "2026-11-10", { description: "Working on attendance chart weekly bars tooltips managers" }),
  T("HRMS dashboard", "2026-11-11", { description: "Continued attendance chart weekly bars tooltips managers" }),
  T("HRMS dashboard", "2026-11-12", { description: "Attendance chart with weekly bars and tooltips for managers" }),
], S).length === 1);

console.log("\n## context: legitimate recurring work");
ok("a routine that is really finished each time is not flagged", detect([T("Daily sales report", "2026-11-10", { status: "COMPLETED" }), T("Daily sales report", "2026-11-11", { status: "COMPLETED" }), T("Daily sales report", "2026-11-12", { status: "IN_PROGRESS" })], S).length === 0);
ok("one completed out of three is still suspicious", detect([T("Daily sales report", "2026-11-10", { status: "COMPLETED" }), T("Daily sales report", "2026-11-11"), T("Daily sales report", "2026-11-12")], S).length === 1);
ok("rejected tasks are ignored", detect([T(ex[0], "2026-11-10"), T(ex[1], "2026-11-11", { approvalStatus: "REJECTED" }), T(ex[2], "2026-11-12")], S).length === 0);
ok("cancelled tasks are ignored", detect([T(ex[0], "2026-11-10"), T(ex[1], "2026-11-11", { status: "CANCELLED" }), T(ex[2], "2026-11-12")], S).length === 0);

console.log("\n## who and where");
ok("different people are never combined", detect([T(ex[0], "2026-11-10", { userId: "a" }), T(ex[1], "2026-11-11", { userId: "b" }), T(ex[2], "2026-11-12", { userId: "c" })], S).length === 0);
ok("different projects are never combined", detect([T(ex[0], "2026-11-10", { teamId: "p1" }), T(ex[1], "2026-11-11", { teamId: "p2" }), T(ex[2], "2026-11-12", { teamId: "p3" })], S).length === 0);
ok("each person is judged on their own", detect([T(ex[0], "2026-11-10", { userId: "a" }), T(ex[1], "2026-11-11", { userId: "a" }), T(ex[2], "2026-11-12", { userId: "a" }), T("Prepare vendor invoices", "2026-11-11", { userId: "b" })], S).map((x) => x.userId).join() === "a");
ok("a busy week with 4 similar tasks reports 4", detect([T(ex[0], "2026-11-10"), T(ex[1], "2026-11-11"), T(ex[2], "2026-11-12"), T("HRMS dashboard work", "2026-11-13")], S)[0]?.count === 4);

console.log("\n## configurable threshold");
const two = { ...S, minCount: 2 };
ok("a lower threshold flags two", detect([T(ex[0], "2026-11-10"), T(ex[1], "2026-11-11")], two).length === 1);
const strict = { ...S, similarityPct: 95 };
ok("a stricter similarity needs near-identical wording", detect([T(ex[0], "2026-11-10"), T(ex[1], "2026-11-11"), T(ex[2], "2026-11-12")], strict).length === 0 && detect([T("Prepare monthly deck", "2026-11-10"), T("Prepare monthly deck", "2026-11-11"), T("Prepare monthly deck", "2026-11-12")], strict).length === 1);
ok("a shorter window changes the result", detect([T(ex[0], "2026-11-10"), T(ex[1], "2026-11-12"), T(ex[2], "2026-11-14")], { ...S, windowDays: 3 }).length === 0);
ok("settings are validated", (() => { try { checkSettings({ minCount: 1, windowDays: 7, similarityPct: 60 }); return false; } catch (e) { return (e as Error).message === "BAD_MIN_COUNT"; } })() && checkSettings({ minCount: 4, windowDays: 10, similarityPct: 70 }).minCount === 4);

console.log("\n## no duplicate flags for the same pattern");
const cand = detect([T(ex[0], "2026-11-10"), T(ex[1], "2026-11-11"), T(ex[2], "2026-11-12")], S)[0];
const same = { id: "f1", status: "NEW", taskIds: cand.taskIds, lastDate: cand.lastDate };
ok("a pattern already flagged (any open or reviewed status) is covered", ["NEW", "UNDER_REVIEW", "VALID", "FALSE_POSITIVE"].every((s) => coveredBy(cand, [{ ...same, status: s }])?.id === "f1"));
ok("a flag with mostly the same tasks covers a pattern that grew by one", coveredBy({ taskIds: [...cand.taskIds, "newone"], lastDate: "2026-11-13" }, [same])?.id === "f1");
ok("an unrelated flag does not cover it", coveredBy(cand, [{ id: "f2", status: "NEW", taskIds: ["x", "y"], lastDate: "2026-11-01" }]) === null);
ok("a resolved flag covers the same entries but not a pattern with a new one", coveredBy(cand, [{ ...same, status: "RESOLVED" }])?.id === "f1" && coveredBy({ taskIds: [...cand.taskIds, "newone"], lastDate: "2026-11-14" }, [{ ...same, status: "RESOLVED" }]) === null);

console.log("\n## flag life cycle");
ok("New can go to Under Review, Valid, False Positive or Resolved", (["UNDER_REVIEW", "VALID", "FALSE_POSITIVE", "RESOLVED"] as const).every((s) => canMove("NEW", s)));
ok("a flag cannot go back to New", !(["UNDER_REVIEW", "VALID", "FALSE_POSITIVE", "RESOLVED"] as const).some((s) => canMove(s, "NEW")));
ok("a dismissed or resolved flag can be reopened for review", canMove("FALSE_POSITIVE", "UNDER_REVIEW") && canMove("RESOLVED", "UNDER_REVIEW"));
ok("only New and Under Review count as open", isOpen("NEW") && isOpen("UNDER_REVIEW") && !isOpen("VALID") && !isOpen("FALSE_POSITIVE") && !isOpen("RESOLVED"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
