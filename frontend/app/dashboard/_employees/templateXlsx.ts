// The Employee import / update TEMPLATE as a real Excel (.xlsx) file. The headings and the example row come from the server's CSV template
// (one source of truth, so Excel and CSV can never disagree); this file only turns them into a workbook. exceljs is loaded only on click.
//
// Sheet "Employees": heading row (yellow = needed to ADD a new person, grey = optional), one clearly marked example row that is never imported,
// frozen heading, readable widths, every cell text so Excel never turns an ID, a phone number or "9.30" into something else.
// Sheet "How to fill": the rules in plain words.

const REQUIRED_TO_ADD = ["Company", "Full name", "Employee ID", "Work email", "Designation", "Team or department", "System role", "Reports to - full name", "Reports to - employee ID"];

/** A small CSV reader (quotes, commas inside quotes, a leading BOM). */
export function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

export const HOW_TO_FILL: string[] = [
  "Fill one row per person. Delete the example row or leave it: it is never imported.",
  "Employee ID is how a person is found. It is never changed by an import.",
  "Yellow headings are needed only to ADD a new person. To UPDATE someone who already exists, only Employee ID is needed: fill just the columns you want to add.",
  "A blank cell never erases what is already saved. If a saved value is different, the preview shows it as a conflict and leaves it alone unless you tick overwrite.",
  "Nothing is saved until you review the preview and confirm.",
  "Dates: use YYYY-MM-DD (for example 2025-01-14) or DD-MM-YYYY. Date of birth must be a real date in the past.",
  "Times: write 10:00 AM - 7:00 PM, or 24-hour 10:00 - 19:00. Words work too: 9:30 morning to 6:30 evening. A plain 9.30 or an end time before the start needs the confirmation tick in the preview.",
  "Working days: Mon to Sat, Mon to Fri, or a list such as Mon, Tue, Wed. With Office timings and no working days, Monday to Saturday is used and shown in the preview.",
  "Gender: Male, Female or Other. Marital status: Single / Unmarried, Married, Divorced or Widowed. Employee status: Full time or Part time. Employee type: Permanent, Probation, Contract or Intern.",
  "Team or department must be a team that already exists. Department is kept as plain text. Secondary manager must be an active Manager or Admin (write Name (ID) if two people share a name), and only an Admin can add one.",
  "Designation must be one of the company's designations; Company must match the person's company.",
  "Personal columns (gender, date of birth, address and so on) are read only by Update employees, not by Add or Import.",
];

export async function buildTemplateWorkbook(headers: string[], example: string[]): Promise<ArrayBuffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Avatar HRMS";
  const ws = wb.addWorksheet("Employees", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow(headers);
  ws.addRow(example);
  headers.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    col.numFmt = "@"; // text, so IDs, phone numbers and times are kept exactly as typed
    col.width = Math.min(34, Math.max(14, h.length + 4));
    const head = ws.getCell(1, i + 1);
    const needed = REQUIRED_TO_ADD.includes(h);
    head.font = { bold: true, color: { argb: "FF1E293B" } };
    head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: needed ? "FFFDE68A" : "FFE5E7EB" } };
    head.alignment = { vertical: "middle", wrapText: true };
    head.border = { bottom: { style: "thin", color: { argb: "FF94A3B8" } } };
  });
  ws.getRow(1).height = 32;
  const ex = ws.getRow(2);
  ex.font = { italic: true, color: { argb: "FF64748B" } };
  ex.eachCell((c) => { c.numFmt = "@"; });
  // 200 empty text rows so what people type stays text
  for (let r = 3; r <= 202; r++) for (let c = 1; c <= headers.length; c++) ws.getCell(r, c).numFmt = "@";

  const how = wb.addWorksheet("How to fill");
  how.getColumn(1).width = 120;
  how.addRow(["How to fill this template"]).font = { bold: true, size: 14 };
  how.addRow(["Yellow headings are needed to add a new person; grey ones are optional."]);
  how.addRow([]);
  HOW_TO_FILL.forEach((t, i) => { const r = how.addRow([`${i + 1}. ${t}`]); r.alignment = { wrapText: true, vertical: "top" }; });
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
