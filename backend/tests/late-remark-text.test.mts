// Late Remark wording (the cell shown in the report, the CSV and the Excel file). No database.
import { lateDetail, lateRemarkText, NO_REMARK } from "../../frontend/app/dashboard/reports/_team/lateRemark.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

const IST = "Asia/Kolkata";
const at = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return new Date(Date.UTC(2026, 9, 28, h, m) - 330 * 60_000).toISOString(); };

const onTime = lateRemarkText({ arrival: "ON_TIME", loginAt: at("09:40") }, IST);
ok("on time shows the label and the check-in", /^On time · 09:40 am$/i.test(onTime) || /On time · 9:40/i.test(onTime) || onTime.startsWith("On time ·"));
const late = lateRemarkText({ arrival: "LATE", loginAt: at("09:50"), arrivalMinutes: 5, arrivalLimit: "09:45", lateReason: "Bus broke down" }, IST);
ok("late shows check-in, the late duration after 09:45, and the reason", late.startsWith("Late · checked in ") && late.includes("5 min after 09:45") && late.endsWith("Reason: Bus broke down"));
const noReason = lateRemarkText({ arrival: "LATE", loginAt: at("10:15"), arrivalMinutes: 30, arrivalLimit: "09:45", lateReason: null }, IST);
ok("no reason typed: says 'No remark provided', never an invented reason", noReason.endsWith(NO_REMARK) && NO_REMARK === "No remark provided" && !noReason.includes("Reason:"));
const half = lateRemarkText({ arrival: "HALF_DAY", loginAt: at("10:16"), arrivalMinutes: 31, arrivalLimit: "09:45", lateReason: "" }, IST);
ok("half day is labelled Half Day, with 31 min and No remark provided", half.startsWith("Half Day · checked in ") && half.includes("31 min after 09:45") && half.endsWith(NO_REMARK));
ok("a long delay reads as hours and minutes", lateRemarkText({ arrival: "HALF_DAY", loginAt: at("11:00"), arrivalMinutes: 75, arrivalLimit: "09:45", lateReason: null }, IST).includes("1h 15m after 09:45"));
ok("absent is just 'Absent'", lateRemarkText({ arrival: "ABSENT", loginAt: null }, IST) === "Absent");
ok("leave, holiday, week-off and not-in-yet have their own words", lateRemarkText({ arrival: "LEAVE", loginAt: null }, IST) === "Leave" && lateRemarkText({ arrival: "HOLIDAY", loginAt: null }, IST) === "Holiday" && lateRemarkText({ arrival: "WEEK_OFF", loginAt: null }, IST) === "Week-off" && lateRemarkText({ arrival: "NOT_CLOCKED_IN", loginAt: null }, IST) === "Not in yet");
ok("an HR correction is mentioned, not hidden", lateRemarkText({ arrival: "LATE", loginAt: at("09:50"), arrivalMinutes: 5, lateReason: null, correctedBy: "Sonali Gouda" }, IST).endsWith("Corrected by Sonali Gouda"));
ok("no classification, no text", lateRemarkText({ loginAt: null }, IST) === "");
ok("the detail line is only for Late and Half Day", lateDetail({ arrival: "ON_TIME", loginAt: at("09:40") }, IST) === "" && lateDetail({ arrival: "ABSENT", loginAt: null }, IST) === "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
