// Arrival rule 9:45 / 10:00 and the 3-late-working-days-in-a-row rule (pure).
import { ARRIVAL_RULES, classifyArrival, lateStreakHalfDays } from "../src/modules/team-attendance/arrival.logic.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(x))); };
const at = (hhmm: string) => new Date(Date.UTC(2026, 10, 9, ...(hhmm.split(":").map(Number) as [number, number])) - 330 * 60000); // IST wall clock
const c = (t: string) => classifyArrival(at(t), "Asia/Kolkata");
ok("limits are 09:45 and 10:00", ARRIVAL_RULES.presentUntil === "09:45" && ARRIVAL_RULES.lateUntil === "10:00");
ok("9:30 and 9:45 are on time", c("09:30") === "PRESENT" && c("09:45") === "PRESENT");
ok("9:46 and 10:00 are late", c("09:46") === "LATE" && c("10:00") === "LATE");
ok("10:01 is a half day (was 10:15)", c("10:01") === "HALF_DAY" && c("10:15") === "HALF_DAY");
const S = (...codes: (string | null)[]) => codes.map((code, i) => ({ date: `2026-11-${String(i + 2).padStart(2, "0")}`, code }));
const d = (n: number) => `2026-11-${String(n + 1).padStart(2, "0")}`;
ok("late, late, late: only the 3rd becomes a half day", [...lateStreakHalfDays(S("LATE", "LATE", "LATE"))].join() === d(3));
ok("two lates are only lates", lateStreakHalfDays(S("LATE", "LATE", "PRESENT")).size === 0);
ok("an on-time day breaks the run", lateStreakHalfDays(S("LATE", "LATE", "PRESENT", "LATE")).size === 0);
ok("a half-day arrival breaks the run", lateStreakHalfDays(S("LATE", "LATE", "HALF_DAY", "LATE")).size === 0);
ok("an absence breaks the run", lateStreakHalfDays(S("LATE", "LATE", "ABSENT", "LATE")).size === 0);
ok("Sundays/holidays/leave are skipped, not breaking", [...lateStreakHalfDays(S("LATE", "WEEK_OFF", "LATE", "HOLIDAY", "LEAVE", "LATE"))].join() === d(6));
ok("the count restarts after the half day: 6 lates in a row give the 3rd and the 6th", [...lateStreakHalfDays(S("LATE", "LATE", "LATE", "LATE", "LATE", "LATE"))].join() === [d(3), d(6)].join());
ok("4th and 5th late after a half day are lates again", !lateStreakHalfDays(S("LATE", "LATE", "LATE", "LATE", "LATE")).has(d(4)) && !lateStreakHalfDays(S("LATE", "LATE", "LATE", "LATE", "LATE")).has(d(5)));
ok("today not yet in (NOT_CLOCKED_IN) neither counts nor breaks", [...lateStreakHalfDays(S("LATE", "LATE", "NOT_CLOCKED_IN", "LATE"))].join() === d(4));
ok("input order does not matter", [...lateStreakHalfDays([...S("LATE", "LATE", "LATE")].reverse())].join() === d(3));
ok("no data = nothing", lateStreakHalfDays([]).size === 0 && lateStreakHalfDays(S(null, null, null)).size === 0);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
