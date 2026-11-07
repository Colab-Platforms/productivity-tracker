// Real Excel (.xlsx) workbooks for the three team reports (Attendance, Shift breakdown, Task productivity).
// exceljs is loaded only when somebody clicks "Export Excel", so the Reports page itself stays light.
//
// Every workbook has the same shape:
//   * one or more DATA sheets: header row 1 (bold, coloured, frozen), one record per row, filters on, column widths that fit, no merged
//     cells, so the sheet can be filtered and sorted straight away;
//   * a last sheet "Report info": report name, period, filters used, who exported it and when, record counts and totals.
// Values keep their real Excel type, so Excel can sort, filter and add them up:
//   date      "YYYY-MM-DD"            -> a date cell shown as 06 Nov 2026
//   time      seconds since midnight  -> a time cell shown as 10:04 AM
//   duration  seconds                 -> a duration cell shown as 7:05 (hours:minutes, may pass 24 h)
//   int / decimal / percent           -> numbers (a percent is given as 87.5 and stored as 0.875)
// Blank stays blank: a missing value is an empty cell, never a made-up zero. Text is written as text, so a name starting with = + - @ is
// never run as a formula (exceljs stores strings as strings).

export type Value = string | number | null;
export type Kind = "text" | "date" | "time" | "duration" | "int" | "decimal" | "percent";

export type Col = {
  header: string;
  kind?: Kind; // default text
  width?: number;
  wrap?: boolean;
  note?: string; // a hover note on the header
  accent?: boolean; // a darker header, to mark a related block of columns
  // A live Excel formula for this column (instead of a stored value). `letter(header)` gives a column letter, `value(header)` the row's value.
  formula?: (c: { row: number; letter: (header: string) => string; value: (header: string) => Value }) => { formula: string; result: string | number };
};
export type SheetSpec = { name: string; cols: Col[]; rows: Value[][] };
export type InfoSpec = {
  report: string;
  period: string;
  filters: [string, string][];
  exportedAt: Date;
  exportedBy?: string | null;
  timezone: string;
  counts?: [string, number][]; // records per sheet are added automatically; extra counts go here
  totals?: [string, string | number][]; // report totals that match the screen
};

const BRAND = "FF0D9E76";
const ACCENT = "FF2F3EB0";
const BORDER = "FFD9DCF0";
const FORMAT: Record<Kind, string | undefined> = { text: undefined, date: "dd mmm yyyy", time: "h:mm AM/PM", duration: "[h]:mm", int: "0", decimal: "0.00", percent: "0.0%" };

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Seconds since midnight, in `tz`, of an instant (for a time cell). null stays null. */
export function secondsOfDay(iso: string | null, tz: string): number | null {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 3600 + get("minute") * 60 + get("second");
}

/** The calendar day ("YYYY-MM-DD") of an instant in `tz` (for a date cell). */
export function dayOf(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "06 Nov 2026, 10:42 AM" in `tz`. */
export function stampLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(d);
}

function cellValue(v: Value, kind: Kind): string | number | Date | null {
  if (v === null || v === "") return null;
  switch (kind) {
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
      return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : String(v);
    }
    case "time":
    case "duration":
      return typeof v === "number" ? v / 86400 : String(v); // text such as "Working" stays text
    case "percent":
      return typeof v === "number" ? v / 100 : String(v);
    case "int":
    case "decimal":
      return typeof v === "number" ? v : String(v); // text such as "No task data available" stays text
    default:
      return String(v);
  }
}

const safeSheetName = (n: string) => n.replace(/[\[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sheet";

/** Builds the workbook and returns the .xlsx file bytes. Pure (no browser needed), so it can be tested. */
export async function buildReportWorkbook(sheets: SheetSpec[], info: InfoSpec): Promise<ArrayBuffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = info.exportedBy || "Avatar HRMS";
  wb.created = info.exportedAt;
  wb.title = info.report;

  const font = { name: "Calibri", size: 11 };
  const thin = { style: "thin" as const, color: { argb: BORDER } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(safeSheetName(sheet.name), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = sheet.cols.map((c) => ({ header: c.header, key: c.header, width: c.width ?? 14 }));
    const head = ws.getRow(1);
    head.height = 34;
    sheet.cols.forEach((c, i) => {
      const cell = head.getCell(i + 1);
      cell.font = { ...font, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.accent ? ACCENT : BRAND } };
      cell.alignment = { vertical: "middle", horizontal: c.kind && c.kind !== "text" ? "center" : "left", wrapText: true };
      cell.border = border;
      if (c.note) cell.note = c.note;
    });
    const letterOf = (h: string) => columnLetter(sheet.cols.findIndex((c) => c.header === h));
    sheet.rows.forEach((values, idx) => {
      const r = idx + 2;
      const row = ws.getRow(r);
      const valueOf = (h: string): Value => values[sheet.cols.findIndex((c) => c.header === h)] ?? null;
      sheet.cols.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        const kind = c.kind ?? "text";
        if (c.formula) cell.value = c.formula({ row: r, letter: letterOf, value: valueOf });
        else cell.value = cellValue(values[i] ?? null, kind);
        // The column's format goes on EVERY cell of a typed column, blank ones too, so the column stays consistent (and a value typed later looks right).
        if (FORMAT[kind]) cell.numFmt = FORMAT[kind]!;
        cell.font = font;
        cell.border = border;
        cell.alignment = { vertical: "middle", horizontal: kind === "text" ? "left" : "center", wrapText: !!c.wrap };
      });
    });
    if (sheet.cols.length > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.cols.length } };
  }

  // Report info: what this file is, for whom, and what it contains.
  const ws = wb.addWorksheet("Report info");
  ws.columns = [{ width: 30 }, { width: 60 }];
  const lines: [string, string | number][] = [
    ["Report", info.report],
    ["Period", info.period],
    ...info.filters.map(([k, v]) => [k, v] as [string, string]),
    ["Exported on", `${stampLabel(info.exportedAt, info.timezone)} (${info.timezone})`],
    ...(info.exportedBy ? ([["Exported by", info.exportedBy]] as [string, string][]) : []),
    ...sheets.map((s) => [`Records: ${safeSheetName(s.name)}`, s.rows.length] as [string, number]),
    ...(info.counts ?? []),
    ...(info.totals ?? []),
  ];
  lines.forEach(([k, v], i) => {
    const row = ws.getRow(i + 1);
    row.getCell(1).value = k;
    row.getCell(2).value = v;
    row.getCell(1).font = { ...font, bold: true };
    row.getCell(2).font = font;
    row.getCell(2).alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    row.getCell(1).border = border;
    row.getCell(2).border = border;
  });

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** Builds the workbook and starts the browser download. */
export async function downloadReportXlsx(filename: string, sheets: SheetSpec[], info: InfoSpec) {
  const buffer = await buildReportWorkbook(sheets, info);
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
