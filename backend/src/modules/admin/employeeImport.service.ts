// ===========================================================================
// EMPLOYEE ADD + BULK IMPORT
//
// One pipeline serves both the "Add Employee" form (one row) and "Import
// Employees" (many rows), so the two can never disagree about a rule.
//
//   parse    file (.xlsx / .csv)  ->  rows of plain cells + a guessed mapping
//   preview  rows + mapping       ->  per-row verdict, nothing is written
//   commit   the same input       ->  re-validates, then writes in ONE
//                                     transaction (all rows or none)
//
// Rules that hold everywhere below:
//   - Nothing is changed silently. Trimmed spaces, a guessed time format, a
//     blank role read as Employee... each one is either shown as a note on the
//     row or must be switched on by HR first (see ImportOptions).
//   - The backend re-validates at commit. The preview is advice, not trust.
//   - platformId comes from the signed-in user, never from the file. A file
//     may NAME a company; it is accepted only if the viewer may act there.
//   - Employee IDs, names, dates and times are never altered or invented.
//     A duplicate is reported, not renumbered.
// ===========================================================================

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import readXlsxFile from "read-excel-file/node";
import { prisma } from "../../lib/prisma.js";
import { accessFor, type Access } from "../../lib/companyAccess.js";
import { canAccess } from "../../lib/companyAccess.logic.js";
import { allocateEmployeeCode } from "./employeeCode.js";
import { sendWelcome } from "../onboarding/onboarding.mail.js";
import { canonicalDesignation, designationNames } from "../../lib/designations.js";

const BCRYPT_COST = 10;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2000;
const ROLES = ["EMPLOYEE", "MANAGER", "HR", "ADMIN"] as const;
type Role = (typeof ROLES)[number];

