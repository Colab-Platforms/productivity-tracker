// Pure rules for an employee's personal details (no database): what each field accepts, how sheet words are understood, and what is refused.
// Nothing is guessed: a value that cannot be read is refused with a plain message, and a blank means "leave as it is".

export const PERSONAL_FIELDS = [
  "gender", "dateOfBirth", "maritalStatus", "secondaryPhoneCode", "secondaryPhone", "addressLine1", "addressLine2", "city", "state", "country",
  "employeeStatusType", "reportingOffice", "grade", "vertical",
  "phoneCode", "department", "extraField1", "extraField2", "extraField3", "extraField4", "extraField5", "notes",
] as const;
export type PersonalField = (typeof PERSONAL_FIELDS)[number];
export type PersonalValues = Partial<Record<PersonalField, string | null>>;

export const LABEL: Record<PersonalField, string> = {
  gender: "Gender", dateOfBirth: "Date of birth", maritalStatus: "Marital status", secondaryPhoneCode: "Secondary phone code", secondaryPhone: "Secondary contact number",
  addressLine1: "Address line 1", addressLine2: "Address line 2", city: "City", state: "State", country: "Country",
  employeeStatusType: "Employee status", reportingOffice: "Reporting office", grade: "Grade", vertical: "Vertical",
  phoneCode: "Phone code", department: "Department", extraField1: "Extra field 1", extraField2: "Extra field 2", extraField3: "Extra field 3", extraField4: "Extra field 4", extraField5: "Extra field 5", notes: "Notes",
};
/** Personal and sensitive: their VALUES never go into the audit log (only that they changed). */
export const SENSITIVE: PersonalField[] = ["gender", "dateOfBirth", "maritalStatus", "secondaryPhoneCode", "secondaryPhone", "addressLine1", "addressLine2", "city", "state", "country", "phoneCode", "extraField1", "extraField2", "extraField3", "extraField4", "extraField5", "notes"];

const MAX_TEXT: Partial<Record<PersonalField, number>> = { addressLine1: 200, addressLine2: 200, city: 80, state: 80, country: 80, reportingOffice: 120, grade: 60, vertical: 80, department: 120, extraField1: 200, extraField2: 200, extraField3: 200, extraField4: 200, extraField5: 200, notes: 1000 };
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

const GENDER: Record<string, string> = { male: "MALE", m: "MALE", female: "FEMALE", f: "FEMALE", other: "OTHER", others: "OTHER", nonbinary: "OTHER", transgender: "OTHER" };
const MARITAL: Record<string, string> = { single: "SINGLE", unmarried: "SINGLE", nevermarried: "SINGLE", married: "MARRIED", divorced: "DIVORCED", separated: "DIVORCED", widowed: "WIDOWED", widow: "WIDOWED", widower: "WIDOWED" };
const EMP_STATUS: Record<string, string> = { fulltime: "FULL_TIME", ft: "FULL_TIME", parttime: "PART_TIME", pt: "PART_TIME" };

export const DISPLAY: Record<string, Record<string, string>> = {
  gender: { MALE: "Male", FEMALE: "Female", OTHER: "Other" },
  maritalStatus: { SINGLE: "Single / unmarried", MARRIED: "Married", DIVORCED: "Divorced", WIDOWED: "Widowed" },
  employeeStatusType: { FULL_TIME: "Full time", PART_TIME: "Part time" },
};
export const shown = (field: PersonalField, v: string | null | undefined): string => (v ? DISPLAY[field]?.[v] ?? v : "");

