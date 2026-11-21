// ---------------------------------------------------------------------------
// HOLIDAY SHEET: pure rules, no database. Columns: Date | Day | Holiday | Status | Religion.
//
//   Nothing is changed silently: the date, the holiday name and the religion/category text are kept exactly as written (only outer spaces are
//   trimmed). A row that cannot be trusted is marked with a message and left for HR to correct or exclude.
//   Status   Fixed -> FIXED, Optional -> OPTIONAL (any capitals). Anything else is an error, never a guess.
//   Day      DERIVED from the date. A sheet's own "Day" must match it; a mismatch is a WARNING-level error that HR must fix or exclude.
//   Year     every date must fall in the selected calendar year.
//   Duplicate the same date + holiday name (ignoring capitals and spacing) twice in the file: the later row is a duplicate.
// ---------------------------------------------------------------------------

export type Cell = string | number | boolean | null;
export type SheetRow = { rowNumber: number; cells: Cell[] };
export type Kind = "FIXED" | "OPTIONAL";
export type RowState = "VALID" | "ERROR" | "DUPLICATE_IN_FILE" | "ALREADY_EXISTS";

export type HolidayRow = {
  rowNumber: number;
  date: string; // the date as read, YYYY-MM-DD, or "" when it could not be read
  dateText: string; // exactly what the sheet said
  dayText: string; // the sheet's own Day cell
  weekday: string; // derived from the date
  name: string;
  kind: Kind | null;
  statusText: string;
  religion: string;
  state: RowState;
  messages: string[];
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export const REQUIRED_HEADERS = ["date", "holiday", "status"] as const;

export const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const nameKey = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const blank = (c: Cell | undefined) => c === null || c === undefined || (typeof c === "string" && c.trim() === "");
const text = (c: Cell | undefined) => (blank(c) ? "" : String(c).trim());

const HEADER_SYNONYMS: Record<string, string[]> = {
  date: ["date", "holidaydate", "dateofholiday"],
  day: ["day", "weekday", "dayname"],
  holiday: ["holiday", "holidayname", "name", "occasion", "festival"],
  status: ["status", "type", "holidaytype", "kind"],
  religion: ["religion", "category", "religionorcategory", "community"],
};

/** Finds which column holds which field from the heading row (capitals and spacing do not matter). */
export function mapHeaders(headers: Cell[]): { map: Partial<Record<"date" | "day" | "holiday" | "status" | "religion", number>>; missing: string[] } {
  const map: Partial<Record<"date" | "day" | "holiday" | "status" | "religion", number>> = {};
  headers.forEach((h, i) => {
    const k = norm(h);
    for (const [field, names] of Object.entries(HEADER_SYNONYMS)) {
      if (names.includes(k) && map[field as keyof typeof map] === undefined) map[field as keyof typeof map] = i;
    }
  });
  const missing = REQUIRED_HEADERS.filter((f) => map[f] === undefined) as string[];
  return { map, missing };
}

/** Index of the heading row: the first row (within the first 15) that names at least the Date and Holiday columns. */
export function findHeaderRow(data: Cell[][]): number {
  for (let i = 0; i < Math.min(data.length, 15); i++) {
    const { map } = mapHeaders(data[i] ?? []);
    if (map.date !== undefined && map.holiday !== undefined) return i;
  }
  return -1;
}

const realDay = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
};

/** One date cell. Accepts 01-Jan-2026, 1 January 2026, 01-01-2026, 01/01/2026, 2026-01-01 and an Excel serial. Never guesses a two-digit year. */
export function parseHolidayDate(cell: Cell | undefined): { iso?: string; error?: string } {
  if (blank(cell)) return { error: "The date is missing." };
  if (typeof cell === "number") {
    if (cell > 20000 && cell < 80000) return { iso: new Date(Date.UTC(1899, 11, 30) + Math.round(cell) * 86_400_000).toISOString().slice(0, 10) };
    return { error: `${cell} is not a date.` };
  }
  const s = String(cell).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (m) { const v = realDay(+m[1], +m[2], +m[3]); return v ? { iso: v } : { error: `"${s}" is not a real calendar date.` }; }
  m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]+(\d{4})$/);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi < 0) return { error: `"${s}" is not a date (unknown month "${m[2]}").` };
    const v = realDay(+m[3], mi + 1, +m[1]);
    return v ? { iso: v } : { error: `"${s}" is not a real calendar date.` };
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) { const v = realDay(+m[3], +m[2], +m[1]); return v ? { iso: v } : { error: `"${s}" is not a real calendar date (read as day-month-year).` }; }
  return { error: `"${s}" is not a date. Use 01-Jan-2026 or 01-01-2026.` };
}

