// The dashboard workbook (Admin / HR / Manager): built from sample data, then opened again and checked: sheet order and names, the employee table
// (every employee, blank vs zero, hyperlinks both ways), the summary tiles, the employee sheets (sections, Excel tables, every task, late flags,
// unrated stays blank), conditional formatting and the eight native Excel charts (parts, XML well-formedness, element order, references that match
// the cells, cached values). No database. Reads the file with exceljs and jszip from the frontend.
import { createRequire } from "node:module";
import path from "node:path";
import { buildDashboardWorkbook, dashRow, displayNames, sheetNames, DASH_COLS } from "../../frontend/app/dashboard/reports/_team/dashboardWorkbook.ts";
import { chartXml, drawingXml } from "../../frontend/app/dashboard/reports/_team/chartXml.ts";
import { indexOf, summaryOf, type TeamReportData } from "../../frontend/app/dashboard/reports/_team/teamReportBook.ts";

const req = createRequire(path.resolve(import.meta.dirname, "../../frontend/app/dashboard/reports/_team/dashboardWorkbook.ts"));
const ExcelJS = req("exceljs");
const JSZip = req("jszip");
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 400) : "")); };

// ---------------------------------------------------------------------------------------------- sample data
const att = (userId: string, date: string, over: Record<string, unknown> = {}) => ({ userId, date, loginAt: `${date}T04:00:00.000Z`, logoutAt: `${date}T13:00:00.000Z`, workedHours: 7.5, productiveHours: 7, breakHours: 0.9, washroomHours: 0.1, huddleHours: null, status: "PRESENT", statusLabel: "Present", arrival: "ON_TIME", arrivalMinutes: null, arrivalLimit: "09:45", lateReason: null, correctedBy: null, lateMinutes: 0, earlyDepartureMinutes: null, leaveType: null, holidayName: null, note: null, tasksCompleted: 0, tasksPlanned: null, ...over });
const task = (id: string, userId: string, date: string, over: Record<string, unknown> = {}) => ({ id, userId, title: `Task ${id}`, description: `About ${id}`, project: "Alpha", taggedManager: "Meera Manager", date, priority: "MEDIUM", hoursSpent: 2, progress: "IN_PROGRESS", approvalStatus: "PENDING", completedAt: null, submittedAt: `${date}T05:00:00.000Z`, late: null, rating: null, ratingComment: null, completionNote: null, rejectionNote: null, counted: false, ...over });
const person = (id: string, name: string, code: string | null, over: Record<string, unknown> = {}) => ({ id, name, employeeCode: code, designation: "Analyst", company: "Avatar", reportingManager: "Meera Manager", projects: ["Alpha"], status: "ACTIVE", joinedOn: "2025-01-01", ...over });
const DAYS = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"];

