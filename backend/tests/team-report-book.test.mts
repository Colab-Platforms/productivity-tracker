// The team report workbook: sheets, order, per-employee sheets, totals and CSV, built from sample data. No database.
import { createRequire } from "node:module";
import path from "node:path";
import { allSheets, categorySheet, csvLines, indexOf, oneEmployeeSheet, summaryOf, type TeamReportData } from "../../frontend/app/dashboard/reports/_team/teamReportBook.ts";
import { buildReportWorkbook } from "../../frontend/app/dashboard/reports/_team/reportXlsx.ts";

// exceljs lives in the frontend; load it from there to read the file back
const req = createRequire(path.resolve(import.meta.dirname, "../../frontend/app/dashboard/reports/_team/reportXlsx.ts"));
const ExcelJS = req("exceljs");
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 300) : "")); };

const att = (userId: string, date: string, over: Record<string, unknown> = {}) => ({ userId, date, loginAt: `${date}T04:00:00.000Z`, logoutAt: `${date}T13:00:00.000Z`, workedHours: 7.5, productiveHours: 7.5, breakHours: 0.9, washroomHours: 0.1, huddleHours: null, status: "PRESENT", statusLabel: "Present", arrival: "ON_TIME", arrivalMinutes: null, arrivalLimit: "09:45", lateReason: null, correctedBy: null, lateMinutes: 0, earlyDepartureMinutes: null, leaveType: null, holidayName: null, note: null, tasksCompleted: 0, tasksPlanned: null, ...over });
const data: TeamReportData = {
  generatedAt: "2026-11-14T05:00:00Z", timezone: "Asia/Kolkata", today: "2026-11-14", from: "2026-11-10", to: "2026-11-14", days: 5, scope: { orgTotal: 3, filteredTotal: 3 },
  people: [
    { id: "a", name: "Ravi Kumar", employeeCode: "E-1", designation: "Analyst", company: "Avatar", reportingManager: "Meera Manager", projects: ["Alpha"] },
    { id: "b", name: "Sana Shaikh", employeeCode: "E-2", designation: "Analyst", company: "Avatar", reportingManager: "Meera Manager", projects: [] },
    { id: "c", name: "Tina Nodata", employeeCode: "E-3", designation: "Associate", company: "Avatar", reportingManager: "Meera Manager", projects: [] },
  ],
  attendance: [
    att("a", "2026-11-10"), att("a", "2026-11-11", { arrival: "LATE", arrivalMinutes: 35, lateReason: "Bus was late", lateMinutes: 35, huddleHours: 0.2 }), att("a", "2026-11-12", { status: "LEAVE", statusLabel: "Leave", loginAt: null, logoutAt: null, workedHours: null, productiveHours: null, breakHours: null, washroomHours: null, leaveType: "CASUAL", arrival: "LEAVE" }),
    att("b", "2026-11-10"), att("b", "2026-11-11", { status: "ABSENT", statusLabel: "Absent", loginAt: null, logoutAt: null, workedHours: null, productiveHours: null, breakHours: null, washroomHours: null, arrival: "ABSENT" }),
    att("c", "2026-11-10", { status: "NOT_TRACKED", statusLabel: "Not tracked", loginAt: null, logoutAt: null, workedHours: null, productiveHours: null, breakHours: null, washroomHours: null, arrival: "NOT_TRACKED" }),
  ] as never,
  tasks: [
    { id: "t1", userId: "a", title: "Report", description: "Monthly", project: "Alpha", taggedManager: "Meera Manager", date: "2026-11-10", priority: "HIGH", hoursSpent: 2, progress: "COMPLETED", approvalStatus: "APPROVED", completedAt: "2026-11-10T10:00:00Z", rating: 5, ratingComment: "Great", completionNote: null, rejectionNote: null, counted: true },
    { id: "t2", userId: "a", title: "Deck", description: null, project: "Alpha", taggedManager: null, date: "2026-11-11", priority: "MEDIUM", hoursSpent: null, progress: "BLOCKED", approvalStatus: "PENDING", completedAt: null, rating: null, ratingComment: null, completionNote: null, rejectionNote: null, counted: false },
    { id: "t3", userId: "a", title: "Old files", description: null, project: null, taggedManager: null, date: "2026-11-11", priority: "LOW", hoursSpent: null, progress: "IN_PROGRESS", approvalStatus: "REJECTED", completedAt: null, rating: null, ratingComment: null, completionNote: null, rejectionNote: "Next quarter", counted: false },
  ],
  breaks: [
    { userId: "a", date: "2026-11-10", type: "TEA", category: "Break", countsAsBreak: true, startedAt: "2026-11-10T05:30:00Z", endedAt: "2026-11-10T05:40:00Z", seconds: 600, running: false, autoClosed: false, remark: null },
    { userId: "a", date: "2026-11-10", type: "WASHROOM", category: "Washroom (not a break)", countsAsBreak: false, startedAt: "2026-11-10T09:30:00Z", endedAt: "2026-11-10T09:35:00Z", seconds: 300, running: false, autoClosed: false, remark: null },
  ],
  meetings: [
    { meetingId: "m1", userId: "a", title: "Stand-up", kind: "Team Huddle", organizer: "Meera Manager", scheduledStart: "2026-11-11T04:15:00Z", scheduledEnd: "2026-11-11T04:30:00Z", scheduledSeconds: 900, response: "ACCEPTED", status: "Joined", joinedAt: "2026-11-11T04:16:00Z", leftAt: "2026-11-11T04:28:00Z", participationSeconds: 720, openPastEnd: false },
    { meetingId: "m1", userId: "c", title: "Stand-up", kind: "Team Huddle", organizer: "Meera Manager", scheduledStart: "2026-11-11T04:15:00Z", scheduledEnd: "2026-11-11T04:30:00Z", scheduledSeconds: 900, response: null, status: "Not joined", joinedAt: null, leftAt: null, participationSeconds: null, openPastEnd: false },
  ],
  liveMeetings: [],
  leave: [
    { id: "l1", userId: "a", from: "2026-11-12", to: "2026-11-12", leaveType: "CASUAL", halfDay: false, firstHalf: true, dayCount: 1, reason: "Family", status: "APPROVED", appliedOn: "2026-11-05T05:00:00Z", decidedAt: "2026-11-06T05:00:00Z", decidedBy: "Asha Admin", decisionNote: null },
    { id: "l2", userId: "a", from: "2026-11-13", to: "2026-11-13", leaveType: "SICK", halfDay: false, firstHalf: true, dayCount: 1, reason: "Fever", status: "PENDING", appliedOn: "2026-11-12T05:00:00Z", decidedAt: null, decidedBy: null, decisionNote: null },
  ],
  leaveDays: [{ userId: "a", date: "2026-11-12", leaveType: "CASUAL", halfDay: false }],
  corrections: [{ userId: "b", date: "2026-11-11", type: "MISSING_CHECKIN", originalLoginAt: null, originalLogoutAt: null, requestedLoginAt: "2026-11-11T04:00:00Z", requestedLogoutAt: "2026-11-11T12:00:00Z", reason: "Gate scanner down", status: "APPROVED", reviewedBy: "Asha Admin", reviewedAt: "2026-11-12T05:00:00Z", reviewComment: "ok" }],
} as TeamReportData;

