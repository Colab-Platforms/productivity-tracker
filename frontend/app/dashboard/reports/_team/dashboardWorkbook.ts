// The dashboard workbook (Admin, HR and Manager > Reports & Analytics > Export reports > "Dashboard workbook"): ONE .xlsx file with
//   sheet 1  "Dashboard": the period, summary tiles, an employee-by-employee comparison table (every name links to that employee's sheet) and
//            eight real Excel charts that read the table;
//   sheets 2..n  one detailed sheet per employee (sections A to G, each record list an Excel table with filters), with a "Back to Dashboard" link;
//   last     "Report info".
//
// NOTHING is calculated here that the HRMS does not already calculate. Working, productive, break, washroom and Team Huddle hours are the values the
// attendance engine returns; tasks, ratings and statuses are the stored values; every figure here is a plain count or a plain sum of those values.
// There is no productivity percentage and no new formula. The only Excel formulas are SUBTOTAL totals in the summary tiles, so the tiles (and the
// charts, which skip hidden rows) follow whatever filter someone puts on the employee table.
//
// BLANK versus ZERO: a cell is blank when nothing was recorded (an employee with no attendance record has blank hours, never 0:00); it is 0 only when
// the records exist and the count is really zero (a person who submitted no tasks has 0 tasks). Ratings are averaged over RATED tasks only; an
// unrated task is never counted as zero or as five stars.
//
// Pure apart from loading exceljs / jszip: no network and no browser, so the file contents can be tested on their own.

import type { Worksheet } from "exceljs";
import { addChartsToWorkbook, type ChartSeries, type ChartSpec } from "./chartXml";
import { BRAND, BORDER, FORMAT, cellValue, columnLetter, dayOf, secondsOfDay, stampLabel, type Kind, type Value } from "./reportXlsx";
import { dayLabel } from "./format";
import { lateRemarkText } from "./lateRemark";
import {
  APPROVAL, CORR_STATUS, CORRECTION_TYPE, LEAVE_STATUS, LEAVE_TYPE, PROGRESS, daysBetween, dayName, employeeSheetName, indexOf, periodLabel, sec, summaryOf, sum, title,
  type Index, type TRPerson, type TeamReportData,
} from "./teamReportBook";

export type DashboardInfo = { reportName: string; exportedAt: Date; exportedBy: string | null; filters: [string, string][] };

const INDIGO = "FF2F3EB0";
const INK = "FF1E293B";
const GREY = "FF718096";
const TILE = "FFE7F6F1";
const LINK = "FF1D4ED8";
const FONT = { name: "Calibri", size: 11 };
const thin = { style: "thin" as const, color: { argb: BORDER } };
const BOX = { top: thin, left: thin, bottom: thin, right: thin };

const round2 = (n: number) => Math.round(n * 100) / 100;
const quoteSheet = (name: string) => `'${name.replace(/'/g, "''")}'`;
const linkTo = (sheet: string, cell = "A1") => `#${quoteSheet(sheet)}!${cell}`;
const hoursOf = (seconds: number) => round2(seconds / 3600);

// ---------------------------------------------------------------------------------------------- the dashboard table
type DashKey =
  | "name" | "code" | "designation" | "department" | "company" | "manager" | "status" | "workingDays" | "present" | "half" | "absent" | "leave" | "late" | "lateRemarks"
  | "workHrs" | "prodHrs" | "breakHrs" | "meetHrs" | "submitted" | "completed" | "pending" | "approved" | "rejected" | "blocked" | "rated" | "avg" | "wPct" | "wEligible" | "wDone" | "wCompletion" | "wPending" | "wStatus" | "note"
  | "hActive" | "hPresent" | "hAbsent";
type DashCol = { key: DashKey; header: string; kind: Kind; width: number; note?: string };
export const DASH_COLS: DashCol[] = [
  { key: "name", header: "Employee", kind: "text", width: 28, note: "Click a name to open that employee's detailed sheet." },
  { key: "code", header: "Employee ID", kind: "text", width: 13 },
  { key: "designation", header: "Designation", kind: "text", width: 22 },
  { key: "department", header: "Department (team)", kind: "text", width: 24, note: "The HRMS has no separate department field: this is the team(s) the employee belongs to." },
  { key: "company", header: "Company", kind: "text", width: 22 },
  { key: "manager", header: "Reporting manager", kind: "text", width: 22 },
  { key: "status", header: "Employment status", kind: "text", width: 14 },
  { key: "workingDays", header: "Working days in period", kind: "int", width: 12, note: "Days present + half days + absent + leave. Holidays, week-offs and days the company did not track are not counted. Compare employees by this, not by raw totals." },
  { key: "present", header: "Days present", kind: "int", width: 10 },
  { key: "half", header: "Half days", kind: "int", width: 10 },
  { key: "absent", header: "Days absent", kind: "int", width: 10 },
  { key: "leave", header: "Leave days", kind: "decimal", width: 10, note: "Approved leave days taken (a half day counts 0.5)." },
  { key: "late", header: "Late arrivals", kind: "int", width: 10 },
  { key: "lateRemarks", header: "Late remarks", kind: "int", width: 10, note: "Days on which the employee typed a reason for arriving late." },
  { key: "workHrs", header: "Working hours (h)", kind: "decimal", width: 12 },
  { key: "prodHrs", header: "Productive hours (h)", kind: "decimal", width: 12, note: "The HRMS productive-hours figure. Team Huddle and approved meeting time are inside it, never added to it." },
  { key: "breakHrs", header: "Break hours (h)", kind: "decimal", width: 12, note: "Break time only. Washroom time and discussions are not breaks." },
  { key: "meetHrs", header: "Meeting participation (h)", kind: "decimal", width: 13, note: "Recorded join-to-leave time of scheduled meetings and Team Huddles. Shown for information; it is inside productive hours, not added to them." },
  { key: "submitted", header: "Tasks submitted", kind: "int", width: 10 },
  { key: "completed", header: "Tasks completed", kind: "int", width: 10, note: "Tasks whose progress is Completed (not necessarily approved yet)." },
  { key: "pending", header: "Pending approval", kind: "int", width: 10 },
  { key: "approved", header: "Tasks approved", kind: "int", width: 10 },
  { key: "rejected", header: "Tasks rejected", kind: "int", width: 10 },
  { key: "blocked", header: "Tasks blocked", kind: "int", width: 10 },
  { key: "rated", header: "Tasks rated", kind: "int", width: 10 },
  { key: "avg", header: "Average rating (rated tasks only)", kind: "decimal", width: 14, note: "Stars 1-5, averaged over tasks a manager actually rated. Blank = no rated task. An unrated task is never counted as 0 or 5." },
  { key: "wEligible", header: "Eligible tasks (score)", kind: "int", width: 12, note: "Approved, not cancelled, dated inside the period." },
  { key: "wDone", header: "Completed tasks (score)", kind: "int", width: 12 },
  { key: "wCompletion", header: "Completion %", kind: "percent", width: 12, note: "Completed tasks / eligible tasks." },
  { key: "wPending", header: "Pending evaluation", kind: "int", width: 11, note: "Completed tasks the manager has not rated yet (never counted as 5 stars)." },
  { key: "wPct", header: "Overall Performance Score %", kind: "percent", width: 14, note: "Completion % x 0.60 + manager rating % x 0.40, from the server. Task priority is not used. Blank = N/A or awaiting evaluation (see Evaluation status)." },
  { key: "wStatus", header: "Evaluation status", kind: "text", width: 17 },


  { key: "note", header: "Data note", kind: "text", width: 36 },
  { key: "hActive", header: "Active (1 = yes)", kind: "int", width: 9, note: "Helper column for the summary tiles." },
  { key: "hPresent", header: "Present at least once (1 = yes)", kind: "int", width: 12, note: "Helper column for the summary tiles." },
  { key: "hAbsent", header: "Absent at least once (1 = yes)", kind: "int", width: 12, note: "Helper column for the summary tiles." },
];
const colIndex = (k: DashKey) => DASH_COLS.findIndex((c) => c.key === k);
const colLetter = (k: DashKey) => columnLetter(colIndex(k));