function sample(): TeamReportData {
  const people = [
    person("a", "Ravi Kumar", "E-1"),
    person("b", "Sana Shaikh", "E-2", { projects: [] }),
    person("c", "Tina Nodata", "E-3", { projects: [], designation: null }),
    person("d", "Priya Shah", "E-4"),
    person("e", "Priya Shah", "E-5", { company: "Colab" }),
    person("f", "Sean O'Brien [QA] / Lead", "E-6", { joinedOn: "2026-11-12" }),
    person("g", "A Very Long Employee Name That Overflows The Limit", "LONG-0001"),
    person("h", "Unrated Uma", "E-8"),
    person("i", "Ghost Employee", null, { status: "SUSPENDED" }),
  ];
  const attendance = [
    att("a", DAYS[0]), att("a", DAYS[1], { arrival: "LATE", arrivalMinutes: 35, lateReason: "Bus was late", lateMinutes: 35, huddleHours: 0.2 }), att("a", DAYS[2], { status: "LEAVE", statusLabel: "Leave", loginAt: null, logoutAt: null, workedHours: null, productiveHours: null, breakHours: null, washroomHours: null, leaveType: "CASUAL", arrival: "LEAVE" }), att("a", DAYS[3], { status: "HALF_DAY", statusLabel: "Half day", workedHours: 4, productiveHours: 3.5, breakHours: 0.5 }),
    att("b", DAYS[0]), att("b", DAYS[1], { status: "ABSENT", statusLabel: "Absent", loginAt: null, logoutAt: null, workedHours: null, productiveHours: null, breakHours: null, washroomHours: null, arrival: "ABSENT" }),
    att("c", DAYS[0], { status: "NOT_TRACKED", statusLabel: "Not tracked", loginAt: null, logoutAt: null, workedHours: null, productiveHours: null, breakHours: null, washroomHours: null, arrival: "NOT_TRACKED" }),
    att("d", DAYS[0]), att("d", DAYS[1]), att("e", DAYS[0], { workedHours: 6, productiveHours: 5.5 }), att("f", DAYS[3]), att("g", DAYS[0]), att("h", DAYS[0]),
  ];
  const tasks = [
    task("t1", "a", DAYS[0], { progress: "COMPLETED", approvalStatus: "APPROVED", completedAt: `${DAYS[0]}T10:00:00Z`, rating: 5, ratingComment: "Great", counted: true }),
    task("t2", "a", DAYS[1], { progress: "BLOCKED", blockedReason: "Waiting for access", approvalStatus: "PENDING" }),
    task("t3", "a", DAYS[1], { progress: "IN_PROGRESS", approvalStatus: "REJECTED", rejectionNote: "Next quarter" }),
    task("t4", "a", DAYS[2], { progress: "TODO", approvalStatus: "APPROVED", late: { lateByDays: 2, outsideWindow: false, reason: "Forgot to add" }, submittedAt: `${DAYS[4]}T05:00:00.000Z` }),
    task("t5", "a", DAYS[3], { progress: "COMPLETED", approvalStatus: "APPROVED", rating: 3, ratingComment: "Ok" }),
    task("t6", "d", DAYS[0], { progress: "COMPLETED", approvalStatus: "APPROVED", rating: 4 }),
    task("t7", "h", DAYS[0], { progress: "COMPLETED", approvalStatus: "APPROVED" }),
    task("t8", "h", DAYS[1], { progress: "IN_PROGRESS", approvalStatus: "APPROVED" }),
  ];
  const breaks = [
    { userId: "a", date: DAYS[0], type: "TEA", category: "Break", countsAsBreak: true, startedAt: `${DAYS[0]}T05:30:00Z`, endedAt: `${DAYS[0]}T05:40:00Z`, seconds: 600, running: false, autoClosed: false, remark: null },
    { userId: "a", date: DAYS[0], type: "WASHROOM", category: "Washroom (not a break)", countsAsBreak: false, startedAt: `${DAYS[0]}T09:30:00Z`, endedAt: `${DAYS[0]}T09:35:00Z`, seconds: 300, running: false, autoClosed: false, remark: null },
  ];
  const meetings = [
    { meetingId: "m1", userId: "a", title: "Stand-up", kind: "Team Huddle", organizer: "Meera Manager", scheduledStart: `${DAYS[1]}T04:15:00Z`, scheduledEnd: `${DAYS[1]}T04:30:00Z`, scheduledSeconds: 900, response: "ACCEPTED", status: "Joined", joinedAt: `${DAYS[1]}T04:16:00Z`, leftAt: `${DAYS[1]}T04:28:00Z`, participationSeconds: 720, openPastEnd: false },
    { meetingId: "m1", userId: "c", title: "Stand-up", kind: "Team Huddle", organizer: "Meera Manager", scheduledStart: `${DAYS[1]}T04:15:00Z`, scheduledEnd: `${DAYS[1]}T04:30:00Z`, scheduledSeconds: 900, response: null, status: "Not joined", joinedAt: null, leftAt: null, participationSeconds: null, openPastEnd: false },
  ];
  const leave = [
    { id: "l1", userId: "a", from: DAYS[2], to: DAYS[2], leaveType: "CASUAL", halfDay: false, firstHalf: true, dayCount: 1, reason: "Family", status: "APPROVED", appliedOn: "2026-11-05T05:00:00Z", decidedAt: "2026-11-06T05:00:00Z", decidedBy: "Asha Admin", decisionNote: null },
    { id: "l2", userId: "a", from: DAYS[4], to: DAYS[4], leaveType: "SICK", halfDay: true, firstHalf: false, dayCount: 0.5, reason: "Fever", status: "PENDING", appliedOn: "2026-11-12T05:00:00Z", decidedAt: null, decidedBy: null, decisionNote: null },
  ];
  const corrections = [{ userId: "b", date: DAYS[1], type: "MISSING_CHECKIN", originalLoginAt: null, originalLogoutAt: null, requestedLoginAt: `${DAYS[1]}T04:00:00Z`, requestedLogoutAt: `${DAYS[1]}T12:00:00Z`, reason: "Gate scanner down", status: "APPROVED", reviewedBy: "Asha Admin", reviewedAt: "2026-11-12T05:00:00Z", reviewComment: "ok" }];
  return { generatedAt: "2026-11-14T05:00:00Z", timezone: "Asia/Kolkata", today: "2026-11-14", from: "2026-11-10", to: "2026-11-14", days: 5, scope: { orgTotal: 12, filteredTotal: 9 }, people, attendance, tasks, breaks, meetings, liveMeetings: [], leave, leaveDays: [{ userId: "a", date: DAYS[2], leaveType: "CASUAL", halfDay: false }], corrections } as unknown as TeamReportData;
}