// ---------------------------------------------------------------------------
// FIELDS
// "required" mirrors the yellow columns in the HR workbook
// (Employee-list-for-tracker.xlsx): Company, Full name, Employee ID, Work
// email, Designation, Team, Reports to (name + ID) and System role. The rest
// are optional. A few required ones may be blank on purpose when HR confirms
// an interpretation (see ImportOptions).
// ---------------------------------------------------------------------------
export const IMPORT_FIELDS = [
  "company",
  "fullName",
  "employeeId",
  "email",
  "mobile",
  "designation",
  "team",
  "projects",
  "role",
  "reportsToName",
  "reportsToId",
  "dateOfJoining",
  "shiftStart",
  "shiftEnd",
  "workingDays",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const FIELD_META: Record<ImportField, { label: string; required: boolean; synonyms: string[] }> = {
  company: { label: "Company", required: true, synonyms: ["company", "companyname", "entity", "platform", "organisation", "organization"] },
  fullName: { label: "Full name", required: true, synonyms: ["fullname", "name", "employeename", "employee", "staffname"] },
  employeeId: { label: "Employee ID", required: true, synonyms: ["employeeid", "empid", "employeecode", "empcode", "staffid", "code"] },
  email: { label: "Work email", required: true, synonyms: ["workemail", "email", "emailaddress", "officialemail", "officeemail"] },
  mobile: { label: "Mobile number", required: false, synonyms: ["mobilenumber", "mobile", "mobileno", "phone", "phonenumber", "contactnumber"] },
  designation: { label: "Designation", required: true, synonyms: ["designation", "jobtitle", "position", "title"] },
  team: { label: "Team or department", required: true, synonyms: ["teamordepartment", "team", "department", "teamdepartment"] },
  projects: { label: "Projects", required: false, synonyms: ["projects", "project", "projectassignment", "projectassignments"] },
  role: { label: "System role", required: true, synonyms: ["systemrole", "role", "accessrole", "userrole"] },
  reportsToName: { label: "Reports to - full name", required: true, synonyms: ["reportstofullname", "reportstoname", "reportsto", "reportingmanager", "reportingmanagername", "managername", "manager"] },
  reportsToId: { label: "Reports to - employee ID", required: true, synonyms: ["reportstoemployeeid", "reportstoid", "reportingmanagerid", "reportingmanageremployeeid", "managerid", "manageremployeeid"] },
  dateOfJoining: { label: "Date of joining", required: false, synonyms: ["dateofjoining", "doj", "joiningdate", "joindate", "dateofjoin"] },
  shiftStart: { label: "Shift start", required: false, synonyms: ["shiftstart", "shiftstarttime", "starttime", "shiftin"] },
  shiftEnd: { label: "Shift end", required: false, synonyms: ["shiftend", "shiftendtime", "endtime", "shiftout"] },
  workingDays: { label: "Working days", required: false, synonyms: ["workingdays", "workdays", "weeklydays"] },
};

export const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export type Cell = string | number | boolean | null;
export type ParsedRow = { rowNumber: number; cells: Cell[]; skip?: "example" | "blank" | "note" };
export type Mapping = Partial<Record<ImportField, number | null>>;

// ---------------------------------------------------------------------------
// OPTIONS: every interpretation HR must switch on. Off means the affected
// rows are rejected, never guessed.
// ---------------------------------------------------------------------------
export type ImportOptions = {
  decimalTimes?: boolean; // 9.30 means 09:30
  pmEndTimes?: boolean; // an end time before the start (6.30 after 09:30) means PM
  blankRoleIsEmployee?: boolean;
  blankEmailUsesPlaceholder?: boolean; // login by employee ID; address like awl-01@company.local
  blankIdIsGenerated?: boolean; // a blank Employee ID gets the company's next ID when saved (never reuses or changes an existing one)
  blankReportsToIsNone?: boolean;
  blankTeamIsNone?: boolean;
  createMissingShifts?: boolean;
  onboarding?: "EXISTING" | "NEW_JOINER"; // existing staff skip document onboarding
};

export type Issue = {
  field: ImportField | "row";
  severity: "error" | "warning";
  code: string;
  message: string;
};

export type RowStatus = "VALID" | "ALREADY_EXISTS" | "INVALID" | "SKIPPED";

export type RowResult = {
  rowNumber: number;
  status: RowStatus;
  skipReason?: string;
  values: {
    company: string;
    fullName: string;
    employeeId: string;
    email: string;
    mobile: string;
    designation: string;
    team: string;
    projects: string;
    role: string;
    reportsTo: string;
    dateOfJoining: string;
    shift: string;
  };
  issues: Issue[];
  notes: string[];
  // Which of HR's confirmations this row relied on (keys of ImportOptions), so
  // the screen can list every rule a file needs in one go.
  rules: string[];
};

// ===========================================================================
// 1. PARSING
// ===========================================================================

function parseCsv(text: string): Cell[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const count = (ch: string) => first.split(ch).length - 1;
  const delimiter = [",", ";", "\t"].sort((a, b) => count(b) - count(a))[0];

  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = "";
  let quoted = false;

  const endField = () => {
    row.push(field === "" ? null : field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) endField();
    else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
    } else field += ch;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

// A spreadsheet date arrives as a JS Date. Over the wire it must be plain
// text, so a real date becomes YYYY-MM-DD and a time-of-day (Excel stores
// those on 1899-12-30) becomes HH:MM. UTC parts are used so the viewer's
// timezone can never move a day.
function cellToPlain(v: unknown): Cell {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    if (v.getUTCFullYear() < 1901) {
      return `${String(v.getUTCHours()).padStart(2, "0")}:${String(v.getUTCMinutes()).padStart(2, "0")}`;
    }
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  return String(v);
}

const isBlank = (c: Cell) => c === null || (typeof c === "string" && c.trim() === "");

function guessMapping(headers: Cell[]): Mapping {
  const used = new Set<number>();
  const out: Mapping = {};
  for (const field of IMPORT_FIELDS) {
    const hit = headers.findIndex((h, i) => !used.has(i) && FIELD_META[field].synonyms.includes(norm(h)));
    if (hit >= 0) {
      out[field] = hit;
      used.add(hit);
    } else out[field] = null;
  }
  return out;
}

function findHeaderRow(data: Cell[][]): number {
  let best = -1;
  let bestScore = 2; // need at least 3 recognisable headings
  for (let i = 0; i < Math.min(data.length, 60); i++) {
    const row = data[i] ?? [];
    const known = new Set<string>();
    for (const c of row) {
      const n = norm(c);
      for (const f of IMPORT_FIELDS) if (FIELD_META[f].synonyms.includes(n)) known.add(f);
    }
    if (known.size > bestScore) {
      bestScore = known.size;
      best = i;
    }
  }
  return best;
}

export async function parseEmployeeFile(input: { fileName: string; contentBase64: string; sheetName?: string }) {
  const buf = Buffer.from(String(input.contentBase64 ?? ""), "base64");
  if (buf.length === 0) throw new Error("EMPTY_FILE");
  if (buf.length > MAX_BYTES) throw new Error("FILE_TOO_LARGE");

  const name = String(input.fileName ?? "").toLowerCase();
  let sheets: { sheet: string; data: Cell[][] }[];

  if (name.endsWith(".xlsx")) {
    // An .xlsx is a zip: it must start with "PK". Anything else is not one,
    // whatever its name says.
    if (!(buf[0] === 0x50 && buf[1] === 0x4b)) throw new Error("NOT_XLSX");
    try {
      // trim:false so stray spaces reach the preview as a visible note
      // instead of being removed before anyone can see them.
      const raw = (await readXlsxFile(buf, { trim: false } as never)) as unknown as {
        sheet: string;
        data: unknown[][];
      }[];
      sheets = raw.map((s) => ({ sheet: s.sheet, data: s.data.map((r) => r.map(cellToPlain)) }));
    } catch {
      throw new Error("UNREADABLE_FILE");
    }
  } else if (name.endsWith(".csv")) {
    sheets = [{ sheet: "CSV", data: parseCsv(buf.toString("utf8")) }];
  } else {
    throw new Error("UNSUPPORTED_FILE");
  }

  if (sheets.length === 0) throw new Error("NO_ROWS");

  const wanted = input.sheetName
    ? sheets.find((s) => s.sheet === input.sheetName)
    : (sheets.find((s) => /employee/i.test(s.sheet)) ??
      sheets.find((s) => findHeaderRow(s.data) >= 0) ??
      sheets[0]);
  const chosen = wanted ?? sheets[0];

  const headerIdx = findHeaderRow(chosen.data);
  if (headerIdx < 0) throw new Error("NO_HEADER_ROW");

  const width = Math.max(...chosen.data.slice(headerIdx).map((r) => r.length), 0);
  const headers = Array.from({ length: width }, (_, i) => {
    const h = chosen.data[headerIdx]?.[i];
    return isBlank(h ?? null) ? "" : String(h).trim();
  });

  const rows: ParsedRow[] = [];
  chosen.data.slice(headerIdx + 1).forEach((cells, i) => {
    const padded = Array.from({ length: width }, (_, c) => cells[c] ?? null);
    if (padded.every(isBlank)) return; // empty formatting rows are not records
    const rowNumber = headerIdx + 2 + i;
    let skip: ParsedRow["skip"];
    // The workbook's sample row says "<- EXAMPLE ROW, leave as it is" in a spare
    // column. Only THAT marker counts: the bare word "example" must not, or any
    // @example.com address would make a real person look like a sample.
    const marked = padded.some((c) => typeof c === "string" && (/\bexample row\b/i.test(c) || /^\s*<-/.test(c)));
    if (marked) skip = "example";
    return void rows.push({ rowNumber, cells: padded, skip });
  });

  if (rows.length === 0) throw new Error("NO_ROWS");
  if (rows.length > MAX_ROWS) throw new Error("TOO_MANY_ROWS");

  const mapping = guessMapping(headers);

  // A row with neither a name nor an ID in the mapped columns is a note or a
  // stray cell, not a person. Marked here so it can never be imported.
  const nameCol = mapping.fullName;
  const idCol = mapping.employeeId;
  for (const r of rows) {
    if (r.skip) continue;
    const hasName = nameCol != null && !isBlank(r.cells[nameCol] ?? null);
    const hasId = idCol != null && !isBlank(r.cells[idCol] ?? null);
    if (!hasName && !hasId) r.skip = "note";
  }

  return {
    sheets: sheets.map((s) => s.sheet),
    sheet: chosen.sheet,
    headerRow: headerIdx + 1,
    ignoredAboveHeader: chosen.data.slice(0, headerIdx).filter((r) => r.some((c) => !isBlank(c))).length,
    headers,
    suggestedMapping: mapping,
    rows,
  };
}

export function importTemplateCsv() {
  const headers = IMPORT_FIELDS.map((f) => FIELD_META[f].label);
  const example = [
    "Avatar", "Priya Nair", "AVT-0003", "priya@avatarindia.com", "98765 43210", "Associate", "Operations", "",
    "Employee", "Neha Sharma", "AVT-0002", "14-01-2025", "10:00", "19:00", "Mon to Sat",
  ];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return (
    "﻿" +
    [headers.concat("Notes"), example.concat("<- EXAMPLE ROW: delete it, or leave it, it is never imported")]
      .map((r) => r.map(esc).join(","))
      .join("\r\n") +
    "\r\n"
  );
}

// ===========================================================================
// 2. VALUE PARSERS
// ===========================================================================

export const text = (c: Cell | undefined) => (c === null || c === undefined ? "" : String(c));

export function dayNumbers(raw: string): { days?: number[]; error?: string } {
  const s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return {};
  if (/alt|alternate|other|please note/.test(s)) {
    return { error: `"${raw.trim()}" is not a fixed weekly pattern. Pick Mon to Sat, Mon to Fri, or list the days (e.g. Mon, Tue, Wed).` };
  }
  const NAMES: Record<string, number> = {
    mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7,
  };
  const range = s.match(/^([a-z]+)\s*(?:to|-|–|—)\s*([a-z]+)$/);
  if (range && NAMES[range[1]] && NAMES[range[2]]) {
    const a = NAMES[range[1]];
    const b = NAMES[range[2]];
    const out: number[] = [];
    for (let d = a; ; d = d === 7 ? 1 : d + 1) {
      out.push(d);
      if (d === b || out.length > 7) break;
    }
    return { days: Array.from(new Set(out)).sort((x, y) => x - y) };
  }
  const parts = s.split(/[,;/ ]+/).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const n = NAMES[p] ?? (/^[1-7]$/.test(p) ? Number(p) : undefined);
    if (!n) return { error: `"${raw.trim()}" contains "${p}", which is not a weekday.` };
    out.push(n);
  }
  return out.length ? { days: Array.from(new Set(out)).sort((x, y) => x - y) } : {};
}

const DAY_LABEL = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export function dayLabel(days: number[]) {
  const d = [...days].sort((a, b) => a - b);
  const consecutive = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return consecutive && d.length > 2 ? `${DAY_LABEL[d[0]]}-${DAY_LABEL[d[d.length - 1]]}` : d.map((x) => DAY_LABEL[x]).join(",");
}

export const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

export type TimeOutcome =
  | { value: string; note?: string }
  | { error: string; needs?: "decimalTimes" }
  | { empty: true };

export function parseTime(cell: Cell | undefined, opts: ImportOptions): TimeOutcome {
  if (cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === "")) return { empty: true };

  if (typeof cell === "number") {
    // 0 < n < 1 is Excel's own "fraction of a day" time value.
    if (cell > 0 && cell < 1) {
      const mins = Math.round(cell * 24 * 60);
      return { value: hhmm(Math.floor(mins / 60) % 24, mins % 60) };
    }
    // Otherwise someone typed 9.30 into a number cell. That could mean 09:30
    // or 9.3 hours (09:18). It is only read as H.MM if HR says so.
    const hours = Math.floor(cell + 1e-9);
    const minutes = Math.round((cell - hours) * 100);
    if (!opts.decimalTimes) {
      return {
        error: `${cell} was typed as a number, so it is unclear whether it means ${hhmm(hours, minutes < 60 ? minutes : 0)}. Tick "Read 9.30 as 09:30" to confirm, or retype it as 09:30.`,
        needs: "decimalTimes",
      };
    }
    if (hours > 23 || minutes > 59) return { error: `${cell} cannot be read as hours.minutes (minutes must be 00-59).` };
    return { value: hhmm(hours, minutes), note: `${cell} read as ${hhmm(hours, minutes)} (hours.minutes)` };
  }

  const s = String(cell).trim();
  // "9.3" or "9.30" typed as TEXT is the same ambiguity as the number 9.3.
  if (/^\d{1,2}\.\d{1,2}$/.test(s)) return parseTime(Number(s), opts);
  const plain = s.match(/^(\d{1,2}):(\d{2})$/);
  if (plain) {
    const h = Number(plain[1]);
    const m = Number(plain[2]);
    if (h > 23 || m > 59) return { error: `"${s}" is not a valid 24-hour time.` };
    return { value: hhmm(h, m) };
  }
  const ampm = s.toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2] ?? 0);
    if (h < 1 || h > 12 || m > 59) return { error: `"${s}" is not a valid time.` };
    if (ampm[3] === "pm" && h !== 12) h += 12;
    if (ampm[3] === "am" && h === 12) h = 0;
    return { value: hhmm(h, m) };
  }
  return { error: `"${s}" is not a time. Use 24-hour format, e.g. 09:30 or 18:30.` };
}

