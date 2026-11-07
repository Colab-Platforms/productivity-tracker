// The shared Excel builder behind Export Excel (Attendance, Shift breakdown, Task productivity). Needs NO database: it builds a workbook
// in memory, then reads the file back with exceljs and checks what Excel will really see.
//
//   cd backend && DATABASE_URL=dummy npx tsx tests/report-xlsx.test.mts
import { createRequire } from "node:module";
import path from "node:path";
import { buildReportWorkbook, dayOf, secondsOfDay, type Col, type SheetSpec } from "../../frontend/app/dashboard/reports/_team/reportXlsx.ts";

// exceljs lives in the frontend; load it from there to read the file back
const req = createRequire(path.resolve(import.meta.dirname, "../../frontend/app/dashboard/reports/_team/reportXlsx.ts"));
const ExcelJS = req("exceljs");

let pass = 0, fail = 0;
const ok = (n: string, c: unknown, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };

const cols: Col[] = [
  { header: "Employee ID" }, { header: "Employee", width: 24 }, { header: "Date", kind: "date" }, { header: "Check-in", kind: "time" }, { header: "Check-out", kind: "time" },
  { header: "Working", kind: "duration" }, { header: "Hours", kind: "decimal" }, { header: "Planned", kind: "int", accent: true }, { header: "Done", kind: "int" },
  { header: "Pending", kind: "int", accent: true, formula: ({ row, letter, value }) => { const p = value("Planned"); return { formula: `IF(${letter("Planned")}${row}="","",${letter("Planned")}${row}-${letter("Done")}${row})`, result: p === null ? "" : Number(p) - Number(value("Done") ?? 0) }; } },
  { header: "Score", kind: "percent" }, { header: "Note", wrap: true },
];
const rows = [
  ["AI-01", "Ravi Kumar", "2026-11-06", 9 * 3600 + 30 * 60, 17 * 3600 + 30 * 60, 7 * 3600 + 5 * 60, 3.5, 5, 3, null, 87.5, "ok"],
  ["AI-02", "=HYPERLINK(\"http://x\")", "2026-11-07", null, "Working", 26 * 3600 + 15 * 60, null, null, 0, null, "No task data available", ""],
  ["AI-03", "Sana, \"Q\"", "2026-12-31", 0, 86399, 59, 0, 0, 0, null, 0, "zero stays zero"],
];
const sheets: SheetSpec[] = [{ name: "Attendance", cols, rows }, { name: "Tasks: [bad]/name*?", cols: [{ header: "A" }], rows: [["x"]] }];
const at = new Date("2026-11-06T05:12:00Z");

const buf = await buildReportWorkbook(sheets, {
  report: "Attendance Report", period: "06 Nov 2026 to 07 Nov 2026", filters: [["Company", "All"], ["Project", "Alpha, Beta"]], exportedAt: at, exportedBy: "Sonali Gouda", timezone: "Asia/Kolkata",
  totals: [["Present days", 12]],
});
const bytes = new Uint8Array(buf);
ok("a genuine xlsx file: a zip package (PK header) holding the Excel parts, not a renamed CSV", bytes[0] === 0x50 && bytes[1] === 0x4b && Buffer.from(bytes).includes(Buffer.from("[Content_Types].xml")) && Buffer.from(bytes).includes(Buffer.from("xl/workbook.xml")));

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);
const names = wb.worksheets.map((w: { name: string }) => w.name);
ok("worksheets: the data sheet, a safely named second sheet, and Report info last", names[0] === "Attendance" && names[1] === "Tasks   bad  name" && names[names.length - 1] === "Report info", names);
const ws = wb.getWorksheet("Attendance");
const head = ws.getRow(1);
ok("header row 1: bold, white on colour, one heading per column, no title rows above it", head.getCell(1).value === "Employee ID" && head.getCell(1).font.bold === true && head.getCell(2).fill.fgColor.argb === "FF5368ED" && head.getCell(8).fill.fgColor.argb === "FF2F3EB0");
ok("header is frozen and filters are on over every column (easy to sort and filter)", ws.views[0].state === "frozen" && ws.views[0].ySplit === 1 && ws.autoFilter && (typeof ws.autoFilter === "string" ? ws.autoFilter === "A1:L1" : ws.autoFilter.from.row === 1 && ws.autoFilter.to.column === cols.length), [ws.views, ws.autoFilter]);
ok("column widths are set and readable", ws.getColumn(2).width === 24 && ws.getColumn(1).width >= 10);
ok("one record per row, in order (3 records in rows 2-4, nothing merged)", ws.rowCount === 4 && Object.keys(ws._merges ?? {}).length === 0 && ws.getRow(4).getCell(1).value === "AI-03");

