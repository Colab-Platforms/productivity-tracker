// UI wording helpers: the join note names the day when it is not today, and counts never read "1 days" / "1 people". No database.
import { opensPhrase } from "../../frontend/app/dashboard/meetings/when.js";
import { plural, unit } from "../../frontend/lib/plural.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

const IST = "Asia/Kolkata";
// "now" = 2026-11-03 14:00 in India. IST = UTC+5:30
const ist = (y: number, mo: number, d: number, h: number, m: number) => new Date(Date.UTC(y, mo - 1, d, h, m) - 330 * 60_000);
const now = ist(2026, 11, 3, 14, 0);
const at = (d: Date) => d.toISOString();

console.log("\n## the join note says which day");
ok("opens later today: just the time", opensPhrase(at(ist(2026, 11, 3, 15, 45)), IST, now) === "from 3:45 PM");
ok("opens tomorrow: says tomorrow", opensPhrase(at(ist(2026, 11, 4, 10, 45)), IST, now) === "tomorrow from 10:45 AM");
const far = opensPhrase(at(ist(2026, 12, 8, 10, 45)), IST, now);
ok("opens weeks away: names the day (the reported case, 8 December)", far === "on Tue, Dec 8 from 10:45 AM", );
ok("the far case never reads like it opens this morning", far.includes("Dec 8") && far !== "from 10:45 AM");
ok("late evening in India is still 'today' for India even when it is already the next day in UTC", opensPhrase(at(ist(2026, 11, 3, 23, 30)), IST, now) === "from 11:30 PM");
ok("the company's timezone decides the day, not the browser's (same instant, Singapore is a day later)", opensPhrase(at(ist(2026, 11, 3, 23, 30)), "Asia/Singapore", now).startsWith("tomorrow"));

console.log("\n## counts of one");
ok("1 day / 2 days / 0 days", plural(1, "day") === "1 day" && plural(2, "day") === "2 days" && plural(0, "day") === "0 days");
ok("1 person / 5 people", plural(1, "person", "people") === "1 person" && plural(5, "person", "people") === "5 people" && plural(0, "person", "people") === "0 people");
ok("the word alone, for a number styled separately", unit(1, "day") === "day" && unit(8, "day") === "days" && unit(0.5, "day") === "days");
ok("a leave of exactly one day reads '1 day', half a day reads '0.5 days'", unit(1, "day") === "day" && unit(0.5, "day") === "days");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