export function parseJoinDate(cell: Cell | undefined): { value?: string; error?: string } {
  if (cell === null || cell === undefined || (typeof cell === "string" && cell.trim() === "")) return {};
  let iso: string | null = null;

  if (typeof cell === "number") {
    // Unformatted spreadsheet serial (days since 1899-12-30).
    if (cell > 20000 && cell < 80000) iso = new Date(Date.UTC(1899, 11, 30) + Math.round(cell) * 86_400_000).toISOString().slice(0, 10);
    else return { error: `${cell} is not a date. Use DD-MM-YYYY.` };
  } else {
    const s = String(cell).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) iso = `${m[1]}-${m[2]}-${m[3]}`;
    else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
      iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    } else return { error: `"${s}" is not a date. Use DD-MM-YYYY (for example 14-01-2025).` };
  }

  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) {
    return { error: `${iso.split("-").reverse().join("-")} is not a real calendar date.` };
  }
  const year = d.getUTCFullYear();
  const limit = Date.now() + 2 * 365 * 86_400_000;
  if (year < 1950 || d.getTime() > limit) return { error: `${iso.split("-").reverse().join("-")} is outside a believable joining date range.` };
  return { value: iso };
}

export function validMobile(raw: string) {
  const digits = raw.replace(/[\s\-().]/g, "");
  return /^\+?\d{10,15}$/.test(digits);
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;

function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}
export const normName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// ===========================================================================
// 3. VALIDATION
// ===========================================================================

export type Viewer = {
  id: string;
  role: string;
  platformId: string;
  access: Access;
};

export async function loadViewer(viewerId: string): Promise<Viewer> {
  const u = await prisma.user.findUnique({ where: { id: viewerId }, select: { id: true, role: true, platformId: true } });
  if (!u) throw new Error("NOT_FOUND");
  return { id: u.id, role: String(u.role), platformId: u.platformId, access: await accessFor(viewerId) };
}

type ManagerRef = { kind: "file"; rowNumber: number } | { kind: "db"; userId: string } | null;

type Plan = {
  platformId: string;
  platformName: string;
  platformSlug: string;
  firstName: string;
  lastName: string;
  employeeCode: string;
  autoId: boolean; // the real ID is generated when saved (employeeCode is then only a stand-in)
  email: string;
  emailIsPlaceholder: boolean;
  phone: string | null;
  designation: string;
  role: Role;
  teamId: string | null;
  projectIds: string[];
  dateOfJoining: string | null;
  manager: ManagerRef;
  shift: { start: string; end: string; days: number[] } | null;
  shiftId: string | null;
};

type Work = {
  result: RowResult;
  plan: Plan | null;
  existingUserId?: string;
  // The raw 'Reports to' cells, resolved in pass 2 once every row is known.
  mgr?: { name: string; id: string };
};

export type PreviewInput = { rows: ParsedRow[]; mapping: Mapping; options?: ImportOptions };

type Lookups = {
  platforms: { id: string; name: string; slug: string }[];
  teams: { id: string; platformId: string; name: string }[];
  shifts: { id: string; platformId: string; startTime: string; endTime: string; workingDays: number[]; name: string }[];
};

