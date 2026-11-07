// Work anniversaries shown on the HR and Admin dashboards: worked out from the date of joining only, nothing guessed. No database.
import { upcomingAnniversaries } from "../../frontend/app/dashboard/_dashboard/anniversaries.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };
const P = (id: string, doj: string | null | undefined, extra: object = {}) => ({ id, name: `P ${id}`, employeeCode: id, designation: null, dateOfJoining: doj, ...extra });
const today = "2026-11-07";

const r = upcomingAnniversaries([P("a", "2023-11-07"), P("b", "2024-11-20"), P("c", "2020-12-07"), P("d", "2026-06-10"), P("e", "2020-12-08")], today);
ok("an anniversary today is included, 0 days away, 3 years", r.find((x) => x.id === "a")?.inDays === 0 && r.find((x) => x.id === "a")?.years === 3);
ok("an anniversary 13 days away is included with 2 years", r.find((x) => x.id === "b")?.inDays === 13 && r.find((x) => x.id === "b")?.years === 2);
ok("exactly 30 days away is included, 31 days away is not", !!r.find((x) => x.id === "c") && !r.find((x) => x.id === "e"));
ok("a person who joined this year has no anniversary within 30 days", !r.find((x) => x.id === "d"));
ok("sorted soonest first", r.map((x) => x.id).join("") === "abc");
ok("a passed anniversary rolls to next year (4 Nov is already past)", upcomingAnniversaries([P("f", "2020-11-04")], today).length === 0 && upcomingAnniversaries([P("f", "2020-11-04")], today, 400)[0]?.date === "2027-11-04");
ok("people with no or a broken joining date are skipped, never guessed", upcomingAnniversaries([P("g", null), P("h", undefined), P("i", "garbage"), P("j", "2020-13-40")], today).length === 0);
ok("suspended and exited people are skipped", upcomingAnniversaries([P("k", "2020-11-10", { status: "EXITED" }), P("l", "2020-11-10", { status: "SUSPENDED" }), P("m", "2020-11-10", { status: "ACTIVE" })], today).map((x) => x.id).join("") === "m");
ok("29 Feb in a non-leap year is skipped, not shown on a wrong day", upcomingAnniversaries([P("n", "2020-02-29")], "2027-02-10").length === 0);
ok("29 Feb in a leap year is shown", upcomingAnniversaries([P("n", "2020-02-29")], "2028-02-10")[0]?.date === "2028-02-29");
ok("year boundary: 5 Jan seen from 20 Dec", upcomingAnniversaries([P("o", "2020-01-05")], "2026-12-20")[0]?.inDays === 16);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