export type DashRow = { person: TRPerson; sheet: string; display: string; v: Record<DashKey, string | number | null> };

/** One employee's line of the dashboard table. Blank (null) = nothing recorded; 0 = recorded as none. */
export function dashRow(data: TeamReportData, ix: Index, p: TRPerson, sheet: string, display: string): DashRow {
  const s = summaryOf(data, ix, p.id);
  const att = ix.att.get(p.id) ?? [];
  const hasAtt = att.length > 0;
  const hoursKnown = att.some((r) => r.workedHours !== null);
  const rated = (ix.tasks.get(p.id) ?? []).filter((k) => k.rating !== null);
  const hasMeetings = (ix.meetings.get(p.id) ?? []).length > 0;
  const notes: string[] = [];
  if (!hasAtt) notes.push("No attendance records in this period");
  else if (!hoursKnown) notes.push("No hours recorded in this period");
  if (p.joinedOn && p.joinedOn > data.from && p.joinedOn <= data.to) notes.push(`Joined ${dayLabel(p.joinedOn)}, during the period`);
  if (hasAtt && s.notTracked > 0) notes.push(`${s.notTracked} day(s) not tracked`);
  if (s.submitted === 0) notes.push("No tasks submitted");
  if (s.submitted > 0 && rated.length === 0) notes.push("No rated tasks");
  const v: Record<DashKey, string | number | null> = {
    name: display, code: p.employeeCode ?? "", designation: p.designation ?? "", department: p.projects.join(", "), company: p.company ?? "", manager: p.reportingManager ?? "Not assigned",
    status: p.status ? title(p.status) ?? "" : "",
    workingDays: hasAtt ? s.present + s.halfDays + s.absent + s.leaveDays : null,
    present: hasAtt ? s.present : null, half: hasAtt ? s.halfDays : null, absent: hasAtt ? s.absent : null, leave: s.leaveTaken,
    late: hasAtt ? s.lateLogins : null, lateRemarks: hasAtt ? s.lateRemarks : null,
    workHrs: hoursKnown ? hoursOf(s.workedSec) : null, prodHrs: hoursKnown ? hoursOf(s.productiveSec) : null, breakHrs: hoursKnown ? hoursOf(s.breakSec) : null,
    meetHrs: hasMeetings ? hoursOf(s.meetingSec) : null,
    submitted: s.submitted, completed: s.completed, pending: s.waiting, approved: s.approved, rejected: s.rejected, blocked: s.blocked, rated: rated.length,
    avg: rated.length > 0 ? round2(sum(rated.map((k) => k.rating)) / rated.length) : null,
    wPct: s.perf?.percent ?? null,
    wEligible: s.perf?.tasks ?? null, wDone: s.perf?.completed ?? null, wCompletion: s.perf?.completionPercent ?? null, wPending: s.perf?.awaitingRating ?? null,
    wStatus: s.perf ? (s.perf.percent === null && s.perf.status === "AWAITING_EVALUATION" ? "Awaiting evaluation" : s.perf.status === "NO_TASKS" ? "N/A" : s.perf.status === "PROVISIONAL" ? "Provisional" : "Final") : null,


    note: notes.join("; "),
    hActive: p.status ? (p.status === "ACTIVE" ? 1 : 0) : null,
    hPresent: hasAtt ? (s.present + s.halfDays > 0 ? 1 : 0) : null,
    hAbsent: hasAtt ? (s.absent > 0 ? 1 : 0) : null,
  };
  return { person: p, sheet, display, v };
}

/** The label shown for each employee: the name, plus the ID when two people share a name (so charts and links never confuse them). */
export function displayNames(people: TRPerson[]): string[] {
  const count = new Map<string, number>();
  for (const p of people) count.set(p.name.trim().toLowerCase(), (count.get(p.name.trim().toLowerCase()) ?? 0) + 1);
  return people.map((p) => ((count.get(p.name.trim().toLowerCase()) ?? 0) > 1 && p.employeeCode ? `${p.name} (${p.employeeCode})` : p.name));
}