async function runValidation(viewer: Viewer, input: PreviewInput) {
  const options = input.options ?? {};
  const mapping = input.mapping ?? {};
  if (input.rows !== undefined && input.rows !== null && !Array.isArray(input.rows)) throw new Error("NO_ROWS");
  const rows = (input.rows ?? []).slice(0, MAX_ROWS + 1);
  if (rows.length > MAX_ROWS) throw new Error("TOO_MANY_ROWS");
  if (rows.length === 0) throw new Error("NO_ROWS");

  const get = (r: ParsedRow, f: ImportField): Cell | undefined => {
    const idx = mapping[f];
    return idx === null || idx === undefined ? undefined : r.cells[idx];
  };

  // --- one batch of reads, then everything is joined in memory ---------------
  const [platformsAll] = await Promise.all([
    prisma.platform.findMany({ select: { id: true, name: true, slug: true } }),
  ]);
  const platformByKey = new Map<string, (typeof platformsAll)[number]>();
  for (const p of platformsAll) {
    platformByKey.set(normName(p.name), p);
    platformByKey.set(normName(p.slug), p);
  }

  const importable = rows.filter((r) => !r.skip);
  const codes = Array.from(
    new Set(
      importable
        .flatMap((r) => [text(get(r, "employeeId")), text(get(r, "reportsToId"))])
        .map((c) => c.trim())
        .filter((c) => c && c.toUpperCase() !== "NONE")
    )
  );
  const emails = Array.from(new Set(importable.map((r) => text(get(r, "email")).trim().toLowerCase()).filter(Boolean)));

  const involvedPlatformIds = Array.from(
    new Set(
      importable
        .map((r) => platformByKey.get(normName(text(get(r, "company")))))
        .filter(Boolean)
        .map((p) => p!.id)
    )
  );

  const [byCode, byEmail, peopleInPlatforms, teams, shifts] = await Promise.all([
    codes.length
      ? prisma.user.findMany({
          where: { OR: codes.map((c) => ({ employeeCode: { equals: c, mode: "insensitive" as const } })) },
          select: { id: true, employeeCode: true, firstName: true, lastName: true, platformId: true, email: true },
        })
      : Promise.resolve([]),
    emails.length
      ? prisma.user.findMany({
          where: { OR: emails.map((e) => ({ email: { equals: e, mode: "insensitive" as const } })) },
          select: { id: true, employeeCode: true, platformId: true, email: true },
        })
      : Promise.resolve([]),
    involvedPlatformIds.length
      ? prisma.user.findMany({
          where: { platformId: { in: involvedPlatformIds } },
          select: { id: true, employeeCode: true, firstName: true, lastName: true, platformId: true, role: true },
        })
      : Promise.resolve([]),
    prisma.team.findMany({ where: { isActive: true }, select: { id: true, platformId: true, name: true } }),
    prisma.shift.findMany({
      where: { isActive: true },
      select: { id: true, platformId: true, startTime: true, endTime: true, workingDays: true, name: true },
    }),
  ]);
  const lookups: Lookups = { platforms: platformsAll, teams, shifts };

  const codeOwner = new Map(byCode.map((u) => [String(u.employeeCode ?? "").toLowerCase(), u]));
  const emailOwner = new Map(byEmail.map((u) => [`${u.platformId}|${String(u.email).toLowerCase()}`, u]));
  const personByCode = new Map(
    peopleInPlatforms.map((u) => [`${u.platformId}|${String(u.employeeCode ?? "").toLowerCase()}`, u])
  );

  const work: Work[] = [];
  const fileByKey = new Map<string, Work>(); // `${platformId}|${code lower}` -> row

  // ---- pass 1: each row on its own -------------------------------------------
  for (const r of rows) {
    const issues: Issue[] = [];
    const notes: string[] = [];
    const err = (field: Issue["field"], code: string, message: string) => issues.push({ field, severity: "error", code, message });
    const warn = (field: Issue["field"], code: string, message: string) => issues.push({ field, severity: "warning", code, message });

    const raw = (f: ImportField) => text(get(r, f));
    const clean = (f: ImportField, label: string) => {
      const v = raw(f);
      const t = v.trim();
      if (t !== v && v !== "") notes.push(`${label}: spaces around "${t}" were trimmed`);
      return t;
    };

    const result: RowResult = {
      rowNumber: r.rowNumber,
      status: "VALID",
      values: {
        company: raw("company").trim(), fullName: raw("fullName").trim(), employeeId: raw("employeeId").trim(),
        email: raw("email").trim(), mobile: raw("mobile").trim(), designation: raw("designation").trim(),
        team: raw("team").trim(), projects: raw("projects").trim(), role: raw("role").trim(),
        reportsTo: [raw("reportsToName").trim(), raw("reportsToId").trim()].filter(Boolean).join(" · "),
        dateOfJoining: raw("dateOfJoining").trim(), shift: "",
      },
      issues,
      notes,
      rules: [],
    };
    const rule = (k: string) => {
      if (!result.rules.includes(k)) result.rules.push(k);
    };

    if (r.skip) {
      result.status = "SKIPPED";
      result.skipReason =
        r.skip === "example" ? "Example row - never imported" : r.skip === "blank" ? "Empty row" : "Not an employee (no name or ID) - treated as a note";
      work.push({ result, plan: null });
      continue;
    }

    // --- company --------------------------------------------------------------
    const companyText = clean("company", "Company");
    const platform = platformByKey.get(normName(companyText));
    let platformId: string | null = null;
    if (!companyText) err("company", "REQUIRED", "Company is required.");
    else if (!platform) err("company", "UNKNOWN_COMPANY", `"${companyText}" is not a company in this system.`);
    else if (!canAccess(viewer.access, platform.id)) {
      err("company", "OUTSIDE_YOUR_COMPANY", `You can only add people to your own company, not "${platform.name}".`);
    } else platformId = platform.id;

    // --- name -------------------------------------------------------------------
    const fullName = clean("fullName", "Full name");
    if (!fullName) err("fullName", "REQUIRED", "Full name is required.");
    const { firstName, lastName } = splitName(fullName);
    if (fullName && !lastName) warn("fullName", "SINGLE_NAME", "Only one name given; the last name will be left blank.");

    // --- employee id ------------------------------------------------------------
    const code = clean("employeeId", "Employee ID");
    let autoId = false;
    if (!code) {
      if (options.blankIdIsGenerated) {
        autoId = true;
        notes.push("Employee ID left blank: the company's next ID is generated when saved (confirmed)");
        rule("blankIdIsGenerated");
      } else err("employeeId", "ID_MISSING", 'Employee ID is blank. Enter one, or tick "Generate the Employee ID automatically".');
    } else if (!ID_RE.test(code)) {
      err("employeeId", "BAD_ID", `"${code}" is not a valid employee ID (letters, numbers, dot, dash, underscore; no spaces; up to 30 characters).`);
    }

    // --- designation ---------------------------------------------------------------
    const designationText = clean("designation", "Designation");
    // One fixed list for every company: the list's own spelling is stored; anything else is rejected, never guessed.
    const designation = canonicalDesignation(designationText) ?? designationText;
    if (!designationText) err("designation", "REQUIRED", "Designation is required.");
    else if (!canonicalDesignation(designationText)) err("designation", "NOT_IN_LIST", `"${designationText}" is not in the designation list. Use one of the listed designations.`);

    // --- role -------------------------------------------------------------------
    const roleText = clean("role", "System role");
    let role: Role = "EMPLOYEE";
    if (!roleText) {
      if (options.blankRoleIsEmployee) {
        notes.push("Role left blank: read as Employee (confirmed)");
        rule("blankRoleIsEmployee");
      }
      else err("role", "ROLE_MISSING", 'System role is blank. Choose a role, or tick "Treat a blank role as Employee".');
    } else {
      const map: Record<string, Role> = { employee: "EMPLOYEE", manager: "MANAGER", hr: "HR", humanresources: "HR", admin: "ADMIN", administrator: "ADMIN" };
      const found = map[norm(roleText)];
      if (!found) err("role", "BAD_ROLE", `"${roleText}" is not a role. Use Employee, Manager, HR or Admin.`);
      else role = found;
    }
    // Giving someone HR or Admin power is an Admin decision, not an HR one.
    if ((role === "HR" || role === "ADMIN") && viewer.role !== "ADMIN") {
      err("role", "ROLE_NOT_ALLOWED", `Only an Admin can create someone with the ${role} role.`);
    }

    // --- email ------------------------------------------------------------------------
    let email = clean("email", "Work email").toLowerCase();
    let emailIsPlaceholder = false;
    if (!email) {
      if (options.blankEmailUsesPlaceholder && platform && (code || autoId)) {
        // A generated ID does not exist yet: a stand-in is used for the preview, and the real one replaces it when saved.
        email = autoId ? `auto-${r.rowNumber}@${platform.slug}.local` : `${code.toLowerCase()}@${platform.slug}.local`;
        emailIsPlaceholder = true;
        notes.push(`No work email: sign-in is by employee ID (placeholder ${email}) (confirmed)`);
        rule("blankEmailUsesPlaceholder");
      } else if (!options.blankEmailUsesPlaceholder) {
        err("email", "EMAIL_MISSING", 'Work email is blank. Enter one, or tick "No work email: sign in with employee ID".');
      }
    } else if (!EMAIL_RE.test(email) || email.length > 254) {
      err("email", "BAD_EMAIL", `"${email}" is not a valid email address.`);
    }

    // --- mobile -------------------------------------------------------------------------
    const mobile = clean("mobile", "Mobile number");
    if (mobile && !validMobile(mobile)) err("mobile", "BAD_MOBILE", `"${mobile}" is not a valid mobile number (10 to 15 digits, optional +).`);

    // --- date of joining ----------------------------------------------------------------
    const doj = parseJoinDate(get(r, "dateOfJoining"));
    if (doj.error) err("dateOfJoining", "BAD_DATE", doj.error);

    // --- team / projects ----------------------------------------------------------------
    let teamId: string | null = null;
    const teamText = clean("team", "Team");
    if (!teamText) {
      if (options.blankTeamIsNone) {
        notes.push("Team left blank: no team assigned (confirmed)");
        rule("blankTeamIsNone");
      }
      else err("team", "TEAM_MISSING", 'Team is blank. Pick one, or tick "Leave blank teams unassigned".');
    } else if (platformId) {
      const t = teams.find((x) => x.platformId === platformId && normName(x.name) === normName(teamText));
      if (!t) err("team", "UNKNOWN_TEAM", `"${teamText}" is not a team in ${platform?.name}. Create it in Admin → Teams first.`);
      else teamId = t.id;
    }
    const projectIds: string[] = [];
    const projectText = raw("projects").trim();
    if (projectText && platformId) {
      for (const name of projectText.split(/[;,|]/).map((s) => s.trim()).filter(Boolean)) {
        const t = teams.find((x) => x.platformId === platformId && normName(x.name) === normName(name));
        if (!t) err("projects", "UNKNOWN_PROJECT", `"${name}" is not a project/team in ${platform?.name}.`);
        else if (t.id !== teamId && !projectIds.includes(t.id)) projectIds.push(t.id);
      }
    }

    // --- shift ---------------------------------------------------------------------------
    let shift: Plan["shift"] = null;
    let shiftId: string | null = null;
    const startO = parseTime(get(r, "shiftStart"), options);
    const endO = parseTime(get(r, "shiftEnd"), options);
    const daysRaw = text(get(r, "workingDays"));
    const daysO = dayNumbers(daysRaw);
    const anyShift = !("empty" in startO) || !("empty" in endO) || daysRaw.trim() !== "";
    if (anyShift) {
      let start: string | null = null;
      let end: string | null = null;
      if ("error" in startO) err("shiftStart", startO.needs ? "TIME_NEEDS_CONFIRMATION" : "BAD_TIME", `Shift start: ${startO.error}`);
      else if ("value" in startO) {
        start = startO.value;
        if (startO.note) {
          notes.push(`Shift start: ${startO.note} (confirmed)`);
          rule("decimalTimes");
        }
      } else err("shiftStart", "SHIFT_INCOMPLETE", "Shift start is missing (end time or days were given).");

      if ("error" in endO) err("shiftEnd", endO.needs ? "TIME_NEEDS_CONFIRMATION" : "BAD_TIME", `Shift end: ${endO.error}`);
      else if ("value" in endO) {
        end = endO.value;
        if (endO.note) {
          notes.push(`Shift end: ${endO.note} (confirmed)`);
          rule("decimalTimes");
        }
      } else err("shiftEnd", "SHIFT_INCOMPLETE", "Shift end is missing (start time or days were given).");

      if (daysO.error) err("workingDays", "BAD_DAYS", daysO.error);
      else if (!daysO.days) err("workingDays", "SHIFT_INCOMPLETE", "Working days are missing (shift times were given).");

      if (start && end && daysO.days) {
        // An end that is not after the start is usually "6.30" meaning 6.30 PM.
        if (end <= start) {
          const [eh, em] = end.split(":").map(Number);
          const asPm = hhmm(eh + 12, em);
          if (eh < 12 && asPm > start) {
            if (options.pmEndTimes) {
              notes.push(`Shift end ${end} is before the start ${start}: read as ${asPm} (PM) (confirmed)`);
              rule("pmEndTimes");
              end = asPm;
            } else {
              err("shiftEnd", "END_BEFORE_START", `Shift end ${end} is not after the start ${start}. If it means ${asPm}, tick "Read an early end time as PM".`);
              end = null;
            }
          } else {
            err("shiftEnd", "END_BEFORE_START", `Shift end ${end} is not after the start ${start}.`);
            end = null;
          }
        }
        if (start && end) {
          shift = { start, end, days: daysO.days };
          result.values.shift = `${start}-${end} ${dayLabel(daysO.days)}`;
          if (platformId) {
            const match = shifts.find(
              (s) =>
                s.platformId === platformId &&
                s.startTime === start &&
                s.endTime === end &&
                s.workingDays.length === daysO.days!.length &&
                s.workingDays.every((d) => daysO.days!.includes(d))
            );
            if (match) shiftId = match.id;
            else if (options.createMissingShifts) {
              notes.push(`Shift ${result.values.shift} does not exist yet: it will be created (confirmed)`);
              rule("createMissingShifts");
            }
            else err("shiftStart", "SHIFT_NOT_FOUND", `No ${result.values.shift} shift exists in ${platform?.name}. Tick "Create shifts that don't exist yet", or add it in Admin → Shifts.`);
          }
        }
      }
    }

    // --- duplicate / existing (against the database) ---------------------------------------
    let existingUserId: string | undefined;
    if (code && ID_RE.test(code)) {
      const hit = codeOwner.get(code.toLowerCase());
      if (hit) {
        const sameCompany = platformId !== null && hit.platformId === platformId;
        const sameName = normName(`${hit.firstName} ${hit.lastName}`) === normName(fullName);
        if (sameCompany && sameName) existingUserId = hit.id;
        else if (canAccess(viewer.access, hit.platformId)) {
          err("employeeId", "ID_TAKEN", `Employee ID ${code} is already used by ${hit.firstName} ${hit.lastName}.`.replace(/\s+\./, "."));
        } else {
          err("employeeId", "ID_TAKEN", `Employee ID ${code} is already used in another company.`);
        }
      }
    }
    if (!existingUserId && platformId && email) {
      const hit = emailOwner.get(`${platformId}|${email}`);
      if (hit) err("email", "EMAIL_TAKEN", `${emailIsPlaceholder ? "The placeholder address" : "That email"} ${email} is already used by employee ${hit.employeeCode ?? ""}.`.trim());
    }

    const plan: Plan | null =
      platform && platformId
        ? {
            platformId, platformName: platform.name, platformSlug: platform.slug, firstName, lastName,
            employeeCode: autoId ? `AUTO#${r.rowNumber}` : code, autoId, email, emailIsPlaceholder, phone: mobile || null, designation, role, teamId,
            projectIds, dateOfJoining: doj.value ?? null, manager: null, shift, shiftId,
          }
        : null;

    // Reporting manager is resolved in pass 2, after every row is known.
    const w: Work = { result, plan, existingUserId, mgr: { name: raw("reportsToName").trim(), id: raw("reportsToId").trim() } };
    work.push(w);
    if (platformId && code) fileByKey.set(`${platformId}|${code.toLowerCase()}`, w);
  }

  // ---- duplicates inside the file (not for rows that already exist) ----------------
  const group = <T,>(items: T[], key: (t: T) => string | null) => {
    const m = new Map<string, T[]>();
    for (const it of items) {
      const k = key(it);
      if (k) m.set(k, [...(m.get(k) ?? []), it]);
    }
    return [...m.values()].filter((g) => g.length > 1);
  };
  const live = work.filter((w) => w.result.status !== "SKIPPED");
  for (const g of group(live, (w) => (w.result.values.employeeId ? w.result.values.employeeId.trim().toLowerCase() : null))) {
    const lines = g.map((w) => w.result.rowNumber).join(", ");
    for (const w of g) {
      if (w.existingUserId) continue;
      w.result.issues.push({ field: "employeeId", severity: "error", code: "DUPLICATE_ID_IN_FILE", message: `Employee ID ${w.result.values.employeeId.trim()} appears on rows ${lines}. Each person needs their own ID; it will not be renumbered for you.` });
    }
  }
  for (const g of group(live, (w) => (w.plan?.email ? `${w.plan.platformId}|${w.plan.email}` : null))) {
    const lines = g.map((w) => w.result.rowNumber).join(", ");
    for (const w of g) {
      if (w.existingUserId) continue;
      w.result.issues.push({ field: "email", severity: "error", code: "DUPLICATE_EMAIL_IN_FILE", message: `Email ${w.plan!.email} appears on rows ${lines}.` });
    }
  }

  // ---- pass 2: reporting managers -----------------------------------------------------
  const nameIndex = new Map<string, { source: "file" | "db"; ref: ManagerRef; code: string; role: string }[]>();
  for (const w of work) {
    if (!w.plan || w.result.status === "SKIPPED") continue;
    const k = `${w.plan.platformId}|${normName(`${w.plan.firstName} ${w.plan.lastName}`)}`;
    nameIndex.set(k, [...(nameIndex.get(k) ?? []), { source: "file", ref: { kind: "file", rowNumber: w.result.rowNumber }, code: w.plan.employeeCode, role: w.plan.role }]);
  }
  for (const u of peopleInPlatforms) {
    const k = `${u.platformId}|${normName(`${u.firstName} ${u.lastName}`)}`;
    nameIndex.set(k, [...(nameIndex.get(k) ?? []), { source: "db", ref: { kind: "db", userId: u.id }, code: u.employeeCode ?? "", role: String(u.role) }]);
  }

  for (const w of work) {
    const mgr = w.mgr;
    if (!w.plan || !mgr) continue;
    const p = w.plan;
    const issue = (code: string, message: string) => w.result.issues.push({ field: "reportsToId", severity: "error", code, message });
    const nameT = mgr.name.trim();
    const idT = mgr.id.trim();
    const isNone = (s: string) => s.toUpperCase() === "NONE";

    if (!nameT && !idT) {
      if (options.blankReportsToIsNone) {
        w.result.notes.push("Reports to left blank: no reporting manager (confirmed)");
        w.result.rules.push("blankReportsToIsNone");
      }
      else issue("MANAGER_MISSING", 'Reports to is blank. Fill it, write NONE for a company head, or tick "Treat a blank Reports to as no manager".');
      continue;
    }
    if (isNone(nameT) || isNone(idT)) continue; // explicit "NONE": top of the chain

    let found: { ref: ManagerRef; code: string; role: string } | null = null;
    if (idT) {
      const f = fileByKey.get(`${p.platformId}|${idT.toLowerCase()}`);
      // A file row that already exists in the database is the database person.
      if (f && f.plan && !f.existingUserId) found = { ref: { kind: "file", rowNumber: f.result.rowNumber }, code: f.plan.employeeCode, role: f.plan.role };
      else {
        const db = personByCode.get(`${p.platformId}|${idT.toLowerCase()}`);
        if (db) found = { ref: { kind: "db", userId: db.id }, code: db.employeeCode ?? "", role: String(db.role) };
      }
      if (!found) {
        const other = codeOwner.get(idT.toLowerCase());
        issue("MANAGER_NOT_FOUND", other && other.platformId !== p.platformId
          ? `Reporting manager ${idT} belongs to a different company.`
          : `Reporting manager ${idT} was not found in ${p.platformName} (neither in this file nor in the system).`);
        continue;
      }
      if (nameT) {
        // The name and the ID must point at the same person.
        const whoFile = fileByKey.get(`${p.platformId}|${idT.toLowerCase()}`);
        const whoDb = personByCode.get(`${p.platformId}|${idT.toLowerCase()}`);
        const actual = whoDb ? `${whoDb.firstName} ${whoDb.lastName}` : whoFile?.plan ? `${whoFile.plan.firstName} ${whoFile.plan.lastName}` : "";
        if (actual && normName(actual) !== normName(nameT)) {
          issue("MANAGER_MISMATCH", `Reports-to name "${nameT}" and ID ${idT} point to different people (${idT} is ${actual.trim()}).`);
          continue;
        }
      }
    } else {
      const hits = nameIndex.get(`${p.platformId}|${normName(nameT)}`) ?? [];
      if (hits.length === 0) { issue("MANAGER_NOT_FOUND", `Reporting manager "${nameT}" was not found in ${p.platformName}.`); continue; }
      if (hits.length > 1) { issue("MANAGER_AMBIGUOUS", `More than one person is called "${nameT}". Add the manager's employee ID.`); continue; }
      found = { ref: hits[0].ref, code: hits[0].code, role: hits[0].role };
    }

    if (found.code.toLowerCase() === p.employeeCode.toLowerCase()) { issue("MANAGER_SELF", "A person cannot report to themselves."); continue; }
    p.manager = found.ref;
    if (found.role === "EMPLOYEE") {
      w.result.issues.push({ field: "reportsToId", severity: "warning", code: "MANAGER_IS_EMPLOYEE", message: `${found.code} has the Employee role. Approvals only work for a Manager, HR or Admin.` });
    }
  }

  // ---- circular reporting ------------------------------------------------------------------
  const byRow = new Map(work.map((w) => [w.result.rowNumber, w]));
  const nextOf = (w: Work) => (w.plan?.manager?.kind === "file" ? byRow.get(w.plan.manager.rowNumber) : undefined);
  for (const w of work) {
    if (!w.plan?.manager || w.plan.manager.kind !== "file") continue;
    const seen = new Set<number>([w.result.rowNumber]);
    let cur = nextOf(w);
    while (cur) {
      if (cur.result.rowNumber === w.result.rowNumber) {
        w.result.issues.push({ field: "reportsToId", severity: "error", code: "CIRCULAR", message: "Circular reporting: following 'Reports to' leads back to this same person." });
        break;
      }
      if (seen.has(cur.result.rowNumber)) break;
      seen.add(cur.result.rowNumber);
      cur = nextOf(cur);
    }
  }

  // ---- a row cannot report to a row that will not be imported -----------------------
  const hasError = (w: Work) => w.result.issues.some((i) => i.severity === "error");
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of work) {
      if (w.result.status === "SKIPPED" || hasError(w) || !w.plan?.manager || w.plan.manager.kind !== "file") continue;
      const m = byRow.get(w.plan.manager.rowNumber);
      if (m && hasError(m)) {
        w.result.issues.push({ field: "reportsToId", severity: "error", code: "MANAGER_ROW_INVALID", message: `Its reporting manager (row ${m.result.rowNumber}) cannot be imported, so this row would have no valid manager.` });
        changed = true;
      }
    }
  }

  // ---- final verdicts ------------------------------------------------------------------------
  for (const w of work) {
    if (w.result.status === "SKIPPED") continue;
    if (w.existingUserId) {
      w.result.status = "ALREADY_EXISTS";
      w.result.issues = w.result.issues.filter((i) => i.code === "SINGLE_NAME" || i.severity === "warning");
      w.result.notes.push("Already in the system with this ID, company and name: skipped, nothing changes");
    } else w.result.status = hasError(w) ? "INVALID" : "VALID";
  }

  const shiftsToCreate: { platformId: string; platformName: string; start: string; end: string; days: number[]; rows: number }[] = [];
  for (const w of work) {
    if (w.result.status !== "VALID" || !w.plan?.shift || w.plan.shiftId) continue;
    const s = w.plan.shift;
    const hit = shiftsToCreate.find((x) => x.platformId === w.plan!.platformId && x.start === s.start && x.end === s.end && x.days.join() === s.days.join());
    if (hit) hit.rows++;
    else shiftsToCreate.push({ platformId: w.plan.platformId, platformName: w.plan.platformName, start: s.start, end: s.end, days: s.days, rows: 1 });
  }

  const count = (s: RowStatus) => work.filter((w) => w.result.status === s).length;
  return {
    work,
    lookups,
    shiftsToCreate,
    summary: {
      total: work.length,
      valid: count("VALID"),
      alreadyExists: count("ALREADY_EXISTS"),
      invalid: count("INVALID"),
      skipped: count("SKIPPED"),
    },
  };
}

