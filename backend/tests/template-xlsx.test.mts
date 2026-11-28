// The Excel template is built from the server's CSV template and read back: headings, order, required colouring, text cells, example row, instructions.
import { importTemplateCsv } from "../src/modules/admin/employeeImport.service.js";
import { buildTemplateWorkbook, readCsv, HOW_TO_FILL } from "../../frontend/app/dashboard/_employees/templateXlsx.js";
import { createRequire } from "node:module";
const ExcelJS = createRequire("C:/Users/hi/productivity-tracker/frontend/package.json")("exceljs");
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(x).slice(0, 300))); };

const [headers, example] = readCsv(importTemplateCsv());
ok("CSV reader: BOM removed, 2 rows, same width", headers[0] === "Company" && example.length === headers.length, headers.slice(0, 2));
ok("includes old and new headings", ["Full name", "Employee ID", "Work email", "Date of joining", "Shift start", "Gender", "Date of birth (YYYY-MM-DD)", "Address line 2", "Office timings", "Secondary manager", "Extra field 5", "Notes"].every((h) => headers.includes(h)), headers);
const buf = await buildTemplateWorkbook(headers, example);
ok("a real .xlsx (zip)", new Uint8Array(buf)[0] === 0x50 && new Uint8Array(buf)[1] === 0x4b);
const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
ok("two sheets: Employees, How to fill", wb.worksheets.map((w: { name: string }) => w.name).join() === "Employees,How to fill");
const ws = wb.getWorksheet("Employees");
ok("heading row equals the server headings in order", headers.every((h, i) => ws.getCell(1, i + 1).value === h));
ok("the example row is row 2 and marked", String(ws.getCell(2, headers.length).value).includes("EXAMPLE ROW"));
ok("heading frozen", ws.views[0]?.state === "frozen" && ws.views[0]?.ySplit === 1);
const fill = (h: string) => ws.getCell(1, headers.indexOf(h) + 1).fill?.fgColor?.argb;
ok("needed-to-add headings are yellow, optional ones grey", fill("Employee ID") === "FFFDE68A" && fill("Company") === "FFFDE68A" && fill("Gender") === "FFE5E7EB" && fill("Notes") === "FFE5E7EB", [fill("Employee ID"), fill("Gender")]);
ok("cells are text so IDs and times stay as typed", ws.getColumn(3).numFmt === "@" && ws.getCell(10, 3).numFmt === "@");
const how = wb.getWorksheet("How to fill");
ok("instructions are there", how.rowCount >= HOW_TO_FILL.length + 3 && /Monday to Saturday/.test(HOW_TO_FILL.join(" ")));
// quoting round trip
ok("CSV reader handles quotes and commas", JSON.stringify(readCsv('a,"b, c","d ""q"""\r\n1,2,3\r\n')) === JSON.stringify([["a", "b, c", 'd "q"'], ["1", "2", "3"]]));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