const sheets = allSheets(data);
const names = sheets.map((s) => s.name);
ok("order: summary, attendance, task performance, meetings, working hours, leave, break details, corrections, then one sheet per employee", names.slice(0, 8).join("|") === "Team Productivity Summary|Team Attendance|Team Task Performance|Meetings and Huddles|Break and Working Hours|Leave and Late Remarks|Break details|Attendance corrections" && names.length === 11, names);
ok("an employee sheet exists for every employee, named by ID and name, all unique and at most 31 characters", names.slice(8).join("|") === "E-1 Ravi Kumar|E-2 Sana Shaikh|E-3 Tina Nodata" && new Set(names.map((n) => n.toLowerCase())).size === names.length && names.every((n) => n.length <= 31));
const long = allSheets({ ...data, people: [{ ...data.people[0], name: "A Very Long Employee Name That Overflows The Limit", employeeCode: "LONG-001" }, { ...data.people[0], id: "z", name: "A Very Long Employee Name That Overflows The Limit", employeeCode: "LONG-001" }] }).slice(8).map((s) => s.name);
ok("two employees whose sheet names collide still get different sheet names", long.length === 2 && long[0] !== long[1] && long.every((n) => n.length <= 31), long);

const ix = indexOf(data);
const s = summaryOf(data, ix, "a");
ok("summary counts: Ravi has 2 present days (one late), 1 leave day, 1 late login and 1 late remark", s.present === 2 && s.leaveDays === 1 && s.lateLogins === 1 && s.lateRemarks === 1, s);
ok("summary hours are plain sums of the stored values (working 15h, break 1h48m)", s.workedSec === 54000 && s.breakSec === 6480 && s.productiveSec === 54000, s);
ok("Team Huddle time is its own figure inside productive time (0.2 h), never added to it", s.huddleSec === 720 && s.productiveSec === 54000);
ok("meeting participation is the recorded 12 minutes, 1 meeting joined", s.meetingsJoined === 1 && s.meetingSec === 720);
ok("task counts: 3 submitted, 1 waiting, 1 approved, 1 rejected, 1 blocked, 1 completed, 1 rated with its stars", s.submitted === 3 && s.waiting === 1 && s.approved === 1 && s.rejected === 1 && s.blocked === 1 && s.completed === 1 && s.rated === 1 && s.ratings === "5★ ×1", s);
ok("leave summary: 1 day taken, 1 pending request", s.leaveTaken === 1 && s.leavePending === 1);
const tina = summaryOf(data, ix, "c");
ok("an employee with no tasks, meetings or attendance is still summarised (zeros, not missing)", tina.submitted === 0 && tina.meetingsJoined === 0 && tina.workedSec === 0 && tina.notTracked === 1);
const sum = categorySheet(data, "summary");
ok("the summary sheet has one row per employee, including the one with nothing", sum.rows.length === 3 && sum.rows[2][0] === "Tina Nodata");