/** Unique, legal worksheet names (at most 31 characters, none of [ ] : * ? / \, no leading or trailing apostrophe), one per person, in order. */
export function sheetNames(people: TRPerson[]): string[] {
  const taken = new Set(["dashboard", "report info"]);
  return people.map((p) => employeeSheetName(p, taken).replace(/^'+|'+$/g, "").trim() || "Employee");
}

// ---------------------------------------------------------------------------------------------- small writers
function put(ws: Worksheet, ref: string, value: unknown, o: { bold?: boolean; size?: number; color?: string; fill?: string; align?: "left" | "center" | "right"; wrap?: boolean; numFmt?: string; border?: boolean; italic?: boolean } = {}) {
  const cell = ws.getCell(ref);
  cell.value = value as never;
  cell.font = { ...FONT, bold: o.bold, italic: o.italic, size: o.size ?? 11, color: { argb: o.color ?? INK } };
  if (o.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: o.fill } };
  cell.alignment = { vertical: "middle", horizontal: o.align ?? "left", wrapText: !!o.wrap };
  if (o.numFmt) cell.numFmt = o.numFmt;
  if (o.border) cell.border = BOX;
  return cell;
}
const linkCell = (ws: Worksheet, ref: string, text: string, target: string, bold = false) => {
  const cell = ws.getCell(ref);
  cell.value = { text, hyperlink: target } as never;
  cell.font = { ...FONT, bold, underline: true, color: { argb: LINK } };
  cell.alignment = { vertical: "middle", horizontal: "left" };
  return cell;
};
const headerStyle = (cell: { font: unknown; fill: unknown; alignment: unknown; border: unknown }, accent = false) => {
  cell.font = { ...FONT, bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: accent ? INDIGO : BRAND } };
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  cell.border = BOX;
};

type Rule = [text: string, fill: string, font: string];
function statusColours(ws: Worksheet, ref: string, rules: Rule[]) {
  ws.addConditionalFormatting({
    ref,
    rules: rules.map(([text, fill, font], i) => ({
      type: "containsText" as const, operator: "containsText" as const, text, priority: i + 1,
      style: { font: { color: { argb: font } }, fill: { type: "pattern" as const, pattern: "solid" as const, bgColor: { argb: fill } } },
    })),
  });
}
const ATTENDANCE_RULES: Rule[] = [["Absent", "FFFECACA", "FF991B1B"], ["Half", "FFFDE68A", "FF92400E"], ["Late", "FFFEF3C7", "FF92400E"], ["Leave", "FFBFDBFE", "FF1E40AF"], ["Present", "FFBBF7D0", "FF166534"], ["Holiday", "FFE5E7EB", "FF374151"], ["Week", "FFE5E7EB", "FF374151"], ["No record", "FFF3F4F6", "FF6B7280"], ["Not tracked", "FFF3F4F6", "FF6B7280"]];
const APPROVAL_RULES: Rule[] = [["Rejected", "FFFECACA", "FF991B1B"], ["Waiting", "FFFEF3C7", "FF92400E"], ["Approved", "FFBBF7D0", "FF166534"]];
const PROGRESS_RULES: Rule[] = [["Blocked", "FFFDE68A", "FF92400E"], ["Completed", "FFBBF7D0", "FF166534"], ["In Progress", "FFBFDBFE", "FF1E40AF"], ["To Do", "FFE5E7EB", "FF374151"]];
const LEAVE_RULES: Rule[] = [["Rejected", "FFFECACA", "FF991B1B"], ["Pending", "FFFEF3C7", "FF92400E"], ["Approved", "FFBBF7D0", "FF166534"], ["Cancelled", "FFE5E7EB", "FF374151"]];

type TCol = { header: string; kind?: Kind; wrap?: boolean };

/** Writes a titled Excel TABLE (filter buttons on) starting at `row`; returns the next free row. An empty list is not a table: it says nothing was recorded. */
function addSection(ws: Worksheet, row: number, heading: string, tableName: string, cols: TCol[], rows: Value[][], emptyText: string): { next: number; first: number; last: number } {
  put(ws, `A${row}`, heading, { bold: true, size: 13, color: BRAND });
  ws.getRow(row).height = 24;
  row += 1;
  if (rows.length === 0) {
    put(ws, `A${row}`, emptyText, { italic: true, color: GREY });
    return { next: row + 2, first: row, last: row };
  }
  ws.addTable({
    name: tableName, ref: `A${row}`, headerRow: true, totalsRow: false, style: { theme: "TableStyleLight1", showRowStripes: true },
    columns: cols.map((c) => ({ name: c.header, filterButton: true })),
    rows: rows.map((r) => r.map((v, i) => cellValue(v, cols[i].kind ?? "text") as never)),
  });
  ws.getRow(row).height = 32;
  cols.forEach((c, j) => headerStyle(ws.getRow(row).getCell(j + 1)));
  rows.forEach((_, i) => {
    cols.forEach((c, j) => {
      const cell = ws.getRow(row + 1 + i).getCell(j + 1);
      const kind = c.kind ?? "text";
      if (FORMAT[kind]) cell.numFmt = FORMAT[kind]!;
      cell.font = FONT;
      cell.border = BOX;
      cell.alignment = { vertical: "top", horizontal: kind === "text" ? "left" : "center", wrapText: !!c.wrap };
    });
  });
  return { next: row + rows.length + 3, first: row + 1, last: row + rows.length };
}

// ---------------------------------------------------------------------------------------------- an employee's sheet
const EMP_WIDTHS = [14, 14, 14, 34, 18, 18, 18, 16, 14, 16, 22, 18, 14, 32, 26, 30];