// ---------------------------------------------------------------------------
// WHICH CONFIRMATIONS DOES THIS FILE NEED?
// So the screen can show each rule, in plain words, only when a row needs it.
// ---------------------------------------------------------------------------
const CONFIRM_BY_CODE: Record<string, keyof ImportOptions> = {
  TIME_NEEDS_CONFIRMATION: "decimalTimes",
  END_BEFORE_START: "pmEndTimes",
  ID_MISSING: "blankIdIsGenerated",
  ROLE_MISSING: "blankRoleIsEmployee",
  EMAIL_MISSING: "blankEmailUsesPlaceholder",
  MANAGER_MISSING: "blankReportsToIsNone",
  TEAM_MISSING: "blankTeamIsNone",
  SHIFT_NOT_FOUND: "createMissingShifts",
};

export async function previewEmployees(viewerId: string, input: PreviewInput) {
  const viewer = await loadViewer(viewerId);
  const out = await runValidation(viewer, input);

  // Rules that would be needed are found by running the same validation once
  // more with every interpretation switched ON, and seeing which rows relied on
  // which. That way HR is shown the whole list at once, including rules that
  // only come into play after an earlier one (an end time is only compared to
  // the start once both times can be read at all). Nothing from this second
  // run is returned as a result: it is used purely to count.
  const everything: ImportOptions = {
    decimalTimes: true, pmEndTimes: true, blankRoleIsEmployee: true, blankEmailUsesPlaceholder: true, blankIdIsGenerated: true,
    blankReportsToIsNone: true, blankTeamIsNone: true, createMissingShifts: true,
  };
  const hypothetical = await runValidation(viewer, { ...input, options: { ...(input.options ?? {}), ...everything } });

  const needs: Record<string, number> = {};
  for (const w of hypothetical.work) {
    // Only rows that WOULD be importable once everything is confirmed. A row
    // that is also broken for another reason (a duplicate ID, a bad mobile)
    // cannot be rescued by a tick, so it must not make that tick look useful.
    if (w.result.status !== "VALID") continue;
    for (const k of w.result.rules) needs[k] = (needs[k] ?? 0) + 1;
  }
  // ...plus anything the current run already rejected for needing one.
  for (const w of out.work) {
    for (const i of w.result.issues) {
      const key = CONFIRM_BY_CODE[i.code];
      if (key && i.severity === "error") needs[key] = Math.max(needs[key] ?? 0, 1);
    }
  }

  return {
    summary: out.summary,
    needsConfirmation: needs,
    shiftsToCreate: out.shiftsToCreate,
    rows: out.work.map((w) => w.result),
  };
}