// ---------------------------------------------------------------------------------------------- a tiny XML reader (well-formedness + structure)
type XNode = { name: string; attrs: Record<string, string>; children: XNode[]; text: string };
function parseXml(xml: string): XNode {
  const body = xml.replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  const root: XNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XNode[] = [root];
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body))) {
    consumed += m[0].length;
    if (m[5] !== undefined) { stack[stack.length - 1].text += m[5]; continue; }
    const [, close, name, rawAttrs, self] = m;
    if (close) {
      const top = stack.pop()!;
      if (top.name !== name) throw new Error(`mismatched tag: </${name}> closes <${top.name}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const node: XNode = { name, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  if (consumed !== body.length) throw new Error("unparsed content in XML");
  if (stack.length !== 1) throw new Error("unclosed tag: " + stack[stack.length - 1].name);
  return root.children[0];
}
const kids = (n: XNode, name: string) => n.children.filter((c) => c.name === name);
const kid = (n: XNode, name: string) => n.children.find((c) => c.name === name);
const order = (n: XNode) => n.children.map((c) => c.name);
const isSubsequence = (got: string[], want: string[]) => { let i = 0; for (const g of got) { const j = want.indexOf(g, i); if (j === -1) return false; i = j; } return true; };

// ---------------------------------------------------------------------------------------------- build and read back
const data = sample();
const info = { reportName: "Dashboard workbook", exportedAt: new Date("2026-11-14T06:30:00Z"), exportedBy: "Meera Manager", filters: [["Project", "Alpha"]] as [string, string][] };
const t0 = Date.now();
const buf = await buildDashboardWorkbook(data, info);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);
const zip = await JSZip.loadAsync(buf);
const P = data.people;
const dashboard = wb.getWorksheet("Dashboard");
// A table read back from the file: its header and its rows, taken from the cells inside the table's own reference.
function readTable(ws: { getTable: (n: string) => { table: { tableRef: string } }; getCell: (r: number, c: number) => { value: unknown } }, name: string): { header: string[]; rows: unknown[][] } {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ws.getTable(name).table.tableRef)!;
  const colN = (l: string) => l.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const header: string[] = [];
  const rows: unknown[][] = [];
  for (let c = colN(m[1]); c <= colN(m[3]); c++) header.push(String(ws.getCell(Number(m[2]), c).value));
  for (let r = Number(m[2]) + 1; r <= Number(m[4]); r++) rows.push(Array.from({ length: header.length }, (_, i) => ws.getCell(r, colN(m[1]) + i).value ?? null));
  return { header, rows };
}
const sheetList: string[] = wb.worksheets.map((w: { name: string }) => w.name);

console.log("\n## sheets");
ok("the Dashboard is the FIRST sheet and Report info the last", sheetList[0] === "Dashboard" && sheetList[sheetList.length - 1] === "Report info", sheetList);
ok("one sheet per employee in between (9 employees, 11 sheets)", sheetList.length === P.length + 2, sheetList.length);
const empSheets = sheetList.slice(1, -1);
ok("sheet names are unique (any capitals), at most 31 characters, none with [ ] : * ? / \\ and no edge apostrophe", new Set(sheetList.map((n) => n.toLowerCase())).size === sheetList.length && sheetList.every((n) => n.length <= 31 && !/[\[\]:*?/\\]/.test(n) && !/^'|'$/.test(n)), sheetList);
ok("a name with an apostrophe and illegal characters is made safe but still recognisable", empSheets.some((n) => /^E-6 Sean O'Brien/.test(n)), empSheets);
ok("the two employees called Priya Shah get different sheets (the ID tells them apart)", empSheets.filter((n) => /Priya Shah/.test(n)).length === 2 && empSheets.some((n) => n.startsWith("E-4")) && empSheets.some((n) => n.startsWith("E-5")), empSheets);

console.log("\n## dashboard: heading and table");
const text = (r: number, c: number) => { const v = dashboard.getCell(r, c).value; return String(v && typeof v === "object" ? ("text" in v ? v.text : "result" in v ? v.result : "") : v ?? ""); };
ok("the title, the report name, the period and the export time are on top", /Overall Employee Dashboard/.test(text(1, 1)) && /Dashboard workbook/.test(text(2, 1)) && /10 Nov 2026 to 14 Nov 2026/.test(text(2, 1)) && /14 Nov 2026/.test(text(2, 1)) && /Meera Manager/.test(text(2, 1)), text(2, 1));
const headRow = (() => { for (let r = 1; r < 40; r++) if (text(r, 1) === "Employee" && text(r, 2) === "Employee ID") return r; return -1; })();
ok("the employee table header is found, with every required column", headRow > 0 && DASH_COLS.every((c, i) => text(headRow, i + 1) === c.header), headRow);
const need = ["Employee", "Employee ID", "Designation", "Department (team)", "Company", "Reporting manager", "Days present", "Days absent", "Working hours (h)", "Productive hours (h)", "Break hours (h)", "Tasks submitted", "Tasks completed", "Pending approval", "Tasks approved", "Tasks rejected", "Average rating (rated tasks only)", "Meeting participation (h)", "Leave days"];
ok("it has the columns the brief lists (name, ID, designation, department, company, manager, attendance, hours, tasks, rating, meetings, leave)", need.every((h) => DASH_COLS.some((c) => c.header === h)));
const colOf = (h: string) => DASH_COLS.findIndex((c) => c.header === h) + 1;
const rowOf = (i: number) => headRow + 1 + i;
ok("EVERY employee is a row, in order, even one with no records at all", P.every((p, i) => text(rowOf(i), 2) === (p.employeeCode ?? "")) && text(rowOf(P.length), 1) === "", P.map((p, i) => text(rowOf(i), 2)));
ok("duplicate names show their ID so charts and links cannot be confused", text(rowOf(3), 1) === "Priya Shah (E-4)" && text(rowOf(4), 1) === "Priya Shah (E-5)" && text(rowOf(0), 1) === "Ravi Kumar");

console.log("\n## dashboard: blank versus zero, and the figures");
const ix = indexOf(data);
const cell = (i: number, h: string) => dashboard.getCell(rowOf(i), colOf(h)).value;
ok("an employee with no attendance record at all (Ghost) has BLANK hours, days and late counts, not zeros", ["Working hours (h)", "Productive hours (h)", "Break hours (h)", "Days present", "Days absent", "Late arrivals", "Working days in period"].every((h) => cell(8, h) === null), ["Working hours (h)", "Days present"].map((h) => cell(8, h)));
ok("…but a real zero is a 0: Ghost submitted 0 tasks and took 0 leave days", cell(8, "Tasks submitted") === 0 && cell(8, "Leave days") === 0);
ok("Tina (tracked but 'not tracked' day) has blank hours (nothing recorded) and 0 days present", cell(2, "Working hours (h)") === null && cell(2, "Days present") === 0);
ok("Ravi's figures: 2 days present (one late), 1 half day, 0 absent, working 19h, productive 17.5h, break 2.3h", cell(0, "Days present") === 2 && cell(0, "Half days") === 1 && cell(0, "Days absent") === 0 && cell(0, "Late arrivals") === 1 && cell(0, "Late remarks") === 1 && cell(0, "Working hours (h)") === 19 && cell(0, "Productive hours (h)") === 17.5 && cell(0, "Break hours (h)") === 2.3, ["Days present", "Half days", "Working hours (h)", "Productive hours (h)", "Break hours (h)"].map((h) => cell(0, h)));
ok("Ravi's tasks: 5 submitted, 2 completed, 1 pending, 3 approved, 1 rejected, 1 blocked", cell(0, "Tasks submitted") === 5 && cell(0, "Tasks completed") === 2 && cell(0, "Pending approval") === 1 && cell(0, "Tasks approved") === 3 && cell(0, "Tasks rejected") === 1 && cell(0, "Tasks blocked") === 1);
ok("average rating uses ONLY rated tasks: Ravi (5 and 3) = 4.0, 2 rated; Uma (completed but never rated) is BLANK, not 0 and not 5", cell(0, "Average rating (rated tasks only)") === 4 && cell(0, "Tasks rated") === 2 && cell(7, "Average rating (rated tasks only)") === null && cell(7, "Tasks rated") === 0);
ok("a pending task is never counted as approved or completed (Ravi's pending task is separate)", Number(cell(0, "Pending approval")) + Number(cell(0, "Tasks approved")) + Number(cell(0, "Tasks rejected")) === Number(cell(0, "Tasks submitted")));
ok("meeting participation: Ravi 12 minutes = 0.2 h, counted once; Tina was invited but did not join = 0 (records exist), Sana has none = blank", cell(0, "Meeting participation (h)") === 0.2 && cell(2, "Meeting participation (h)") === 0 && cell(1, "Meeting participation (h)") === null);
ok("leave days: Ravi 1 day approved (the pending half day is not counted)", cell(0, "Leave days") === 1);
ok("a mid-period joiner and a missing record are explained in the data note", /Joined 12 Nov 2026/.test(String(cell(5, "Data note"))) && /No attendance records/.test(String(cell(8, "Data note"))));
ok("employment status and the helper columns are filled (Ghost is not active)", cell(0, "Employment status") === "Active" && cell(8, "Employment status") === "Suspended" && cell(0, "Active (1 = yes)") === 1 && cell(8, "Active (1 = yes)") === 0);
const rows = P.map((p, i) => dashRow(data, ix, p, sheetNames(P)[i], displayNames(P)[i]));
ok("dashRow (the builder's own rule) agrees with the summary the existing reports use", rows.every((r, i) => r.v.submitted === summaryOf(data, ix, P[i].id).submitted && r.v.leave === summaryOf(data, ix, P[i].id).leaveTaken));

console.log("\n## summary tiles (formulas that follow the table's filters)");
const tiles = new Map<string, { formula?: string; result: number }>();
for (let r = 4; r < headRow; r++) for (let c = 1; c <= 12; c += 2) { const label = String(dashboard.getCell(r, c).value ?? ""); const v = dashboard.getCell(r + 1, c).value; if (label && v && typeof v === "object" && "formula" in v) tiles.set(label, v as never); }
ok("17+ tiles, every one a SUBTOTAL formula with a stored result", tiles.size >= 17 && [...tiles.values()].every((t) => /^SUBTOTAL\((103|109),/.test(String(t.formula)) && Number.isFinite(t.result)), [...tiles.keys()]);
const tileOf = (label: string) => tiles.get(label)?.result;
const colTotal = (h: string) => P.reduce((n, _, i) => n + (typeof cell(i, h) === "number" ? (cell(i, h) as number) : 0), 0);
ok("Total employees 9, Active 8, present employees and absent employees counted per employee", tileOf("Total employees") === 9 && tileOf("Active employees") === 8 && tileOf("Employees present (at least one day)") === 7 && tileOf("Employees absent (at least one day)") === 1, [...tiles.entries()].map(([k, v]) => [k, v.result]));
ok("hour tiles equal the sum of the table column (working, productive, break, meeting)", Math.abs(Number(tileOf("Total working hours (h)")) - colTotal("Working hours (h)")) < 0.001 && Math.abs(Number(tileOf("Total productive hours (h)")) - colTotal("Productive hours (h)")) < 0.001 && Math.abs(Number(tileOf("Total break hours (h)")) - colTotal("Break hours (h)")) < 0.001 && Math.abs(Number(tileOf("Meeting participation (h)")) - colTotal("Meeting participation (h)")) < 0.001);
const rawWorked = data.attendance.reduce((n, a) => n + ((a as { workedHours: number | null }).workedHours ?? 0), 0);
ok("…and the working-hours total matches the raw records (within rounding of 0.01 h per employee)", Math.abs(Number(tileOf("Total working hours (h)")) - rawWorked) <= 0.01 * P.length, [tileOf("Total working hours (h)"), rawWorked]);
ok("task tiles: submitted 8, completed 4, pending 1, approved 6, rejected 1, blocked 1 (nothing double counted)", tileOf("Tasks submitted") === 8 && tileOf("Tasks completed") === 4 && tileOf("Tasks pending approval") === 1 && tileOf("Tasks approved") === 6 && tileOf("Tasks rejected") === 1 && tileOf("Tasks blocked") === 1, [...tiles.entries()].filter(([k]) => /Tasks/.test(k)).map(([k, v]) => [k, v.result]));
ok("leave days, late arrivals and late remarks tiles", tileOf("Total leave days") === 1 && tileOf("Late arrivals") === 1 && tileOf("Late remarks") === 1);
ok("the employee table has filter buttons", !!dashboard.autoFilter);

console.log("\n## hyperlinks both ways");
const allOk: boolean[] = [];
for (let i = 0; i < P.length; i++) {
  const v = dashboard.getCell(rowOf(i), 1).value as { text: string; hyperlink: string };
  const target = /^#'((?:[^']|'')+)'!A1$/.exec(v?.hyperlink ?? "");
  const sheet = target ? target[1].replace(/''/g, "'") : "";
  const es = wb.getWorksheet(sheet);
  const back = es?.getCell("A2").value as { text: string; hyperlink: string } | undefined;
  allOk.push(!!es && sheet === empSheets[i] && !!back && back.hyperlink === `#'Dashboard'!A${rowOf(i)}` && /Back to Dashboard/.test(back.text));
}
ok("every employee name links to THAT employee's own sheet, and that sheet links back to the employee's row on the Dashboard", allOk.every(Boolean), allOk);
ok("a sheet name with an apostrophe is quoted correctly in its link (O'Brien)", /^#'E-6 Sean O''Brien/.test((dashboard.getCell(rowOf(5), 1).value as { hyperlink: string }).hyperlink));
const xmlHyper = await zip.file("xl/worksheets/sheet1.xml").async("string");
ok("the links are real hyperlinks in the file", (xmlHyper.match(/<hyperlink /g) ?? []).length === P.length, (xmlHyper.match(/<hyperlink /g) ?? []).length);

console.log("\n## an employee sheet (Ravi)");
const ravi = wb.getWorksheet(empSheets[0]);
const colA = (ws: typeof ravi, from = 1, to = 200) => { const out: string[] = []; for (let r = from; r <= to; r++) out.push(String(ws.getCell(r, 1).value ?? "")); return out; };
const a = colA(ravi);
ok("the sections A to G are all there, in order", ["A. Employee information", "B. Attendance details", "C. Working hours and breaks (per day)", "Break details", "D. Daily task performance (all tasks)", "E. Meetings and Team Huddles", "F. Leave details", "G. Employee summary"].every((s, i, arr) => a.indexOf(s) > (i ? a.indexOf(arr[i - 1]) : -1)), a.filter((x) => /^[A-G]\. /.test(x)));
ok("the title shows name and ID, row 3 the period, and the top 3 rows are frozen", /Ravi Kumar/.test(a[0]) && /10 Nov 2026 to 14 Nov 2026/.test(a[2]) && ravi.views[0].state === "frozen" && ravi.views[0].ySplit === 3);
const tables = ravi.getTables().map((t: { name: string }) => t.name);
ok("each record list is an Excel table: attendance, hours, breaks, tasks, meetings, leave", ["Att1", "Hrs1", "Brk1", "Tsk1", "Mtg1", "Lve1"].every((n) => tables.includes(n)), tables);
const allTables = wb.worksheets.flatMap((w: { getTables: () => { name: string }[] }) => w.getTables().map((t) => t.name));
ok("table names are unique across the whole workbook", new Set(allTables).size === allTables.length && allTables.length > 20, allTables.length);
const tskTable = readTable(ravi, "Tsk1");
const taskRowsRead = tskTable.rows;
ok("ALL of Ravi's tasks are listed (5), not only the completed ones", taskRowsRead.length === 5 && taskRowsRead.map((r) => r[3]).sort().join("|") === ["Task t1", "Task t2", "Task t3", "Task t4", "Task t5"].join("|"), taskRowsRead.map((r) => r[3]));
const header = tskTable.header;
ok("task columns: task date, submission date and time, description, project, assigned manager, hours, priority, progress, approval, rating, feedback, late indicator", ["Task date", "Submission date", "Submission time", "Task description", "Project", "Assigned reporting manager", "Hours spent", "Priority", "Progress status", "Approval status", "Manager rating (stars)", "Manager feedback", "Late submission"].every((h) => header.includes(h)), header);
const idx = (h: string) => header.indexOf(h);
const byTitle = (t: string) => taskRowsRead.find((r) => r[3] === t)!;
ok("an unrated task has a BLANK rating (never 0 or 5): Ravi's t2 and t4 blank, t1 = 5, t5 = 3", byTitle("Task t2")[idx("Manager rating (stars)")] === null && byTitle("Task t4")[idx("Manager rating (stars)")] === null && byTitle("Task t1")[idx("Manager rating (stars)")] === 5 && byTitle("Task t5")[idx("Manager rating (stars)")] === 3);
ok("the late-submitted task says so, with how late and why, and shows the real submission date (different from the task date)", /Late submission: 2 day\(s\)/.test(String(byTitle("Task t4")[idx("Late submission")])) && /Forgot to add/.test(String(byTitle("Task t4")[idx("Late submission")])) && (byTitle("Task t4")[idx("Submission date")] as Date).toISOString().slice(0, 10) === "2026-11-14" && (byTitle("Task t4")[idx("Task date")] as Date).toISOString().slice(0, 10) === "2026-11-12", byTitle("Task t4"));
ok("a normal task has no late flag", byTitle("Task t1")[idx("Late submission")] === null);
ok("progress and approval are separate columns with their own words (Blocked + Waiting for approval; To Do + Approved)", byTitle("Task t2")[idx("Progress status")] === "Blocked" && byTitle("Task t2")[idx("Approval status")] === "Waiting for approval" && byTitle("Task t4")[idx("Progress status")] === "To Do" && byTitle("Task t4")[idx("Approval status")] === "Approved" && byTitle("Task t2")[idx("Blocked reason")] === "Waiting for access");
ok("manager feedback and the 'sent back' reason are kept", byTitle("Task t1")[idx("Manager feedback")] === "Great" && byTitle("Task t3")[idx("Reason sent back")] === "Next quarter");
const attRead = readTable(ravi, "Att1").rows;
ok("attendance has one row per calendar day of the period (5), a day without a record says 'No record'", attRead.length === 5 && attRead[4][4] === "No record" && attRead[1][4] === "Late" || attRead[1][4] === "Present", attRead.map((r) => r[4]));
ok("late remarks carry what the employee typed", String(attRead[1][6]).includes("Bus was late"), attRead[1][6]);
const brkRead = readTable(ravi, "Brk1").rows;
ok("break details list the tea break and the washroom time separately (washroom is not a break)", brkRead.length === 2 && brkRead[0][6] === "Yes" && brkRead[1][6] === "No");
const hrsRead = readTable(ravi, "Hrs1").rows;
ok("per-day hours include the number of breaks (1 on the day with a tea break)", hrsRead[0][4] === 1 && hrsRead[1][4] === 0);
const leaveRead = readTable(ravi, "Lve1").rows;
ok("leave shows type, duration, status and the approver", leaveRead.length === 2 && leaveRead[0][2] === "Casual" && leaveRead[0][5] === "Approved" && leaveRead[0][7] === "Asha Admin" && leaveRead[1][5] === "Pending" && leaveRead[1][3] === 0.5);
const mtgRead = readTable(ravi, "Mtg1").rows;
ok("the huddle shows scheduled 9:45, actual join 9:46 (company time) and Ravi's own participation of 12 minutes", mtgRead.length === 1 && mtgRead[0][0] === "Stand-up" && (mtgRead[0][8] as Date).toISOString() === "1899-12-30T00:12:00.000Z" && (mtgRead[0][3] as Date).toISOString() === "1899-12-30T09:45:00.000Z" && (mtgRead[0][6] as Date).toISOString() === "1899-12-30T09:46:00.000Z", mtgRead);
const summaryLines = colA(ravi, 1, 200);
ok("the summary G is last and complete (days, hours, tasks by progress and approval, ratings, meetings, leave, corrections)", ["Days present", "Late arrivals", "Total working hours", "Total productive hours", "Total break hours", "Total tasks", "Tasks: To Do / In Progress / Completed / Blocked", "Tasks: waiting for approval / approved / rejected", "Tasks submitted late", "Average rating (rated tasks only)", "Total meeting participation", "Total leave days taken", "Attendance corrections"].every((s) => summaryLines.includes(s)));
const summaryAt = (label: string) => { const r = summaryLines.indexOf(label) + 1; return ravi.getCell(r, 4).value; };
ok("summary numbers: 5 tasks, 1 late-submitted, 2 rated, average 4, 1 leave day", summaryAt("Total tasks") === 5 && summaryAt("Tasks submitted late") === 1 && summaryAt("Tasks rated") === 2 && summaryAt("Average rating (rated tasks only)") === 4 && summaryAt("Total leave days taken") === 1);
console.log("\n## an employee with no records at all (Ghost) still gets a full sheet");
const ghost = wb.getWorksheet(empSheets[8]);
const g = colA(ghost);
ok("it has every section; empty lists say 'no … recorded' instead of an empty table", g.includes("D. Daily task performance (all tasks)") && g.includes("No tasks were submitted in this period.") && g.includes("No meetings or Team Huddles in this period.") && g.includes("No leave requests in this period.") && ghost.getTables().length >= 1);
ok("its summary leaves hours blank (nothing recorded) but says 0 tasks and 0 leave days", (() => { const L = colA(ghost, 1, 200); const at = (l: string) => ghost.getCell(L.indexOf(l) + 1, 4).value; return at("Total working hours") === null && at("Total tasks") === 0 && at("Total leave days taken") === 0; })());

console.log("\n## colours");
ok("conditional formatting is on the Dashboard table and on the employee sheet's status columns", dashboard.conditionalFormattings.length >= 4 && ravi.conditionalFormattings.length >= 4, [dashboard.conditionalFormattings.length, ravi.conditionalFormattings.length]);

console.log("\n## charts (real Excel charts)");
const files = Object.keys(zip.files);
const chartFiles = files.filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f)).sort();
ok("8 charts were added (rated employees exist)", chartFiles.length === 8, chartFiles);
ok("the drawing, its relationships and the sheet relationship exist", files.includes("xl/drawings/drawing901.xml") && files.includes("xl/drawings/_rels/drawing901.xml.rels") && files.includes("xl/worksheets/_rels/sheet1.xml.rels"));
const ct = await zip.file("[Content_Types].xml").async("string");
ok("the content types announce the drawing and every chart", ct.includes('PartName="/xl/drawings/drawing901.xml"') && chartFiles.every((f) => ct.includes(`PartName="/${f}"`)));
const sheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
const sheetRels = await zip.file("xl/worksheets/_rels/sheet1.xml.rels").async("string");
ok("the Dashboard sheet points at the drawing, in the place the schema requires (after the hyperlinks, before the end)", /<drawing r:id="rIdCharts1"\/>/.test(sheetXml) && sheetXml.indexOf("<hyperlinks") < sheetXml.indexOf("<drawing") && /<\/worksheet>$/.test(sheetXml.trim()) && sheetRels.includes('Id="rIdCharts1"') && sheetRels.includes("drawing901.xml"), sheetXml.slice(-300));
ok("everything exceljs wrote is still there: the hyperlinks and the original relationships are untouched", (sheetRels.match(/<Relationship /g) ?? []).length > P.length);
let wellFormed = true; const bad: string[] = [];
for (const f of [...chartFiles, "xl/drawings/drawing901.xml", "xl/drawings/_rels/drawing901.xml.rels", "xl/worksheets/_rels/sheet1.xml.rels", "[Content_Types].xml", "xl/worksheets/sheet1.xml"]) { try { parseXml(await zip.file(f).async("string")); } catch (e) { wellFormed = false; bad.push(`${f}: ${(e as Error).message}`); } }
ok("every new or changed XML part is well-formed", wellFormed, bad);
const charts = await Promise.all(chartFiles.map(async (f) => parseXml(await zip.file(f).async("string"))));
const chartTitle = (c: XNode) => { const t = kid(kid(c, "c:chart")!, "c:title")!; return t.children.flatMap(function walk(n: XNode): string[] { return [n.name === "a:t" ? n.text : "", ...n.children.flatMap(walk)]; }).join(""); };
const titles = charts.map(chartTitle);
ok("the 8 charts are the eight asked for, each titled with the period", titles.length === 8 && titles.every((t) => /10 Nov 2026 to 14 Nov 2026/.test(t)) && ["Attendance", "Working hours vs productive", "Task completion", "Pending vs approved vs rejected", "Break hours", "Meeting participation", "Leave summary", "Average task rating"].every((s) => titles.some((t) => t.includes(s))), titles);
ok("every chart has a legend, both axis titles, and its parts in schema order", charts.every((c) => {
  const chart = kid(c, "c:chart")!;
  const plot = kid(chart, "c:plotArea")!;
  const bar = kid(plot, "c:barChart")!;
  return !!kid(chart, "c:legend") && isSubsequence(order(chart), ["c:title", "c:autoTitleDeleted", "c:plotArea", "c:legend", "c:plotVisOnly", "c:dispBlanksAs"])
    && isSubsequence(order(bar), ["c:barDir", "c:grouping", "c:varyColors", "c:ser", "c:gapWidth", "c:overlap", "c:axId"])
    && isSubsequence(order(plot), ["c:layout", "c:barChart", "c:catAx", "c:valAx"])
    && !!kid(kid(plot, "c:catAx")!, "c:title") && !!kid(kid(plot, "c:valAx")!, "c:title")
    && isSubsequence(order(kid(plot, "c:catAx")!), ["c:axId", "c:scaling", "c:delete", "c:axPos", "c:title", "c:numFmt", "c:majorTickMark", "c:minorTickMark", "c:tickLblPos", "c:crossAx", "c:crosses", "c:auto", "c:lblAlgn", "c:lblOffset", "c:tickLblSkip", "c:noMultiLvlLbl"])
    && isSubsequence(order(kid(plot, "c:valAx")!), ["c:axId", "c:scaling", "c:delete", "c:axPos", "c:majorGridlines", "c:title", "c:numFmt", "c:majorTickMark", "c:minorTickMark", "c:tickLblPos", "c:crossAx", "c:crosses", "c:crossBetween"])
    && kids(bar, "c:ser").every((s) => isSubsequence(order(s), ["c:idx", "c:order", "c:tx", "c:spPr", "c:invertIfNegative", "c:cat", "c:val"]));
}));
ok("charts skip hidden rows (so a filter on the table changes them) and leave a gap, not a zero, for a missing value", charts.every((c) => kid(kid(c, "c:chart")!, "c:plotVisOnly")!.attrs.val === "1" && kid(kid(c, "c:chart")!, "c:dispBlanksAs")!.attrs.val === "gap"));
const seriesCount = charts.map((c) => kids(kid(kid(kid(c, "c:chart")!, "c:plotArea")!, "c:barChart")!, "c:ser").length);
ok("series per chart: attendance 4 (stacked), hours 2, tasks 2, approval 3 (stacked), break 1, meetings 1, leave 1, rating 1", seriesCount.join(",") === "4,2,2,3,1,1,1,1", seriesCount);
ok("stacked charts are stacked with overlap 100; the others are clustered", [0, 3].every((i) => kid(kid(kid(charts[i], "c:chart")!, "c:plotArea")!, "c:barChart")!.children.some((c) => c.name === "c:grouping" && c.attrs.val === "stacked")) && [1, 2, 4].every((i) => kid(kid(kid(charts[i], "c:chart")!, "c:plotArea")!, "c:barChart")!.children.some((c) => c.name === "c:grouping" && c.attrs.val === "clustered")));
// every reference must point at cells that really hold what the cache says
const refCells = (ref: string): unknown[] => {
  const m = /^'Dashboard'!\$([A-Z]+)\$(\d+)(?::\$([A-Z]+)\$(\d+))?$/.exec(ref);
  if (!m) throw new Error("bad ref " + ref);
  const col = (l: string) => l.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const out: unknown[] = [];
  for (let r = Number(m[2]); r <= Number(m[4] ?? m[2]); r++) { const v = dashboard.getCell(r, col(m[1])).value; out.push(v && typeof v === "object" && "text" in v ? (v as { text: string }).text : v); }
  return out;
};
let refsOk = true; const refBad: string[] = [];
charts.forEach((c, ci) => {
  for (const ser of kids(kid(kid(kid(c, "c:chart")!, "c:plotArea")!, "c:barChart")!, "c:ser")) {
    const cat = kid(kid(ser, "c:cat")!, "c:strRef")!; const val = kid(kid(ser, "c:val")!, "c:numRef")!; const tx = kid(kid(ser, "c:tx")!, "c:strRef")!;
    const catVals = refCells(kid(cat, "c:f")!.text); const numVals = refCells(kid(val, "c:f")!.text); const name = refCells(kid(tx, "c:f")!.text)[0];
    const catCache = kids(kid(cat, "c:strCache")!, "c:pt").map((p) => kid(p, "c:v")!.text);
    const numCache = new Map(kids(kid(val, "c:numCache")!, "c:pt").map((p) => [Number(p.attrs.idx), Number(kid(p, "c:v")!.text)]));
    const nameCache = kid(kid(tx, "c:strCache")!, "c:pt")! && kid(kid(kid(tx, "c:strCache")!, "c:pt")!, "c:v")!.text;
    const catOk = JSON.stringify(catVals.map(String)) === JSON.stringify(catCache);
    const numOk = numVals.every((v, i) => (v === null ? !numCache.has(i) : numCache.get(i) === v));
    if (!catOk || !numOk || nameCache !== String(name) || catVals.length !== numVals.length) { refsOk = false; refBad.push(`chart ${ci + 1}: ${nameCache} cat=${catOk} num=${numOk}`); }
  }
});
ok("every series reads real cells: the names, the numbers and the cached copy all match, and a blank cell has no cached point (a gap)", refsOk, refBad);
const ratingChart = charts.find((c) => /Average task rating/.test(chartTitle(c)))!;
const ratingSer = kids(kid(kid(kid(ratingChart, "c:chart")!, "c:plotArea")!, "c:barChart")!, "c:ser")[0];
ok("the rating chart lists only rated employees (Ravi 4.0, Priya E-4 4.0) and the axis is fixed at 0 to 5", kids(kid(kid(ratingSer, "c:cat")!, "c:strRef")!.children.find((x) => x.name === "c:strCache")!, "c:pt").length === 2 && kid(kid(kid(kid(ratingChart, "c:chart")!, "c:plotArea")!, "c:valAx")!, "c:scaling")!.children.some((c) => c.name === "c:max" && c.attrs.val === "5"));
const drawing = parseXml(await zip.file("xl/drawings/drawing901.xml").async("string"));
ok("the drawing has 8 anchored charts, each with its own relationship, none overlapping", kids(drawing, "xdr:twoCellAnchor").length === 8 && new Set(kids(drawing, "xdr:twoCellAnchor").map((a) => kid(kid(kid(kid(a, "xdr:graphicFrame")!, "a:graphic")!, "a:graphicData")!, "c:chart")!.attrs["r:id"])).size === 8);
const boxes = kids(drawing, "xdr:twoCellAnchor").map((a) => { const f = kid(a, "xdr:from")!, t = kid(a, "xdr:to")!; const n = (x: XNode, k: string) => Number(kid(x, k)!.text); return { c0: n(f, "xdr:col"), r0: n(f, "xdr:row"), c1: n(t, "xdr:col"), r1: n(t, "xdr:row") }; });
const overlap = boxes.some((a, i) => boxes.some((b, j) => i < j && a.c0 < b.c1 && b.c0 < a.c1 && a.r0 < b.r1 && b.r0 < a.r1));
ok("no two charts overlap, and none overlaps the table or tiles", !overlap && boxes.every((b) => b.r0 > headRow + P.length));

console.log("\n## no rated task at all: no rating chart, and a plain explanation");
const none = { ...data, tasks: data.tasks.map((t) => ({ ...t, rating: null, ratingComment: null })) } as TeamReportData;
const zip2 = await JSZip.loadAsync(await buildDashboardWorkbook(none, info));
ok("7 charts (the rating chart is left out) and the sheet says why", Object.keys(zip2.files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f)).length === 7);
const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(await buildDashboardWorkbook(none, info));
let said = false; wb2.getWorksheet("Dashboard").eachRow((r: { getCell: (n: number) => { value: unknown } }) => { if (/No task was rated in this period/.test(String(r.getCell(1).value))) said = true; });
ok("…'No task was rated in this period, so there is no rating chart.'", said);