function writeEmployeeSheet(ws: Worksheet, data: TeamReportData, ix: Index, row: DashRow, n: number, dashRowNo: number) {
  const tz = data.timezone;
  const p = row.person;
  const s = summaryOf(data, ix, p.id);
  EMP_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  put(ws, "A1", `${p.name}${p.employeeCode ? `  ·  ${p.employeeCode}` : ""}`, { bold: true, size: 18, color: BRAND });
  ws.getRow(1).height = 30;
  linkCell(ws, "A2", "← Back to Dashboard", linkTo("Dashboard", `A${dashRowNo}`), true);
  put(ws, "A3", `${periodLabel(data)}  ·  times are in ${tz}  ·  blank = nothing recorded, 0 = recorded as none`, { color: GREY, size: 10 });
  ws.views = [{ state: "frozen", ySplit: 3 }];
  ws.properties.tabColor = { argb: "FF93C5FD" };

  // A. Employee information
  let r = 5;
  put(ws, `A${r}`, "A. Employee information", { bold: true, size: 13, color: BRAND });
  ws.getRow(r).height = 24;
  const info: [string, string | number][] = [
    ["Name", p.name], ["Employee ID", p.employeeCode ?? ""], ["Designation", p.designation ?? ""], ["Department (team)", p.projects.join(", ")], ["Company", p.company ?? ""],
    ["Reporting manager", p.reportingManager ?? "Not assigned"], ["Employment status", p.status ? title(p.status) ?? "" : ""], ["Joined on", p.joinedOn ? dayLabel(p.joinedOn) : ""],
    ["Reporting period", periodLabel(data)],
  ];
  info.forEach(([k, v], i) => {
    put(ws, `A${r + 1 + i}`, k, { bold: true });
    put(ws, `B${r + 1 + i}`, v);
  });
  r += info.length + 3;

  // B. Attendance details: one row per calendar day, a day without a record says so
  const att = new Map((ix.att.get(p.id) ?? []).map((a) => [a.date, a]));
  const cors = ix.corrections.get(p.id) ?? [];
  const last = data.to < data.today ? data.to : data.today;
  const days = daysBetween(data.from, last);
  const attRows: Value[][] = days.map((day) => {
    const a = att.get(day);
    const corr = cors.filter((c) => c.date === day).map((c) => `${CORRECTION_TYPE[c.type] ?? c.type}: ${CORR_STATUS[c.status] ?? c.status}${c.reviewedBy ? ` by ${c.reviewedBy}` : ""}${c.reviewComment ? ` (${c.reviewComment})` : ""}`);
    const lateText = a ? lateRemarkText({ arrival: a.arrival ?? null, loginAt: a.loginAt, arrivalMinutes: a.arrivalMinutes, arrivalLimit: a.arrivalLimit, lateReason: a.lateReason, correctedBy: a.correctedBy }, tz) : null;
    return [day, dayName(day), a ? secondsOfDay(a.loginAt, tz) : null, a ? secondsOfDay(a.logoutAt, tz) : null, a ? a.statusLabel : "No record", a ? sec(a.workedHours) : null, lateText, corr.join("\n") || (a?.correctedBy ? `Corrected by ${a.correctedBy}` : null)];
  });
  const attCols: TCol[] = [{ header: "Date", kind: "date" }, { header: "Day" }, { header: "Login", kind: "time" }, { header: "Logout", kind: "time" }, { header: "Attendance status" }, { header: "Total working duration", kind: "duration" }, { header: "Late remarks", wrap: true }, { header: "Late approval / correction details", wrap: true }];
  const sB = addSection(ws, r, "B. Attendance details", `Att${n}`, attCols, attRows, "No attendance days in this period.");
  if (attRows.length) statusColours(ws, `E${sB.first}:E${sB.last}`, ATTENDANCE_RULES);
  r = sB.next;

  // C. Working hours and breaks
  const brk = ix.breaks.get(p.id) ?? [];
  const hrRows: Value[][] = days.map((day) => {
    const a = att.get(day);
    const counted = brk.filter((b) => b.date === day && b.countsAsBreak).length;
    return [day, a ? sec(a.workedHours) : null, a ? sec(a.productiveHours) : null, a ? sec(a.breakHours) : null, a ? counted : null, a ? sec(a.washroomHours) : null, a ? sec(a.huddleHours) : null, a?.correctedBy ? `Corrected by ${a.correctedBy}` : null];
  });
  const hrCols: TCol[] = [{ header: "Date", kind: "date" }, { header: "Daily working hours", kind: "duration" }, { header: "Productive hours", kind: "duration" }, { header: "Total break duration", kind: "duration" }, { header: "Number of breaks", kind: "int" }, { header: "Washroom time (not a break)", kind: "duration" }, { header: "Team Huddle (inside productive)", kind: "duration" }, { header: "Applicable corrections", wrap: true }];
  const sC1 = addSection(ws, r, "C. Working hours and breaks (per day)", `Hrs${n}`, hrCols, hrRows, "No days in this period.");
  r = sC1.next;
  const brkRows: Value[][] = brk.map((b) => [b.date, title(b.type), b.category, secondsOfDay(b.startedAt, tz), b.endedAt ? secondsOfDay(b.endedAt, tz) : b.running ? "Still running" : null, b.seconds, b.countsAsBreak ? "Yes" : "No", b.remark]);
  const brkCols: TCol[] = [{ header: "Date", kind: "date" }, { header: "Activity" }, { header: "Counted as" }, { header: "Break start", kind: "time" }, { header: "Break end", kind: "time" }, { header: "Duration", kind: "duration" }, { header: "Counts as a break", wrap: false }, { header: "Remark", wrap: true }];
  const sC2 = addSection(ws, r, "Break details", `Brk${n}`, brkCols, brkRows, "No breaks, washroom time or discussions were recorded in this period.");
  r = sC2.next;

  // D. Daily task performance: every task, not only the completed ones
  const tasks = ix.tasks.get(p.id) ?? [];
  const taskRows: Value[][] = tasks.map((k) => [
    k.date, k.submittedAt ? dayOf(k.submittedAt, tz) : null, k.submittedAt ? secondsOfDay(k.submittedAt, tz) : null, k.title, k.project, k.taggedManager, sec(k.hoursSpent), title(k.priority),
    PROGRESS[k.progress] ?? title(k.progress), k.progress === "BLOCKED" ? k.blockedReason ?? null : null, APPROVAL[k.approvalStatus] ?? title(k.approvalStatus),
    k.rating, k.ratingComment, k.rejectionNote, k.late ? `Late submission: ${k.late.lateByDays} day(s) after the task date${k.late.reason ? `. Reason: ${k.late.reason}` : ""}` : null, k.description,
  ]);
  const taskCols: TCol[] = [
    { header: "Task date", kind: "date" }, { header: "Submission date", kind: "date" }, { header: "Submission time", kind: "time" }, { header: "Task description", wrap: true }, { header: "Project", wrap: true },
    { header: "Assigned reporting manager", wrap: true }, { header: "Hours spent", kind: "duration" }, { header: "Priority" }, { header: "Progress status" }, { header: "Blocked reason", wrap: true }, { header: "Approval status" },
    { header: "Manager rating (stars)", kind: "int" }, { header: "Manager feedback", wrap: true }, { header: "Reason sent back", wrap: true }, { header: "Late submission", wrap: true }, { header: "Additional details", wrap: true },
  ];
  const sD = addSection(ws, r, "D. Daily task performance (all tasks)", `Tsk${n}`, taskCols, taskRows, "No tasks were submitted in this period.");
  if (taskRows.length) {
    statusColours(ws, `I${sD.first}:I${sD.last}`, PROGRESS_RULES);
    statusColours(ws, `K${sD.first}:K${sD.last}`, APPROVAL_RULES);
    statusColours(ws, `O${sD.first}:O${sD.last}`, [["Late submission", "FFFEF3C7", "FF92400E"]]);
  }
  r = sD.next;

  // E. Meetings and Team Huddles
  const mt = ix.meetings.get(p.id) ?? [];
  const live = ix.live.get(p.id) ?? [];
  const meetRows: Value[][] = [
    ...mt.map((m): Value[] => [m.title, m.kind, dayOf(m.scheduledStart, tz), secondsOfDay(m.scheduledStart, tz), secondsOfDay(m.scheduledEnd, tz), m.scheduledSeconds, m.joinedAt ? secondsOfDay(m.joinedAt, tz) : null, m.leftAt ? secondsOfDay(m.leftAt, tz) : null, m.participationSeconds, m.status]),
    ...live.map((m): Value[] => [m.title ?? title(m.type), "Live meeting", m.date, null, null, null, m.startedAt ? secondsOfDay(m.startedAt, tz) : null, m.endedAt ? secondsOfDay(m.endedAt, tz) : null, m.seconds, `${title(m.approvalStatus)}${m.countsInProductive ? " (inside productive time)" : ""}`]),
  ];
  const meetCols: TCol[] = [{ header: "Meeting name", wrap: true }, { header: "Type" }, { header: "Date", kind: "date" }, { header: "Scheduled start", kind: "time" }, { header: "Scheduled end", kind: "time" }, { header: "Scheduled duration", kind: "duration" }, { header: "Actual join time", kind: "time" }, { header: "Actual end time", kind: "time" }, { header: "Participation duration", kind: "duration" }, { header: "Status", wrap: true }];
  const sE = addSection(ws, r, "E. Meetings and Team Huddles", `Mtg${n}`, meetCols, meetRows, "No meetings or Team Huddles in this period.");
  r = sE.next;

  // F. Leave
  const lv = ix.leave.get(p.id) ?? [];
  const leaveRows: Value[][] = lv.map((l) => [l.from, l.to, LEAVE_TYPE[l.leaveType] ?? title(l.leaveType), l.dayCount, l.halfDay ? (l.firstHalf ? "First half" : "Second half") : "Full day", LEAVE_STATUS[l.status] ?? title(l.status), dayOf(l.appliedOn, tz), l.decidedBy, l.decidedAt ? dayOf(l.decidedAt, tz) : null, l.decisionNote ?? null]);
  const leaveCols: TCol[] = [{ header: "Leave from", kind: "date" }, { header: "Leave to", kind: "date" }, { header: "Leave type" }, { header: "Duration (days)", kind: "decimal" }, { header: "Full / half day" }, { header: "Approval status" }, { header: "Applied on", kind: "date" }, { header: "Approver" }, { header: "Decision date", kind: "date" }, { header: "Decision note", wrap: true }];
  const sF = addSection(ws, r, "F. Leave details", `Lve${n}`, leaveCols, leaveRows, "No leave requests in this period.");
  if (leaveRows.length) statusColours(ws, `F${sF.first}:F${sF.last}`, LEAVE_RULES);
  r = sF.next;

  // G. Employee summary (plain counts and sums of the records above)
  put(ws, `A${r}`, "G. Employee summary", { bold: true, size: 13, color: BRAND });
  ws.getRow(r).height = 24;
  const rated = tasks.filter((k) => k.rating !== null);
  const lateTasks = tasks.filter((k) => !!k.late).length;
  const hasAtt = att.size > 0;
  const hoursKnown = [...att.values()].some((a) => a.workedHours !== null);
  const summary: [string, string | number | null, Kind?][] = [
    ["Days present", hasAtt ? s.present : null], ["Half days", hasAtt ? s.halfDays : null], ["Days absent", hasAtt ? s.absent : null], ["Days on leave (attendance)", hasAtt ? s.leaveDays : null],
    ["Holidays / week-offs / not tracked", hasAtt ? `${s.holidays} / ${s.weekOffs} / ${s.notTracked}` : null], ["Late arrivals", hasAtt ? s.lateLogins : null], ["Late remarks typed", hasAtt ? s.lateRemarks : null],
    ["Total working hours", hoursKnown ? s.workedSec : null, "duration"], ["Total productive hours", hoursKnown ? s.productiveSec : null, "duration"], ["Total break hours", hoursKnown ? s.breakSec : null, "duration"],
    ["Total washroom time (not a break)", hoursKnown ? s.washroomSec : null, "duration"], ["Team Huddle time (inside productive)", hoursKnown ? s.huddleSec : null, "duration"],
    ["Total tasks", s.submitted],
    ["Tasks: To Do / In Progress / Completed / Blocked", `${s.todo} / ${s.inProgress} / ${s.completed} / ${s.blocked}`],
    ["Tasks: waiting for approval / approved / rejected", `${s.waiting} / ${s.approved} / ${s.rejected}`],
    ["Tasks submitted late", lateTasks],
    ["Tasks rated", rated.length],
    ["Average rating (rated tasks only)", rated.length ? round2(sum(rated.map((k) => k.rating)) / rated.length) : null, "decimal"],
    ["Rating breakdown", s.ratings || null],
    ["Meetings joined", (ix.meetings.get(p.id) ?? []).length > 0 ? s.meetingsJoined : null], ["Total meeting participation", (ix.meetings.get(p.id) ?? []).length > 0 ? s.meetingSec : null, "duration"],
    ["Total leave days taken", s.leaveTaken, "decimal"], ["Attendance corrections", s.corrections],
  ];
  summary.forEach(([k, v, kind], i) => {
    put(ws, `A${r + 1 + i}`, k, { bold: true });
    const cell = put(ws, `D${r + 1 + i}`, v === null ? null : kind === "duration" ? (v as number) / 86400 : v, { align: "left", numFmt: kind ? FORMAT[kind] : undefined });
    void cell;
  });
}

