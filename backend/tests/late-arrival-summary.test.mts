// The Employee Summary's "Late arrivals" and "Late remarks typed" against the daily rows. No database.
// Real data has NO shift for most people, so lateMinutes is empty even on a Late day: the daily rows classify by the 09:45 arrival rule.
import { hasTypedRemark, isLateArrival } from "../../frontend/app/dashboard/reports/_team/lateRemark.ts";
import { indexOf, summaryOf, allSheets, type TeamReportData } from "../../frontend/app/dashboard/reports/_team/teamReportBook.ts";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 300) : "")); };

// a row exactly as the attendance report returns it for someone with no shift (lateMinutes null)
const row = (userId: string, date: string, ist: string, arrival: string, over: Record<string, unknown> = {}) => ({
  userId, date, loginAt: new Date(`${date}T${ist}:00+05:30`).toISOString(), logoutAt: new Date(`${date}T18:30:00+05:30`).toISOString(),
  workedHours: 8, productiveHours: 8, breakHours: 0.5, washroomHours: 0, huddleHours: null, status: "PRESENT", statusLabel: "Present",
  arrival, arrivalMinutes: null, arrivalLimit: "09:45", lateReason: null, correctedBy: null, lateMinutes: null, earlyDepartureMinutes: null,
  leaveType: null, holidayName: null, note: null, tasksCompleted: 0, tasksPlanned: null, ...over,
});
const base = (attendance: unknown[]): TeamReportData => ({
  generatedAt: "2026-11-14T05:00:00Z", timezone: "Asia/Kolkata", today: "2026-11-14", from: "2026-11-05", to: "2026-11-11", days: 7, scope: { orgTotal: 1, filteredTotal: 1 },
  people: [{ id: "a", name: "Ravi Kumar", employeeCode: "E-1", designation: "Analyst", company: "Avatar", reportingManager: "M", projects: [] }],
  attendance: attendance as never, tasks: [], breaks: [], meetings: [], liveMeetings: [], leave: [], leaveDays: [], corrections: [],
});
const sum = (rows: unknown[]) => { const d = base(rows); return summaryOf(d, indexOf(d), "a"); };

console.log("\n## the owner's example (no shift, no remarks)");
const ex = sum([row("a", "2026-11-05", "09:34", "ON_TIME"), row("a", "2026-11-06", "10:01", "LATE"), row("a", "2026-11-07", "09:57", "LATE")]);
ok("09:34 on time, 10:01 and 09:57 late: Late arrivals = 2", ex.lateLogins === 2, ex);
ok("no remark was typed: Late remarks typed = 0", ex.lateRemarks === 0, ex);
ok("the three days are still three present days", ex.present === 3);

console.log("\n## one rule, one day at a time");
ok("09:34 -> on time", !isLateArrival({ arrival: "ON_TIME", lateMinutes: null }));
ok("09:57 -> late", isLateArrival({ arrival: "LATE", lateMinutes: null }));
ok("10:01 -> late", isLateArrival({ arrival: "LATE" }));
ok("after 10:15 (Half Day arrival) is also a late arrival", isLateArrival({ arrival: "HALF_DAY" }));
ok("absent, leave, holiday, week-off, not tracked, not in yet are not late arrivals", ["ABSENT", "LEAVE", "HALF_DAY_LEAVE", "HOLIDAY", "WEEK_OFF", "NOT_TRACKED", "NOT_CLOCKED_IN"].every((a) => !isLateArrival({ arrival: a, lateMinutes: 30 })));
ok("an on-time day is not made late by shift late minutes (the arrival rule is the authority)", !isLateArrival({ arrival: "ON_TIME", lateMinutes: 20 }));
ok("only when a row has no arrival classification at all do late minutes decide", isLateArrival({ arrival: null, lateMinutes: 12 }) && isLateArrival({ lateMinutes: 12 }) && !isLateArrival({ arrival: null, lateMinutes: 0 }) && !isLateArrival({}));

console.log("\n## remarks are counted on their own");
const mix = sum([
  row("a", "2026-11-05", "10:01", "LATE"),                                          // late, no remark
  row("a", "2026-11-06", "09:57", "LATE", { lateReason: "Bus was late" }),          // late, remark
  row("a", "2026-11-07", "09:30", "ON_TIME", { lateReason: "typed by mistake" }),   // a remark on an on-time day
  row("a", "2026-11-08", "10:05", "LATE", { lateReason: "   " }),                   // blank spaces are not a remark
]);
ok("3 late arrivals, whatever the remark", mix.lateLogins === 3, mix);
ok("2 typed remarks (spaces do not count)", mix.lateRemarks === 2, mix);
ok("a late day without a remark counts as late, not as a remark", isLateArrival({ arrival: "LATE" }) && !hasTypedRemark({ lateReason: null }) && !hasTypedRemark({ lateReason: "  " }) && hasTypedRemark({ lateReason: "Bus" }));
ok("the presence of a remark does not make a day late", !isLateArrival({ arrival: "ON_TIME", lateMinutes: null }) && hasTypedRemark({ lateReason: "x" }));

console.log("\n## HR-corrected login");
const fixedOnTime = sum([row("a", "2026-11-06", "09:40", "ON_TIME", { correctedBy: "Sonali" })]);
ok("a late login corrected to 09:40 is no longer late", fixedOnTime.lateLogins === 0, fixedOnTime);
const fixedLate = sum([row("a", "2026-11-06", "10:20", "HALF_DAY", { correctedBy: "Sonali", lateReason: "Server down" })]);
ok("an on-time login corrected to 10:20 is counted late, with its remark", fixedLate.lateLogins === 1 && fixedLate.lateRemarks === 1, fixedLate);

console.log("\n## no double counting, any range");
const dup = sum([row("a", "2026-11-06", "10:01", "LATE", { lateMinutes: 16 }), row("a", "2026-11-07", "10:01", "LATE", { lateMinutes: 16, lateReason: "x" })]);
ok("a day that is late by BOTH rules is counted once", dup.lateLogins === 2, dup);
const empty = sum([]);
ok("an employee with no attendance rows has 0 (nothing invented)", empty.lateLogins === 0 && empty.lateRemarks === 0);
const long = sum(Array.from({ length: 31 }, (_, i) => row("a", `2026-10-${String(i + 1).padStart(2, "0")}`, i % 3 === 0 ? "10:10" : "09:30", i % 3 === 0 ? "LATE" : "ON_TIME")));
ok("a whole month: 11 late days of 31 are counted exactly", long.lateLogins === 11, long.lateLogins);

console.log("\n## the workbook's other late-arrival sheet agrees with the summary");
const d = base([row("a", "2026-11-05", "09:34", "ON_TIME"), row("a", "2026-11-06", "10:01", "LATE"), row("a", "2026-11-07", "09:57", "LATE", { lateReason: "Bus" })]);
const sheets = allSheets(d, indexOf(d)) as { name: string; rows: unknown[][] }[];
const leaveSheet = sheets.find((s) => /Late Remarks/i.test(s.name));
const lateRows = (leaveSheet?.rows ?? []).filter((r) => r.includes("Late arrival")).length;
ok("the Leave and Late Remarks sheet lists exactly the days the summary counts", leaveSheet !== undefined && lateRows === summaryOf(d, indexOf(d), "a").lateLogins, { sheets: sheets.map((s) => s.name), lateRows });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
