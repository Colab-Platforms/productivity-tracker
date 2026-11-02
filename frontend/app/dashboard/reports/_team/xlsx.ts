// Real Excel (.xlsx) download for the Attendance report.
// exceljs is loaded only when somebody clicks Download, so the Reports page itself stays light.
//
// Same table as the CSV (the header row is row 1, nothing is added above it), plus:
//   - "Pending Tasks" is a live Excel formula: =IF(planned="","",planned-completed)
//   - borders on every cell, a frozen header row and filters, column widths that fit the content
// Blank stays blank: a day with no tasks has empty Planned / Approved / Pending cells, never a made-up zero.

export type Cell = string | number | null;

const BRAND = "FF5368ED"; // primary, same as the app
const TASK_HEAD = "FF2F3EB0"; // the task-tracking block, a shade darker so it reads as its own section
const BORDER = "FFD9DCF0";
const NUMERIC = new Set(["Tasks completed", "Total Tasks Planned Today", "Tasks Approved Today", "Pending Tasks"]);
const TASK_COLUMNS = new Set(["Total Tasks Planned Today", "Tasks Approved Today", "Pending Tasks"]);
const WIDTH: Record<string, number> = {
  "Employee ID": 14, Employee: 24, Team: 20, Date: 13, Shift: 24, "Check-in": 11, "Check-out": 11, Working: 11, Productive: 11, Break: 10, Washroom: 11,
  "Break over allowance": 14, Status: 18, "Late arrival": 12, "Early departure": 14, "Tasks completed": 12, "Total Tasks Planned Today": 15,
  "Tasks Approved Today": 15, "Pending Tasks": 12, Remarks: 44,
};
const NOTES: Record<string, string> = {
  "Total Tasks Planned Today": "Tasks planned for that person that day: approved, or waiting for approval. Cancelled and rejected tasks are not counted. Blank = no tasks.",
  "Tasks Approved Today": "Tasks a team lead or manager approved for that day. Blank = no tasks.",
  "Pending Tasks": "Formula: Total Tasks Planned Today - Tasks completed. Blank when nothing was planned.",
};

function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export async function downloadAttendanceXlsx(filename: string, sheetName: string, header: string[], rows: Cell[][]) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Avatar HRMS";
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, { views: [{ state: "frozen", ySplit: 1 }] });

  const font = { name: "Calibri", size: 11 };
  const thin = { style: "thin" as const, color: { argb: BORDER } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  ws.columns = header.map((h) => ({ header: h, key: h, width: WIDTH[h] ?? 14 }));

  const head = ws.getRow(1);
  head.height = 34;
  header.forEach((h, i) => {
    const c = head.getCell(i + 1);
    c.font = { ...font, bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TASK_COLUMNS.has(h) ? TASK_HEAD : BRAND } };
    c.alignment = { vertical: "middle", horizontal: NUMERIC.has(h) ? "center" : "left", wrapText: true };
    c.border = border;
    if (NOTES[h]) c.note = NOTES[h];
  });

  const completedAt = header.indexOf("Tasks completed");
  const plannedAt = header.indexOf("Total Tasks Planned Today");
  const pendingAt = header.indexOf("Pending Tasks");
  const hasTaskBlock = completedAt >= 0 && plannedAt >= 0 && pendingAt >= 0;

  rows.forEach((values, idx) => {
    const r = idx + 2; // row 1 is the header
    const row = ws.getRow(r);
    values.forEach((v, i) => {
      if (i === pendingAt && hasTaskBlock) return; // written below as a formula
      row.getCell(i + 1).value = v === null || v === "" ? null : v;
    });
    if (hasTaskBlock) {
      const p = `${columnLetter(plannedAt)}${r}`;
      const c = `${columnLetter(completedAt)}${r}`;
      const planned = values[plannedAt];
      const completed = Number(values[completedAt] ?? 0);
      // The value Excel will show, stored too so viewers that do not calculate (previews, phones) still show it.
      const result: string | number = planned === null || planned === "" ? "" : Number(planned) - completed;
      row.getCell(pendingAt + 1).value = { formula: `IF(${p}="","",${p}-${c})`, result };
    }
    header.forEach((h, i) => {
      const cell = row.getCell(i + 1);
      cell.font = font;
      cell.border = border;
      cell.alignment = { vertical: "middle", horizontal: NUMERIC.has(h) ? "center" : "left", wrapText: h === "Remarks" || h === "Shift" };
    });
  });

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };

  const buffer = await wb.xlsx.writeBuffer();
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