const c = (r: number, col: number) => ws.getRow(r).getCell(col);
// exceljs reads a cell whose format is a time / duration back as a JS date counted from 1899-12-30: turn it back into the stored fraction of a day
const frac = (r: number, col: number) => { const v = c(r, col).value; return v instanceof Date ? (v.getTime() - Date.UTC(1899, 11, 30)) / 86400000 : v; };
ok("dates are real date cells with a date format (not text)", c(2, 3).value instanceof Date && c(2, 3).value.toISOString().startsWith("2026-11-06T00:00:00") && c(2, 3).numFmt === "dd mmm yyyy" && c(4, 3).value.toISOString().startsWith("2026-12-31"), [c(2, 3).value, c(2, 3).numFmt]);
ok("times are real time cells (fraction of a day) with an AM/PM format", Math.abs(frac(2, 4) - (9.5 / 24)) < 1e-9 && c(2, 4).numFmt === "h:mm AM/PM" && Math.abs(frac(2, 5) - (17.5 / 24)) < 1e-9);
ok("a text value in a time column (\"Working\") stays text; an empty time stays blank", c(3, 5).value === "Working" && c(3, 4).value === null);
ok("midnight (0 s) is a real 0, and 23:59:59 is kept", frac(4, 4) === 0 && Math.abs(frac(4, 5) - 86399 / 86400) < 1e-9);
ok("durations are numbers that add up, shown as hours:minutes and allowed past 24 h", Math.abs(frac(2, 6) - (7 * 3600 + 300) / 86400) < 1e-9 && c(2, 6).numFmt === "[h]:mm" && Math.abs(frac(3, 6) - (26 * 3600 + 900) / 86400) < 1e-9 && Math.abs(frac(4, 6) - 59 / 86400) < 1e-9);
ok("decimals and whole numbers are numbers with their formats", c(2, 7).value === 3.5 && c(2, 7).numFmt === "0.00" && c(2, 8).value === 5 && c(2, 8).numFmt === "0");
ok("blank stays blank: null becomes an empty cell, never a made-up zero", c(3, 7).value === null && c(3, 8).value === null);
ok("a zero that was really zero stays 0", c(4, 7).value === 0 && c(4, 9).value === 0);
const pend = c(2, 10).value;
ok("a live formula column: Excel recalculates it, and the stored result is right", pend && pend.formula === 'IF(H2="","",H2-I2)' && pend.result === 2, pend);
ok("the formula result is blank when nothing was planned", (c(3, 10).value.result === "" || c(3, 10).value.result === undefined) && c(3, 10).value.formula === 'IF(H3="","",H3-I3)');
ok("a percent is stored as a fraction with a % format (87.5 shows as 87.5%)", Math.abs(c(2, 11).value - 0.875) < 1e-9 && c(2, 11).numFmt === "0.0%");
ok("text that stands in for a number stays text (never turned into 0%)", c(3, 11).value === "No task data available");
ok("a name that starts with = is stored as TEXT, never run as a formula", c(3, 2).value === '=HYPERLINK("http://x")' && typeof c(3, 2).value === "string");
ok("commas and quotes in text are kept exactly", c(4, 2).value === 'Sana, "Q"');
ok("wrapped columns wrap, others do not", c(2, 12).alignment.wrapText === true && !c(2, 1).alignment.wrapText);

const info = wb.getWorksheet("Report info");
const kv: Record<string, unknown> = {};
info.eachRow((r: { getCell: (n: number) => { value: unknown } }) => { kv[String(r.getCell(1).value)] = r.getCell(2).value; });
ok("Report info: report name, period and the filters used", kv["Report"] === "Attendance Report" && kv["Period"] === "06 Nov 2026 to 07 Nov 2026" && kv["Company"] === "All" && kv["Project"] === "Alpha, Beta", kv);
ok("Report info: who exported it, and when (in the company timezone)", kv["Exported by"] === "Sonali Gouda" && /^06 Nov 2026, 10:42 am \(Asia\/Kolkata\)$/i.test(String(kv["Exported on"])), kv["Exported on"]);
ok("Report info: the record count of every sheet and the report totals", kv["Records: Attendance"] === 3 && kv["Records: Tasks   bad  name"] === 1 && kv["Present days"] === 12, kv);

ok("helpers: time of day and calendar day in the company timezone", secondsOfDay("2026-11-06T04:04:00Z", "Asia/Kolkata") === 9 * 3600 + 34 * 60 && dayOf("2026-11-06T20:00:00Z", "Asia/Kolkata") === "2026-11-07" && secondsOfDay(null, "UTC") === null && dayOf(null, "UTC") === null);

// every record is exported: 5,000 rows, no loss, no duplication, in a reasonable time
const many = Array.from({ length: 5000 }, (_, i) => [`E-${i}`, `Person ${i}`, "2026-11-06", 9 * 3600, 17 * 3600, 28800, 1, 3, 1, null, 50, ""]);
const t0 = Date.now();
const big = await buildReportWorkbook([{ name: "Attendance", cols, rows: many }], { report: "Big", period: "x", filters: [], exportedAt: at, timezone: "UTC" });
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(big);
const w2 = wb2.getWorksheet("Attendance");
const idsSeen = new Set<string>();
for (let r = 2; r <= w2.rowCount; r++) idsSeen.add(String(w2.getRow(r).getCell(1).value));
ok(`5,000 records: all present, none duplicated (${Date.now() - t0} ms)`, w2.rowCount === 5001 && idsSeen.size === 5000 && Date.now() - t0 < 15000, [w2.rowCount, idsSeen.size]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