export const weekdayOf = (iso: string): string => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];

export function parseKind(v: string): Kind | null {
  const k = norm(v);
  if (k === "fixed" || k === "fixedholiday" || k === "public" || k === "publicholiday") return "FIXED";
  if (k === "optional" || k === "optionalholiday" || k === "restricted") return "OPTIONAL";
  return null;
}

export type ValidateInput = {
  rows: SheetRow[];
  map: Partial<Record<"date" | "day" | "holiday" | "status" | "religion", number>>;
  year: number;
  /** holidays already saved for the company: "YYYY-MM-DD|name key" */
  existing?: Set<string>;
};

/** Reads and checks every non-empty row. Empty rows are dropped (they are not records). Order and numbering follow the sheet. */
export function validateHolidayRows(input: ValidateInput): { rows: HolidayRow[]; ignoredEmpty: number } {
  const { map, year } = input;
  const seen = new Map<string, number>();
  const out: HolidayRow[] = [];
  let ignoredEmpty = 0;
  for (const r of input.rows) {
    const c = (f: keyof typeof map) => (map[f] === undefined ? undefined : r.cells[map[f] as number]);
    if (r.cells.every(blank)) { ignoredEmpty++; continue; }
    const messages: string[] = [];
    const dateText = text(c("date"));
    const dayText = text(c("day"));
    const name = text(c("holiday"));
    const statusText = text(c("status"));
    const religion = text(c("religion"));
    const d = parseHolidayDate(c("date"));
    let weekday = "";
    if (d.error) messages.push(d.error);
    else {
      weekday = weekdayOf(d.iso as string);
      if (new Date(`${d.iso}T00:00:00Z`).getUTCFullYear() !== year) messages.push(`The date is in ${(d.iso as string).slice(0, 4)}, not in ${year}.`);
      if (dayText && norm(dayText).slice(0, 3) !== weekday.toLowerCase().slice(0, 3)) messages.push(`The sheet says ${dayText}, but ${dateText || d.iso} is a ${weekday}.`);
    }
    if (!name) messages.push("The holiday name is missing.");
    else if (name.length > 120) messages.push("The holiday name is longer than 120 characters.");
    const kind = statusText ? parseKind(statusText) : null;
    if (!statusText) messages.push("The status is missing (Fixed or Optional).");
    else if (!kind) messages.push(`"${statusText}" is not a valid status. Use Fixed or Optional.`);
    let state: RowState = messages.length ? "ERROR" : "VALID";
    if (!messages.length && d.iso) {
      const key = `${d.iso}|${nameKey(name)}`;
      const first = seen.get(key);
      if (first !== undefined) { state = "DUPLICATE_IN_FILE"; messages.push(`Same date and holiday as row ${first}.`); }
      else {
        seen.set(key, r.rowNumber);
        if (input.existing?.has(key)) { state = "ALREADY_EXISTS"; messages.push("This holiday is already in the company calendar; it will be skipped."); }
      }
    }
    out.push({ rowNumber: r.rowNumber, date: d.iso ?? "", dateText, dayText, weekday, name, kind, statusText, religion, state, messages });
  }
  return { rows: out, ignoredEmpty };
}

/** The rows that would be saved: valid, and not excluded by HR. */
export const importable = (rows: HolidayRow[], excluded: Set<number> = new Set()) => rows.filter((r) => r.state === "VALID" && !excluded.has(r.rowNumber));
