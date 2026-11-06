// Attendance calendar: classification by first check-in. No database.
import { calendarStatus, classifyArrival, localMinuteOfDay, minutesAfterLimit } from "../src/modules/team-attendance/arrival.logic.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

const IST = "Asia/Kolkata";
// 2026-11-02 at the given IST wall-clock time (IST = UTC+5:30)
const ist = (hhmm: string, sec = 0) => { const [h, m] = hhmm.split(":").map(Number); return new Date(Date.UTC(2026, 10, 2, h, m, sec) - 330 * 60_000); };

console.log("\n## the rule, at every boundary");
ok("9:40 = Present", classifyArrival(ist("09:40"), IST) === "PRESENT");
ok("9:45 = Present (at or before)", classifyArrival(ist("09:45"), IST) === "PRESENT");
ok("9:46 = Late", classifyArrival(ist("09:46"), IST) === "LATE");
ok("9:50 = Late", classifyArrival(ist("09:50"), IST) === "LATE");
ok("10:15 = Late (at or before)", classifyArrival(ist("10:15"), IST) === "LATE");
ok("10:16 = Half Day", classifyArrival(ist("10:16"), IST) === "HALF_DAY");
ok("early morning 6:00 = Present", classifyArrival(ist("06:00"), IST) === "PRESENT");
ok("1:00 PM = Half Day", classifyArrival(ist("13:00"), IST) === "HALF_DAY");
ok("seconds do not move the minute: 9:45:59 = Present, same precision as the existing late rule", classifyArrival(ist("09:45", 59), IST) === "PRESENT");
ok("10:15:59 = Late", classifyArrival(ist("10:15", 59), IST) === "LATE");

console.log("\n## the company's timezone decides, not the server's");
const at = ist("09:40"); // 9:40 in India = 04:10 UTC
ok("the same instant is Present in India", classifyArrival(at, IST) === "PRESENT");
ok("also Present when read on UTC (it reads 04:10 there)", classifyArrival(at, "UTC") === "PRESENT");
ok("an instant that reads 10:20 in Singapore (UTC+8) is Half Day there", classifyArrival(new Date(Date.UTC(2026, 10, 2, 2, 20)), "Asia/Singapore") === "HALF_DAY");
ok("the same instant reads 07:50 in India, so it is Present there", classifyArrival(new Date(Date.UTC(2026, 10, 2, 2, 20)), IST) === "PRESENT");
ok("minute of day is read in the given zone", localMinuteOfDay(ist("09:46"), IST) === 9 * 60 + 46);

console.log("\n## late indicator");
ok("on time = 0 minutes", minutesAfterLimit(ist("09:30"), IST) === 0 && minutesAfterLimit(ist("09:45"), IST) === 0);
ok("9:46 = 1 minute after the limit", minutesAfterLimit(ist("09:46"), IST) === 1);
ok("10:16 = 31 minutes after the limit", minutesAfterLimit(ist("10:16"), IST) === 31);

console.log("\n## which status the calendar shows for a day");
const s = (engineStatus: string, loginAt: Date | null, isToday = false) => calendarStatus({ engineStatus, loginAt, isToday, timezone: IST });
ok("a check-in decides, even when the hours-based engine said Absent", s("ABSENT", ist("09:50")) === "LATE");
ok("a check-in decides, even when the engine said Half day", s("HALF_DAY", ist("09:00")) === "PRESENT");
ok("no check-in on a finished tracked day = Absent", s("ABSENT", null) === "ABSENT");
ok("no check-in today (day still in progress) is NOT Absent", s("ABSENT", null, true) === "NOT_CLOCKED_IN");
ok("leave stays Leave", s("LEAVE", null) === "LEAVE");
ok("holiday stays Holiday", s("HOLIDAY", null) === "HOLIDAY");
ok("week-off stays Week-off", s("WEEK_OFF", null) === "WEEK_OFF");
ok("a day nobody was tracked stays Not tracked (no one is called absent)", s("NOT_TRACKED", null) === "NOT_TRACKED");
ok("future days show nothing", s("FUTURE", null) === null);
ok("days before joining show nothing", s("NOT_EMPLOYED", null) === null);
ok("custom limits are respected", calendarStatus({ engineStatus: "PRESENT", loginAt: ist("09:50"), isToday: false, timezone: IST, rules: { presentUntil: "10:00", lateUntil: "10:30" } }) === "PRESENT");

console.log("\n## priority: leave, then holiday, then week-off, then a check-in, then absent");
ok("approved leave wins even if the person clocked in", s("LEAVE", ist("09:00")) === "LEAVE");
ok("a holiday wins over a check-in", s("HOLIDAY", ist("09:00")) === "HOLIDAY");
ok("a week-off wins over a check-in", s("WEEK_OFF", ist("10:30")) === "WEEK_OFF");
ok("leave with no check-in today is Leave, never 'not in yet'", s("LEAVE", null, true) === "LEAVE");
const half = (login: Date | null, engineStatus = "HALF_DAY", isToday = false) => calendarStatus({ engineStatus, loginAt: login, isToday, timezone: IST, halfDayLeave: true });
ok("half-day leave with no check-in is Half-day leave, not Absent", half(null) === "HALF_DAY_LEAVE");
ok("half-day leave with a check-in is still shown as Half-day leave", half(ist("09:00"), "PRESENT") === "HALF_DAY_LEAVE");
ok("half-day leave today with no check-in is Half-day leave", half(null, "HALF_DAY", true) === "HALF_DAY_LEAVE");
ok("a holiday beats a half-day leave flag", calendarStatus({ engineStatus: "HOLIDAY", loginAt: null, isToday: false, timezone: IST, halfDayLeave: true }) === "HOLIDAY");
ok("no leave flag: a no-check-in HALF_DAY engine verdict is still Absent on a finished day", s("HALF_DAY", null) === "ABSENT");
ok("a working day with no check-in and no leave is Absent only when the company was tracking (engine says ABSENT)", s("ABSENT", null) === "ABSENT" && s("NOT_TRACKED", null) === "NOT_TRACKED");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
