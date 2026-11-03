// Team Tasks "Select Employee" dropdown: the rules (whole team, counts, search, keyboard movement). No database.
import { buildPeople, initialsOf, matchPeople, moveActive, taskWord, withEveryone } from "../../frontend/app/dashboard/approvals/people.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

const members = [
  { id: "u-ravi", name: "Ravi Kumar", employeeCode: "AI-04" },
  { id: "u-sana", name: "Sana Shaikh", employeeCode: "AI-05" },
  { id: "u-ravi2", name: "Ravi Kumar", employeeCode: "AI-09" }, // a different person with the same name
  { id: "u-asha", name: "Asha Iyer", employeeCode: null },
];
const rows = [
  { userId: "u-ravi", who: "Ravi Kumar", employeeCode: "AI-04" },
  { userId: "u-ravi", who: "Ravi Kumar", employeeCode: "AI-04" },
  { userId: "u-ravi", who: "Ravi Kumar", employeeCode: "AI-04" },
  { userId: "u-sana", who: "Sana Shaikh", employeeCode: "AI-05" },
];

console.log("\n## who is in the list");
const people = buildPeople(members, rows, "");
ok("the whole reporting team is listed, including people with no tasks (4 people)", people.length === 4 && people.some((p) => p.id === "u-asha" && p.count === 0));
ok("each person's count is the number of their tasks in view", people.find((p) => p.id === "u-ravi")!.count === 3 && people.find((p) => p.id === "u-sana")!.count === 1 && people.find((p) => p.id === "u-ravi2")!.count === 0);
ok("alphabetical, and two people with the same name are ordered by employee code", people.map((p) => p.id).join(",") === "u-asha,u-ravi,u-ravi2,u-sana");
ok("someone with tasks who is missing from the roster is still listed (a task never vanishes)", buildPeople([], [{ userId: "x", who: "Zed", employeeCode: null }], "").length === 1);
ok("a person already selected stays selectable even if no longer listed", buildPeople([], [], "gone")[0]?.id === "gone");
ok("the counts are from ids, so same-named people are never merged", people.filter((p) => p.name === "Ravi Kumar").length === 2);

console.log("\n## Everyone");
const all = withEveryone(people, rows.length);
ok("Everyone is first and counts every task in view (4)", all[0].id === "" && all[0].name === "Everyone" && all[0].count === 4);
ok("the people counts add up to Everyone's count", people.reduce((n, p) => n + p.count, 0) === all[0].count);

console.log("\n## search");
ok("empty search keeps everything, Everyone included", matchPeople(all, "").length === 5 && matchPeople(all, "   ").length === 5);
ok("matches the name, any case", matchPeople(all, "SANA").map((p) => p.id).join() === "u-sana");
ok("matches part of a name", matchPeople(all, "rav").length === 2);
ok("matches the employee code", matchPeople(all, "ai-09").map((p) => p.id).join() === "u-ravi2");
ok("ignores spaces around the text", matchPeople(all, "  asha ").length === 1);
ok("no match gives an empty list", matchPeople(all, "zzz").length === 0);
ok("while searching, 'Everyone' is not offered as a match for a name", !matchPeople(all, "e").some((p) => p.id === ""));

console.log("\n## keyboard movement");
ok("Down moves one, Up moves back", moveActive(0, "ArrowDown", 5) === 1 && moveActive(3, "ArrowUp", 5) === 2);
ok("it stops at both ends (no wrap, no off-list)", moveActive(4, "ArrowDown", 5) === 4 && moveActive(0, "ArrowUp", 5) === 0);
ok("Home and End jump to the ends", moveActive(2, "Home", 5) === 0 && moveActive(2, "End", 5) === 4);
ok("an empty list stays at 0", moveActive(0, "ArrowDown", 0) === 0);

console.log("\n## words");
ok("1 task / 3 tasks / 0 tasks", taskWord(1) === "1 task" && taskWord(3) === "3 tasks" && taskWord(0) === "0 tasks");
ok("initials", initialsOf("Ravi Kumar") === "RK" && initialsOf("asha") === "A" && initialsOf("  Mary  Ann  Lee ") === "MA");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