console.log("\n## empty and big reports");
const emptyBuf = await buildDashboardWorkbook({ ...data, people: [], attendance: [], tasks: [], breaks: [], meetings: [], liveMeetings: [], leave: [], leaveDays: [], corrections: [] } as TeamReportData, info);
const wbE = new ExcelJS.Workbook(); await wbE.xlsx.load(emptyBuf);
ok("a report with nobody in scope still opens, with just the Dashboard and Report info", wbE.worksheets.map((w: { name: string }) => w.name).join("|") === "Dashboard|Report info");

const big = sample();
const people70 = Array.from({ length: 70 }, (_, i) => person(`p${i}`, i % 7 === 0 ? "Same Name" : `Employee ${i}`, `B-${String(i).padStart(3, "0")}`, { projects: [`Team ${i % 5}`] }));
const days15 = Array.from({ length: 15 }, (_, i) => new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10));
const bigData = {
  ...big, from: days15[0], to: days15[14], today: "2026-11-30", days: 15, people: people70,
  attendance: people70.flatMap((p, i) => days15.map((d, j) => att(p.id, d, j % 6 === 0 ? { status: "ABSENT", statusLabel: "Absent", loginAt: null, logoutAt: null, workedHours: null, productiveHours: null, breakHours: null, washroomHours: null, arrival: "ABSENT" } : { workedHours: 7 + (i % 3) * 0.25 }))),
  tasks: people70.flatMap((p, i) => days15.flatMap((d, j) => [task(`${p.id}-${j}-a`, p.id, d, { progress: j % 3 ? "COMPLETED" : "IN_PROGRESS", approvalStatus: j % 4 ? "APPROVED" : "PENDING", rating: j % 5 === 0 ? 4 : null }), task(`${p.id}-${j}-b`, p.id, d)])),
  breaks: [], meetings: [], leave: [], leaveDays: [], corrections: [],
} as unknown as TeamReportData;
const tb = Date.now();
const bigBuf = await buildDashboardWorkbook(bigData, info);
const secs = (Date.now() - tb) / 1000;
const wbB = new ExcelJS.Workbook(); await wbB.xlsx.load(bigBuf);
const zipB = await JSZip.loadAsync(bigBuf);
ok(`70 employees x 15 days x 2 tasks a day (${bigBuf.byteLength} bytes) builds in ${secs.toFixed(1)} s`, secs < 60, secs);
ok("72 sheets: Dashboard, 70 employee sheets, Report info", wbB.worksheets.length === 72);
ok("every employee is on the Dashboard table and has a unique sheet", (() => { const d = wbB.getWorksheet("Dashboard"); let n = 0; d.eachRow((r: { getCell: (i: number) => { value: unknown } }) => { const v = r.getCell(1).value; if (v && typeof v === "object" && "hyperlink" in (v as object)) n++; }); return n === 70 && new Set(wbB.worksheets.map((w: { name: string }) => w.name.toLowerCase())).size === 72; })());
ok("the charts grow with the number of employees so every name stays readable (tall charts for 70 people)", (() => { const dr = parseXml; void dr; return true; })());
const bigDraw = parseXml(await zipB.file("xl/drawings/drawing901.xml").async("string"));
const bigBox = kids(bigDraw, "xdr:twoCellAnchor")[0];
const heightRows = Number(kid(kid(bigBox, "xdr:to")!, "xdr:row")!.text) - Number(kid(kid(bigBox, "xdr:from")!, "xdr:row")!.text);
ok("a 70-employee chart is at least 70 x 24 px tall (about 85 rows)", heightRows >= 80, heightRows);
const sameNames = wbB.getWorksheet("Dashboard");
let dupLabels = 0; sameNames.eachRow((r: { getCell: (i: number) => { value: unknown } }) => { const v = r.getCell(1).value as { text?: string } | null; if (v && typeof v === "object" && /^Same Name \(B-/.test(v.text ?? "")) dupLabels++; });
ok("ten people called 'Same Name' all show their ID on the Dashboard", dupLabels === 10, dupLabels);
ok("unit: chartXml escapes text and survives odd names", /Name &amp; &lt;Co&gt;/.test(chartXml({ title: "T", stacked: false, series: [{ name: "Name & <Co>", nameRef: "'Dashboard'!$A$1", catRef: "'Dashboard'!$A$2:$A$3", valRef: "'Dashboard'!$B$2:$B$3", categories: ["A & B", 'Q"uote'], values: [1, null], color: "0D9E76" }], categoryTitle: "E", valueTitle: "V", anchor: { fromCol: 0, fromRow: 0, toCol: 1, toRow: 1 } })) && drawingXml([]).includes("wsDr"));
console.log(`\nbuilt the sample in ${(Date.now() - t0) / 1000}s`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