const bytes = await buildReportWorkbook(sheets, { report: "Team productivity report", period: "10 Nov 2026 to 14 Nov 2026 (5 days)", filters: [["Company", "All"]], exportedAt: new Date("2026-11-14T05:00:00Z"), timezone: "Asia/Kolkata", exportedBy: "Meera Manager", counts: [["Employees included", 3]] });
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(bytes);
ok("the file really has the same sheets, plus Report info last", wb.worksheets.map((w: { name: string }) => w.name).join("|") === [...names, "Report info"].join("|"));
const emp = wb.getWorksheet("E-1 Ravi Kumar");
ok("an employee sheet shows name, ID, reporting manager and the date range above the table", emp.getRow(1).getCell(1).value === "Employee" && emp.getRow(1).getCell(2).value === "Ravi Kumar" && emp.getRow(2).getCell(2).value === "E-1" && emp.getRow(5).getCell(2).value === "Meera Manager" && /10 Nov 2026 to 14 Nov 2026/.test(String(emp.getRow(7).getCell(2).value)));
const hdr = (emp.getRow(1).actualCellCount, [...Array(20).keys()].map((i) => emp.getRow(i + 1)).findIndex((r) => r.getCell(1).value === "Date") + 1);
ok("the daily table lists EVERY day of the period (5 days), including a day with leave and days with no record", [0, 1, 2, 3, 4].every((i) => emp.getRow(hdr + 1 + i).getCell(1).value instanceof Date) && emp.getRow(hdr + 6).getCell(1).value === null, hdr);
const day3 = emp.getRow(hdr + 3);
ok("the leave day shows the leave", /Casual/.test(String(day3.getCell(13).value)), day3.getCell(13).value);
const day2 = emp.getRow(hdr + 2);
ok("the late day shows the remark and the day's tasks with progress, approval and rejection reason", /Bus was late/.test(String(day2.getCell(11).value)) && /Deck/.test(String(day2.getCell(16).value)) && /Next quarter/.test(String(day2.getCell(16).value)) && /Stand-up/.test(String(day2.getCell(18).value)), [day2.getCell(11).value, day2.getCell(16).value, day2.getCell(18).value]);
const day1 = emp.getRow(hdr + 1);
ok("a day lists its breaks with start, end and length, washroom named separately", /Tea .*\(10m\)/.test(String(day1.getCell(17).value)) && /Washroom .*\(5m\)/.test(String(day1.getCell(17).value)), day1.getCell(17).value);
const tinaS = wb.getWorksheet("E-3 Tina Nodata");
ok("an employee with nothing still gets a sheet with every day listed", tinaS.getRow(hdr + 1).getCell(1).value instanceof Date && tinaS.getRow(hdr + 5).getCell(1).value instanceof Date);
const tasksWs = wb.getWorksheet("Team Task Performance");
ok("task sheet: 3 tasks, with the rating, feedback and rejection reason", tasksWs.rowCount === 4 && tasksWs.getRow(2).getCell(16).value === 5 && tasksWs.getRow(2).getCell(17).value === "Great", tasksWs.rowCount);
const mw = wb.getWorksheet("Meetings and Huddles");
ok("meetings sheet: Ravi joined (12 min), Tina 'Not joined' with no duration", mw.rowCount === 3 && String(mw.getRow(2).getCell(12).value) === "Joined" && mw.getRow(2).getCell(15).value instanceof Date && String(mw.getRow(3).getCell(12).value) === "Not joined" && mw.getRow(3).getCell(15).value === null, [mw.rowCount]);
const lw = wb.getWorksheet("Leave and Late Remarks");
ok("leave sheet: both requests (approved, pending) and the late arrival with its reason", lw.rowCount === 4 && /Bus was late/.test(JSON.stringify(lw.getRow(4).values)), lw.rowCount);
const info = wb.getWorksheet("Report info");
ok("Report info says who exported it, the period and how many employees", JSON.stringify(info.getSheetValues()).includes("Meera Manager") && JSON.stringify(info.getSheetValues()).includes("5 days") && JSON.stringify(info.getSheetValues()).includes("Employees included"));

// CSV
const lines = csvLines(categorySheet(data, "attendance"));
ok("CSV: a header, then one line per row, times and dates readable", lines[0][0] === "Employee" && lines.length === 7 && /10 Nov 2026/.test(lines[1][3]) && /AM|PM/.test(lines[1][6]), lines[1]);
const el = csvLines(oneEmployeeSheet(data, "a"));
ok("CSV of one employee starts with their name, ID and manager, then a blank line, then the daily table", el[0][0] === "Employee" && el[0][1] === "Ravi Kumar" && el.some((l) => l[0] === "Date") && el.length >= 12);
ok("one employee that is not in the report is refused", (() => { try { oneEmployeeSheet(data, "nobody"); return false; } catch { return true; } })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