// ---------------------------------------------------------------------------------------------- the workbook
const COLORS = { green: "0D9E76", indigo: "2F3EB0", amber: "F59E0B", red: "DC2626", sky: "0EA5E9", slate: "64748B" };

export async function buildDashboardWorkbook(data: TeamReportData, info: DashboardInfo): Promise<ArrayBuffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = info.exportedBy || "Avatar HRMS";
  wb.created = info.exportedAt;
  wb.title = info.reportName;
  const tz = data.timezone;
  const ix = indexOf(data);
  const people = data.people;
  const names = displayNames(people);
  const sheets = sheetNames(people);
  const rows = people.map((p, i) => dashRow(data, ix, p, sheets[i], names[i]));
  const N = rows.length;
  const period = periodLabel(data);

  // ---- sheet 1: Dashboard ----
  const ws = wb.addWorksheet("Dashboard", { properties: { tabColor: { argb: BRAND } }, views: [{ state: "frozen", xSplit: 1 }] });
  DASH_COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
  put(ws, "A1", "Overall Employee Dashboard", { bold: true, size: 22, color: BRAND });
  ws.getRow(1).height = 34;
  put(ws, "A2", `${info.reportName}   ·   ${period}   ·   Exported ${stampLabel(info.exportedAt, tz)} (${tz})${info.exportedBy ? `   ·   by ${info.exportedBy}` : ""}`, { color: GREY });
  put(ws, "A3", `${N} employee${N === 1 ? "" : "s"} in this report (${data.scope.orgTotal} in your authorised scope)${info.filters.length ? `   ·   ${info.filters.map(([k, v]) => `${k}: ${v}`).join("; ")}` : ""}.   Blank = nothing recorded; 0 = recorded as none.`, { color: GREY, size: 10 });

  // ---- the table first (the tiles read it), positions fixed up front ----
  const TILE_ROWS = 3; // three bands of tiles
  const sectionRow = 5 + TILE_ROWS * 3 + 1; // 15
  const headRow = sectionRow + 1;
  const first = headRow + 1;
  const lastRow = headRow + N;
  put(ws, `A${sectionRow}`, "Employee-wise overview", { bold: true, size: 14, color: BRAND });
  put(ws, `D${sectionRow}`, "Click an employee's name to open their detailed sheet. Use the filter buttons: the tiles above and the charts below follow the rows you leave visible.", { color: GREY, size: 10 });
  ws.getRow(headRow).height = 52;
  DASH_COLS.forEach((c, i) => {
    const cell = ws.getRow(headRow).getCell(i + 1);
    cell.value = c.header;
    headerStyle(cell, c.key === "hActive" || c.key === "hPresent" || c.key === "hAbsent");
    if (c.note) cell.note = c.note;
  });
  rows.forEach((row, ri) => {
    const rn = first + ri;
    DASH_COLS.forEach((c, ci) => {
      const cell = ws.getRow(rn).getCell(ci + 1);
      if (c.key === "name") {
        linkCell(ws, `A${rn}`, row.display, linkTo(row.sheet), true);
        cell.border = BOX;
        return;
      }
      const v = row.v[c.key];
      cell.value = (v === null || v === "" ? null : v) as never;
      if (FORMAT[c.kind]) cell.numFmt = FORMAT[c.kind]!;
      cell.font = { ...FONT, color: { argb: c.key.startsWith("h") && c.header.includes("(1") ? GREY : INK } };
      cell.border = BOX;
      cell.alignment = { vertical: "middle", horizontal: c.kind === "text" ? "left" : "center", wrapText: c.key === "note" };
    });
  });
  if (N > 0) ws.autoFilter = { from: { row: headRow, column: 1 }, to: { row: lastRow, column: DASH_COLS.length } };
  // status colours on the table
  if (N > 0) {
    ws.addConditionalFormatting({ ref: `${colLetter("absent")}${first}:${colLetter("absent")}${lastRow}`, rules: [{ type: "cellIs", operator: "greaterThan", formulae: [0], priority: 1, style: { font: { color: { argb: "FF991B1B" }, bold: true }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFECACA" } } } }] });
    ws.addConditionalFormatting({ ref: `${colLetter("late")}${first}:${colLetter("late")}${lastRow}`, rules: [{ type: "cellIs", operator: "greaterThan", formulae: [0], priority: 1, style: { font: { color: { argb: "FF92400E" } }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFEF3C7" } } } }] });
    ws.addConditionalFormatting({ ref: `${colLetter("blocked")}${first}:${colLetter("blocked")}${lastRow}`, rules: [{ type: "cellIs", operator: "greaterThan", formulae: [0], priority: 1, style: { font: { color: { argb: "FF92400E" } }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFDE68A" } } } }] });
    ws.addConditionalFormatting({ ref: `${colLetter("rejected")}${first}:${colLetter("rejected")}${lastRow}`, rules: [{ type: "cellIs", operator: "greaterThan", formulae: [0], priority: 1, style: { font: { color: { argb: "FF991B1B" } }, fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFECACA" } } } }] });
    ws.addConditionalFormatting({ ref: `${colLetter("avg")}${first}:${colLetter("avg")}${lastRow}`, rules: [{ type: "colorScale", priority: 1, cfvo: [{ type: "num", value: 1 }, { type: "num", value: 3 }, { type: "num", value: 5 }], color: [{ argb: "FFFECACA" }, { argb: "FFFEF3C7" }, { argb: "FFBBF7D0" }] }] });
  }

  // ---- summary tiles (SUBTOTAL formulas: they follow the table's filters) ----
  const colSum = (k: DashKey) => rows.reduce((n, r) => n + (typeof r.v[k] === "number" ? (r.v[k] as number) : 0), 0);
  const range = (k: DashKey) => `${colLetter(k)}${first}:${colLetter(k)}${lastRow}`;
  type Tile = { label: string; kind: Kind; formula: string; result: number };
  const sub = (k: DashKey, label: string, kind: Kind = "int"): Tile => ({ label, kind, formula: `SUBTOTAL(109,${range(k)})`, result: kind === "decimal" ? round2(colSum(k)) : colSum(k) });
  const tiles: Tile[] = [
    { label: "Total employees", kind: "int", formula: `SUBTOTAL(103,${range("name")})`, result: N },
    sub("hActive", "Active employees"), sub("hPresent", "Employees present (at least one day)"), sub("hAbsent", "Employees absent (at least one day)"),
    sub("workHrs", "Total working hours (h)", "decimal"), sub("prodHrs", "Total productive hours (h)", "decimal"),
    sub("breakHrs", "Total break hours (h)", "decimal"), sub("meetHrs", "Meeting participation (h)", "decimal"), sub("leave", "Total leave days", "decimal"), sub("late", "Late arrivals"),
    sub("lateRemarks", "Late remarks"), sub("submitted", "Tasks submitted"),
    sub("completed", "Tasks completed"), sub("pending", "Tasks pending approval"), sub("approved", "Tasks approved"), sub("rejected", "Tasks rejected"), sub("blocked", "Tasks blocked"),
    sub("present", "Total days present"),
  ];
  tiles.forEach((t, i) => {
    const band = Math.floor(i / 6);
    const slot = i % 6;
    const c1 = columnLetter(slot * 2);
    const c2 = columnLetter(slot * 2 + 1);
    const lr = 5 + band * 3;
    const vr = lr + 1;
    ws.mergeCells(`${c1}${lr}:${c2}${lr}`);
    ws.mergeCells(`${c1}${vr}:${c2}${vr}`);
    put(ws, `${c1}${lr}`, t.label, { bold: true, size: 9, color: GREY, fill: TILE, align: "center", wrap: true });
    put(ws, `${c1}${vr}`, { formula: t.formula, result: t.result }, { bold: true, size: 20, color: INK, fill: TILE, align: "center", numFmt: FORMAT[t.kind] });
    ws.getCell(`${c2}${lr}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: TILE } };
    ws.getCell(`${c2}${vr}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: TILE } };
    ws.getRow(lr).height = 26;
    ws.getRow(vr).height = 36;
  });

  // ---- notes under the table, then the helper table for the rating chart ----
  let r = lastRow + 2;
  put(ws, `A${r}`, "How to read this sheet", { bold: true, color: BRAND });
  [
    "Hours, attendance, tasks, ratings, meetings and leave are the HRMS's own recorded figures for the selected period. No productivity percentage or new formula is added.",
    "Employees can have different numbers of working days (joined during the period, on leave, days not tracked). Compare people using the 'Working days in period' column, not raw totals.",
    "A blank cell means nothing was recorded (for example no attendance record); a 0 means records exist and the count is zero. Average rating uses only tasks a manager actually rated.",
    "Meeting participation and Team Huddle time are inside productive hours; break time is separate. Tasks deleted by a manager are not counted anywhere.",
  ].forEach((line, i) => put(ws, `A${r + 1 + i}`, line, { color: GREY, size: 10 }));
  r += 7;

  const ratedList = rows.filter((x) => typeof x.v.avg === "number").sort((a, b) => (b.v.avg as number) - (a.v.avg as number) || a.display.localeCompare(b.display));
  const helperHead = r + 1;
  put(ws, `A${r}`, "Employees with rated tasks (feeds the rating chart: only employees who were actually rated)", { bold: true, color: BRAND });
  ["Employee", "Average rating", "Tasks rated"].forEach((h, i) => {
    const cell = ws.getRow(helperHead).getCell(i + 1);
    cell.value = h;
    headerStyle(cell);
  });
  ratedList.forEach((x, i) => {
    const rn = helperHead + 1 + i;
    put(ws, `A${rn}`, x.display, { border: true });
    put(ws, `B${rn}`, x.v.avg, { align: "center", numFmt: "0.00", border: true });
    put(ws, `C${rn}`, x.v.rated, { align: "center", numFmt: "0", border: true });
  });
  if (ratedList.length === 0) put(ws, `A${helperHead + 1}`, "No task was rated in this period, so there is no rating chart.", { italic: true, color: GREY });
  const helperLast = helperHead + Math.max(1, ratedList.length);

  // ---- the eight charts ----
  const SH = quoteSheet("Dashboard");
  const catRef = `${SH}!$A$${first}:$A$${lastRow}`;
  const cats = rows.map((x) => x.display);
  const series = (k: DashKey, name: string, color: string): ChartSeries => ({
    name, nameRef: `${SH}!$${colLetter(k)}$${headRow}`, catRef, valRef: `${SH}!$${colLetter(k)}$${first}:$${colLetter(k)}$${lastRow}`, categories: cats,
    values: rows.map((x) => (typeof x.v[k] === "number" ? (x.v[k] as number) : null)), color,
  });
  const forPeriod = (t: string) => `${t}  ·  ${dayLabel(data.from)} to ${dayLabel(data.to)}`;
  const chartTop = helperLast + 3;
  put(ws, `A${chartTop - 1}`, "Charts (they use the table above and follow its filters)", { bold: true, size: 14, color: BRAND });
  const pxHeight = (count: number) => Math.max(300, 24 * count + 140);
  const rowsFor = (px: number) => Math.ceil(px / 20);
  type Def = Omit<ChartSpec, "anchor">;
  const defs: Def[] = [
    { title: forPeriod("Attendance by employee"), stacked: true, categoryTitle: "Employee", valueTitle: "Days (present, half days, absent, leave)", series: [series("present", "Days present", COLORS.green), series("half", "Half days", COLORS.amber), series("absent", "Days absent", COLORS.red), series("leave", "Leave days", COLORS.sky)] },
    { title: forPeriod("Working hours vs productive hours"), stacked: false, categoryTitle: "Employee", valueTitle: "Hours", series: [series("workHrs", "Working hours (h)", COLORS.indigo), series("prodHrs", "Productive hours (h)", COLORS.green)] },
    { title: forPeriod("Task completion"), stacked: false, categoryTitle: "Employee", valueTitle: "Tasks", series: [series("submitted", "Tasks submitted", COLORS.slate), series("completed", "Tasks completed", COLORS.green)] },
    { title: forPeriod("Pending vs approved vs rejected tasks"), stacked: true, categoryTitle: "Employee", valueTitle: "Tasks", series: [series("pending", "Pending approval", COLORS.amber), series("approved", "Tasks approved", COLORS.green), series("rejected", "Tasks rejected", COLORS.red)] },
    { title: forPeriod("Break hours"), stacked: false, categoryTitle: "Employee", valueTitle: "Hours", series: [series("breakHrs", "Break hours (h)", COLORS.amber)] },
    { title: forPeriod("Meeting participation"), stacked: false, categoryTitle: "Employee", valueTitle: "Hours", series: [series("meetHrs", "Meeting participation (h)", COLORS.indigo)] },
    { title: forPeriod("Leave summary"), stacked: false, categoryTitle: "Employee", valueTitle: "Leave days", series: [series("leave", "Leave days", COLORS.sky)] },
  ];
  const specs: ChartSpec[] = [];
  let top = chartTop;
  const place = (d: Def, count: number, left: boolean, rowTop: number, rowsHigh: number): ChartSpec => ({
    ...d, anchor: left ? { fromCol: 0, fromRow: rowTop - 1, toCol: 6, toRow: rowTop - 1 + rowsHigh } : { fromCol: 6, fromRow: rowTop - 1, toCol: 16, toRow: rowTop - 1 + rowsHigh },
  });
  if (N > 0) {
    const high = rowsFor(pxHeight(N));
    for (let i = 0; i < defs.length; i += 2) {
      specs.push(place(defs[i], N, true, top, high));
      if (defs[i + 1]) specs.push(place(defs[i + 1], N, false, top, high));
      top += high + 2;
    }
    // the rating chart reads only the rated employees
    if (ratedList.length > 0) {
      const hc = `${SH}!$A$${helperHead + 1}:$A$${helperHead + ratedList.length}`;
      const rating: Def = {
        title: forPeriod("Average task rating (rated employees only)"), stacked: false, categoryTitle: "Employee", valueTitle: "Average stars (1-5), rated tasks only", valueMax: 5,
        series: [{ name: "Average rating", nameRef: `${SH}!$B$${helperHead}`, catRef: hc, valRef: `${SH}!$B$${helperHead + 1}:$B$${helperHead + ratedList.length}`, categories: ratedList.map((x) => x.display), values: ratedList.map((x) => x.v.avg as number), color: COLORS.indigo }],
      };
      specs.push(place(rating, ratedList.length, true, top, rowsFor(pxHeight(ratedList.length))));
    }
  }

  // ---- one sheet per employee ----
  rows.forEach((row, i) => {
    const es = wb.addWorksheet(row.sheet);
    writeEmployeeSheet(es, data, ix, row, i + 1, first + i);
  });

  // ---- report info ----
  const inf = wb.addWorksheet("Report info");
  inf.columns = [{ width: 32 }, { width: 70 }];
  const lines: [string, string | number][] = [
    ["Report", info.reportName], ["Period", period], ...info.filters.map(([k, v]) => [k, v] as [string, string]), ["Exported on", `${stampLabel(info.exportedAt, tz)} (${tz})`],
    ...(info.exportedBy ? ([["Exported by", info.exportedBy]] as [string, string][]) : []),
    ["Employees included", N], ["Employees in your authorised scope", data.scope.orgTotal], ["Employee sheets", N],
    ["Where the numbers come from", "The HRMS attendance, task, break, meeting and leave records for the period. Nothing is recalculated and nothing was changed by this export."],
    ["Hours", "Working, productive, break, washroom and Team Huddle hours are the attendance engine's daily values (rounded to 0.01 h), so a total can differ from the stored seconds by a few seconds per day."],
    ["Blank and zero", "A blank cell means nothing was recorded. A zero means records exist and the count is zero."],
    ["Ratings", "Averages use only tasks a manager rated. Unrated tasks are never counted as 0 or as 5 stars."],
    ["Deleted tasks", "Tasks a manager deleted are not counted in any figure here."],
  ];
  lines.forEach(([k, v], i) => {
    put(inf, `A${i + 1}`, k, { bold: true, border: true });
    put(inf, `B${i + 1}`, v, { border: true, wrap: true });
  });

  const buffer = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  return addChartsToWorkbook(buffer, "sheet1.xml", specs);
}

/** Builds the workbook and starts the browser download. */
export async function downloadDashboardWorkbook(filename: string, data: TeamReportData, info: DashboardInfo) {
  const buffer = await buildDashboardWorkbook(data, info);
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