const MONTHS: Record<string, number> = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
/** "05th October 2026", "5 Oct 2026", "October 5, 2026", "5-Oct-2026": the month is a WORD, so the order is never ambiguous. Returns YYYY-MM-DD for a real day, else null. */
export function readWordDay(raw: unknown): string | null {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/,/g, " ").replace(/\s+/g, " ");
  let d: number, mon: string, y: number;
  let m = /^(\d{1,2})(?:st|nd|rd|th)?[ \-/.]+([A-Za-z]{3,9})\.?[ \-/.]+(\d{4})$/.exec(s);
  if (m) { d = +m[1]; mon = m[2]; y = +m[3]; }
  else if ((m = /^([A-Za-z]{3,9})\.?[ \-/.]+(\d{1,2})(?:st|nd|rd|th)?[ \-/.]+(\d{4})$/.exec(s))) { mon = m[1]; d = +m[2]; y = +m[3]; }
  else return null;
  const mo = MONTHS[mon.toLowerCase()];
  if (!mo) return null;
  const back = new Date(Date.UTC(y, mo - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A real calendar day. Accepts 2000-01-29, 2000-01-29T00:00:00.000Z (Excel), and day-month-year with / - or . (29-01-2000). Returns YYYY-MM-DD or null. */
export function readDay(raw: unknown): string | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString().slice(0, 10);
  const s = squash(String(raw ?? ""));
  let y: number, m: number, d: number;
  let mt = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
  else return readWordDay(s);
  const back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null; // 30 Feb and the like
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export type Checked = { values: PersonalValues; errors: { field: PersonalField; code: string; message: string }[] };

/**
 * Check what a person typed or a sheet held. `undefined` / blank = not provided (left out, never erased).
 * To REMOVE a stored value on purpose the caller passes `null` (the edit form's "clear" option).
 */
export function checkPersonal(input: Record<string, unknown>, todayIso: string): Checked {
  const values: PersonalValues = {};
  const errors: Checked["errors"] = [];
  const bad = (field: PersonalField, code: string, message: string) => errors.push({ field, code, message });
  for (const f of PERSONAL_FIELDS) {
    if (!(f in input)) continue;
    const raw = input[f];
    if (raw === null) { values[f] = null; continue; } // explicit clear
    if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) continue; // blank = leave as it is
    if (typeof raw !== "string" && typeof raw !== "number" && !(raw instanceof Date)) { bad(f, "BAD_TYPE", `${LABEL[f]} must be text.`); continue; }
    const text = raw instanceof Date ? "" : squash(String(raw));
    switch (f) {
      case "gender": { const v = GENDER[key(text)]; if (v) values[f] = v; else bad(f, "BAD_GENDER", `"${text}" is not Male, Female or Other.`); break; }
      case "maritalStatus": { const v = MARITAL[key(text)]; if (v) values[f] = v; else bad(f, "BAD_MARITAL", `"${text}" is not one of Single / Unmarried, Married, Divorced, Widowed.`); break; }
      case "employeeStatusType": { const v = EMP_STATUS[key(text)]; if (v) values[f] = v; else bad(f, "BAD_EMPLOYEE_STATUS", `"${text}" is not Full time or Part time.`); break; }
      case "dateOfBirth": {
        const day = readDay(raw);
        if (!day) { bad(f, "BAD_DATE", `"${text}" is not a real date (use YYYY-MM-DD).`); break; }
        if (day > todayIso) { bad(f, "FUTURE_DOB", "A date of birth cannot be in the future."); break; }
        const age = (Date.parse(todayIso) - Date.parse(day)) / (365.25 * 86400000);
        if (age < 14) { bad(f, "TOO_YOUNG", "A date of birth that makes the person under 14 is not accepted. Check the year."); break; }
        if (age > 100) { bad(f, "TOO_OLD", "A date of birth that makes the person over 100 is not accepted. Check the year."); break; }
        values[f] = day;
        break;
      }
      case "phoneCode":
      case "secondaryPhoneCode": { const v = text.replace(/^\+/, ""); if (/^\d{1,4}$/.test(v)) values[f] = v; else bad(f, "BAD_PHONE_CODE", `"${text}" is not a phone code (1 to 4 digits, e.g. 91).`); break; }
      case "secondaryPhone": { const dg = text.replace(/[\s()-]/g, "").replace(/^\+/, ""); if (/^\d{6,15}$/.test(dg)) values[f] = dg; else bad(f, "BAD_PHONE", `"${text}" is not a valid phone number (6 to 15 digits).`); break; }
      default: {
        const max = MAX_TEXT[f] ?? 120;
        if (text.length > max) bad(f, "TOO_LONG", `${LABEL[f]} can be at most ${max} characters.`);
        else if (/[<>]/.test(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) bad(f, "BAD_CHARS", `${LABEL[f]} has characters that are not allowed.`);
        else values[f] = text;
      }
    }
  }
  return { values, errors };
}

export type Compared = { field: PersonalField; current: string; proposed: string; kind: "fill" | "same" | "conflict" | "clear" };
/** Compare a stored row with proposed values: which fields would be filled (empty now), left alone (same), conflict (a different value is already there) or cleared. */
export function compare(current: PersonalValues, proposed: PersonalValues): Compared[] {
  const out: Compared[] = [];
  for (const f of PERSONAL_FIELDS) {
    if (!(f in proposed)) continue;
    const now = current[f] ?? null, next = proposed[f] ?? null;
    const same = (now ?? "") === (next ?? "");
    out.push({ field: f, current: shown(f, now), proposed: shown(f, next), kind: next === null ? (now ? "clear" : "same") : same ? "same" : now ? "conflict" : "fill" });
  }
  return out;
}