// ===========================================================================
// 4. COMMIT
// ===========================================================================

const PASSWORD_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
function randomPassword(length = 12) {
  for (;;) {
    let out = "";
    for (let i = 0; i < length; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
    if (/[A-Z]/.test(out) && /[a-z]/.test(out) && /\d/.test(out)) return out;
  }
}

export type CommitInput = PreviewInput & { confirm?: boolean; expectedValid?: number };

export async function commitEmployees(viewerId: string, input: CommitInput) {
  if (input.confirm !== true) throw new Error("CONFIRM_REQUIRED");

  const viewer = await loadViewer(viewerId);
  const options = input.options ?? {};

  // Validated again from scratch: what the preview said is not trusted.
  const out = await runValidation(viewer, input);
  const valid = out.work.filter((w) => w.result.status === "VALID" && w.plan);
  if (valid.length === 0) throw new Error("NOTHING_TO_IMPORT");
  if (typeof input.expectedValid === "number" && input.expectedValid !== valid.length) throw new Error("PREVIEW_CHANGED");

  // Hash first: bcrypt is slow and must not hold the database transaction open.
  const credentials = valid.map((w) => ({ work: w, password: randomPassword() }));
  const hashes = await Promise.all(credentials.map((c) => bcrypt.hash(c.password, BCRYPT_COST)));

  const existingStaff = options.onboarding !== "NEW_JOINER";
  const shiftsCreated: { company: string; name: string }[] = [];

  try {
    const { idByRow: created, finalByRow } = await prisma.$transaction(
      async (tx) => {
        // 1. shifts that do not exist yet (one per distinct pattern)
        const shiftIds = new Map<string, string>();
        for (const s of out.shiftsToCreate) {
          const base = `${s.start}-${s.end} ${dayLabel(s.days)}`;
          let name = base;
          for (let n = 2; await tx.shift.findFirst({ where: { platformId: s.platformId, name }, select: { id: true } }); n++) name = `${base} (${n})`;
          const sh = await tx.shift.create({
            data: { platformId: s.platformId, name, startTime: s.start, endTime: s.end, workingDays: s.days, spansMidnight: false },
            select: { id: true },
          });
          shiftIds.set(`${s.platformId}|${s.start}|${s.end}|${s.days.join()}`, sh.id);
          shiftsCreated.push({ company: s.platformName, name });
        }

        // 2. everyone, without managers yet
        const idByRow = new Map<number, string>();
        const finalByRow = new Map<number, { code: string; email: string }>();
        for (let i = 0; i < valid.length; i++) {
          const p = valid[i].plan!;
          // A blank ID is generated here, inside this transaction: if anything fails the numbers go back and nothing is skipped.
          const code = p.autoId ? await allocateEmployeeCode(tx, p.platformId) : p.employeeCode;
          const email = p.autoId && p.emailIsPlaceholder ? `${code.toLowerCase()}@${p.platformSlug}.local` : p.email;
          finalByRow.set(valid[i].result.rowNumber, { code, email });
          const shiftId = p.shiftId ?? (p.shift ? (shiftIds.get(`${p.platformId}|${p.shift.start}|${p.shift.end}|${p.shift.days.join()}`) ?? null) : null);
          const user = await tx.user.create({
            data: {
              platformId: p.platformId,
              email,
              passwordHash: hashes[i],
              firstName: p.firstName,
              lastName: p.lastName,
              phone: p.phone,
              employeeCode: code,
              role: p.role,
              status: "INVITED",
              designation: p.designation,
              dateOfJoining: p.dateOfJoining ? new Date(`${p.dateOfJoining}T00:00:00Z`) : null,
              shiftId,
              // Same rules as the existing "Add person": existing staff open the
              // tracker straight away, new joiners wait for documents; either
              // way the temporary password must be changed at first sign-in.
              onboardingStatus: existingStaff ? "ACTIVE" : "OFFER_SENT",
              trackerAccessEnabled: existingStaff,
              accessGrantedAt: existingStaff ? new Date() : null,
              mustChangePassword: true,
            },
            select: { id: true },
          });
          idByRow.set(valid[i].result.rowNumber, user.id);

          if (p.teamId) await tx.teamMember.create({ data: { teamId: p.teamId, userId: user.id, isPrimary: true } });
          for (const projectId of p.projectIds) await tx.teamMember.create({ data: { teamId: projectId, userId: user.id, isPrimary: false } });
        }

        // 3. reporting lines, now that every manager in the file has an id
        for (const v of valid) {
          const m = v.plan!.manager;
          if (!m) continue;
          const managerId = m.kind === "db" ? m.userId : idByRow.get(m.rowNumber);
          if (!managerId) throw new Error("MANAGER_UNRESOLVED");
          await tx.user.update({ where: { id: idByRow.get(v.result.rowNumber)! }, data: { reportsToId: managerId } });
        }
        return { idByRow, finalByRow };
      },
      { timeout: 120_000, maxWait: 20_000 }
    );

    // Real addresses get the existing welcome email, but only for new joiners
    // (it is about documents existing staff do not owe). It never throws.
    const mail = { sent: 0, failed: 0, noEmail: 0, notApplicable: 0 };
    for (const c of credentials) {
      const id = created.get(c.work.result.rowNumber)!;
      if (existingStaff) mail.notApplicable++;
      else if (c.work.plan!.emailIsPlaceholder) mail.noEmail++;
      else {
        const res = await sendWelcome(id, c.password);
        if (res.sent) mail.sent++;
        else mail.failed++;
      }
    }

    return {
      summary: {
        imported: valid.length,
        skippedExisting: out.summary.alreadyExists,
        failed: out.summary.invalid,
        skippedRows: out.summary.skipped,
      },
      shiftsCreated,
      mail,
      // Shown to HR ONCE, here. Only the hash is stored, so this list cannot
      // be fetched again; HR hands each person their own line.
      credentials: credentials.map((c) => ({
        rowNumber: c.work.result.rowNumber,
        userId: created.get(c.work.result.rowNumber) ?? null,
        employeeId: finalByRow.get(c.work.result.rowNumber)?.code ?? c.work.plan!.employeeCode,
        name: `${c.work.plan!.firstName} ${c.work.plan!.lastName}`.trim(),
        company: c.work.plan!.platformName,
        signInWith: c.work.plan!.emailIsPlaceholder ? (finalByRow.get(c.work.result.rowNumber)?.code ?? c.work.plan!.employeeCode) : c.work.plan!.email,
        temporaryPassword: c.password,
      })),
      rows: out.work.map((w) => ({ rowNumber: w.result.rowNumber, status: w.result.status, issues: w.result.issues })),
    };
  } catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (code === "MANAGER_UNRESOLVED") throw e;
    // Any database failure (a clash that appeared after the preview, a dropped
    // connection) rolls the whole batch back. Nothing is half-imported.
    console.error("[employee import] rolled back:", e);
    throw new Error("IMPORT_FAILED");
  }
}

