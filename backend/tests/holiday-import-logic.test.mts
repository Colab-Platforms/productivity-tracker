// Holiday sheet rules (pure, no database). Run: cd backend && npx tsx tests/holiday-import-logic.test.mts
import { findHeaderRow, importable, mapHeaders, parseHolidayDate, parseKind, validateHolidayRows, weekdayOf } from "../src/modules/holidays/holidayImport.logic.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(x))); };

console.log("## dates");
ok("01-Jan-2026", parseHolidayDate("01-Jan-2026").iso === "2026-01-01");
ok("1 January 2026 style (full month)", parseHolidayDate("1-January-2026").iso === "2026-01-01");
ok("01-01-2026 is day-month-year", parseHolidayDate("01-02-2026").iso === "2026-02-01");
ok("2026-03-19", parseHolidayDate("2026-03-19").iso === "2026-03-19");
ok("an Excel serial number", parseHolidayDate(46023).iso === "2026-01-01", parseHolidayDate(46023));
ok("31-Feb is not a date", !!parseHolidayDate("31-Feb-2026").error);
ok("a two-digit year is never guessed", !!parseHolidayDate("01-01-26").error);
ok("an unknown month is an error", !!parseHolidayDate("01-Foo-2026").error);
ok("blank is an error", !!parseHolidayDate("  ").error);
ok("weekday is derived", weekdayOf("2026-01-01") === "Thursday" && weekdayOf("2026-01-26") === "Monday");

console.log("## kinds and headers");
ok("Fixed / Optional in any capitals", parseKind(" FIXED ") === "FIXED" && parseKind("optional") === "OPTIONAL");
ok("anything else is not guessed", parseKind("Maybe") === null && parseKind("") === null);
const h = mapHeaders(["Date", "Day", "Holiday", "Status", "Religion"]);
ok("the five headings are found", h.map.date === 0 && h.map.day === 1 && h.map.holiday === 2 && h.map.status === 3 && h.map.religion === 4 && h.missing.length === 0);
ok("missing required headings are named", mapHeaders(["Date", "Holiday"]).missing.join() === "status");
ok("heading row found below a title row", findHeaderRow([["Holiday list 2026"], ["Date", "Day", "Holiday", "Status", "Religion"]]) === 1);

console.log("## rows");
const rows = [
  ["01-Jan-2026", "Thursday", "New Year", "Fixed", "General"],
  ["26-Jan-2026", "Monday", "Republic Day IN", "Fixed", "General"],
  ["19-Mar-2026", "Thursday", "Gudi Padwa", "Optional", "Marathi"],
  ["19-Mar-2026", "Thursday", "gudi  padwa", "Optional", "Marathi"],
  ["20-Mar-2026", "Monday", "Wrong Day", "Fixed", ""],
  ["05-Jan-2027", "Tuesday", "Wrong Year", "Fixed", ""],
  [null, null, null, null, null],
  ["01-May-2026", "Friday", "Existing", "Fixed", "General"],
].map((cells, i) => ({ rowNumber: i + 2, cells }));
const r = validateHolidayRows({ rows, map: h.map, year: 2026, existing: new Set(["2026-05-01|existing"]) });
const s = (n: number) => r.rows.find((x) => x.rowNumber === n)!;
ok("valid rows keep name, category and type exactly", s(2).state === "VALID" && s(2).name === "New Year" && s(4).religion === "Marathi" && s(4).kind === "OPTIONAL");
ok("the empty row is dropped, not an error", r.ignoredEmpty === 1 && r.rows.length === 7);
ok("same date + name (spacing and capitals) is a duplicate", s(5).state === "DUPLICATE_IN_FILE" && /row 4/.test(s(5).messages.join()), s(5));
ok("day/date mismatch is an error naming both", s(6).state === "ERROR" && /Monday/.test(s(6).messages.join()) && /Friday/.test(s(6).messages.join()), s(6));
ok("wrong calendar year is an error", s(7).state === "ERROR" && /not in 2026/.test(s(7).messages.join()), s(7));
ok("a holiday already saved is marked, not changed", s(9).state === "ALREADY_EXISTS");
ok("only VALID rows are importable, and exclusions are honoured", importable(r.rows).length === 3 && importable(r.rows, new Set([2])).length === 2);
ok("a Day written as 'Thu' still matches", validateHolidayRows({ rows: [{ rowNumber: 2, cells: ["01-Jan-2026", "Thu", "X", "Fixed", ""] }], map: h.map, year: 2026 }).rows[0].state === "VALID");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