// ===========================================================================
// 5. LOOKUPS FOR THE FORM
// ===========================================================================
export async function employeeLookups(viewerId: string) {
  const viewer = await loadViewer(viewerId);
  const platformWhere = viewer.access.all ? {} : { id: { in: viewer.access.ids } };
  const scope = viewer.access.all ? {} : { platformId: { in: viewer.access.ids } };
  const year = new Date().getUTCFullYear();

  const [companies, teams, shifts, people, managerPool, holidays] = await Promise.all([
    prisma.platform.findMany({ where: platformWhere, select: { id: true, name: true, slug: true, employeeCodePrefix: true }, orderBy: { name: "asc" } }),
    prisma.team.findMany({ where: { ...scope, isActive: true }, select: { id: true, name: true, platformId: true }, orderBy: { name: "asc" } }),
    prisma.shift.findMany({ where: { ...scope, isActive: true }, select: { id: true, name: true, platformId: true, startTime: true, endTime: true, workingDays: true }, orderBy: { name: "asc" } }),
    prisma.user.findMany({
      where: { ...scope, status: { not: "EXITED" } },
      select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true, platformId: true, designation: true },
      orderBy: { firstName: "asc" },
    }),

    // Who may appear in a "reports to" dropdown. MANAGER and ADMIN only: HR
    // administers people, it does not approve their work. Deliberately NOT
    // scoped to one company - several managers run teams across more than
    // one. Same rule as getAdminOptions, so the two lists cannot drift.
    prisma.user.findMany({
      where: { role: { in: ["MANAGER", "ADMIN"] }, status: { not: "EXITED" } },
      select: {
        id: true, firstName: true, lastName: true, employeeCode: true,
        role: true, platformId: true, designation: true,
      },
      orderBy: { firstName: "asc" },
    }),
    prisma.holiday.groupBy({
      by: ["platformId"],
      where: { ...scope, date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } },
      _count: { _all: true },
    }),
  ]);

  const holidayCount = new Map(holidays.map((h) => [h.platformId, h._count._all]));
  // The company's own job-title lists (empty before the migration, or for a company that has not set one up).
  const designations = await prisma.designation
    .findMany({ where: { isActive: true, ...scope }, select: { platformId: true, name: true }, orderBy: { name: "asc" } })
    .catch(() => [] as { platformId: string; name: string }[]);
  // Every job title in use across ALL companies (names only), so a title set up in one company can be picked in another.
  const everyTitle = await prisma.designation
    .findMany({ where: { isActive: true }, select: { name: true }, orderBy: { name: "asc" } })
    .catch(() => [] as { name: string }[]);
  const seen = new Set<string>();
  const allDesignations = everyTitle.map((d) => d.name).filter((n) => (seen.has(n.toLowerCase()) ? false : (seen.add(n.toLowerCase()), true)));
  return {
    year,
    designations: [] as { platformId: string; name: string }[], // per-company lists are no longer used
    allDesignations: designationNames(),
    // Only an Admin may hand out the HR or Admin role.
    roles: (viewer.role === "ADMIN" ? ROLES : (["EMPLOYEE", "MANAGER"] as const)).map((r) => r),
    companies: companies.map((c) => ({ ...c, holidaysThisYear: holidayCount.get(c.id) ?? 0 })),
    teams,
    shifts,
    managers: managerPool.map((p) => ({
      id: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      employeeCode: p.employeeCode,
      role: String(p.role),
      platformId: p.platformId,
      designation: p.designation,
    })),
    defaultCompanyId: viewer.platformId,
  };
}
