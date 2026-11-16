// Late (previous-day) task submissions: the rules that need no database. Pure, so they can be tested on their own.
//
//  - A previous date is any day BEFORE today (company timezone), counted in calendar days.
//  - Within `allowedDays` (company setting, default 3) it is accepted, flagged "Late submission", reason optional.
//  - Older than that but not older than MAX_BACKDATE_DAYS (14) it needs a written reason; it still goes to the tagged manager.
//  - Older than 14 days is never accepted. Today and the future are not "previous" dates.

export const MAX_BACKDATE_DAYS = 14;
export const DEFAULT_ALLOWED_DAYS = 3;
export const REASON_MIN = 3;
export const REASON_MAX = 300;

/** Whole calendar days from `date` to `today` (both are UTC-midnight day stamps). 1 = yesterday. */
export function daysBefore(today: Date, date: Date): number {
  return Math.round((today.getTime() - date.getTime()) / 86400000);
}

/** The company setting as a number from 0 to 14, or "BAD". */
export function parseAllowedDays(v: unknown): number | "BAD" {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_BACKDATE_DAYS ? n : "BAD";
}

export type LateCheck = { lateByDays: number; outsideWindow: boolean; reason: string | null };

export function checkBackdate(input: { forDate: Date; today: Date; allowedDays: number; reason?: unknown }): LateCheck {
  const lateByDays = daysBefore(input.today, input.forDate);
  if (lateByDays < 1) throw new Error("BACKDATE_NOT_PAST");
  if (lateByDays > MAX_BACKDATE_DAYS) throw new Error("BACKDATE_TOO_OLD");
  const outsideWindow = lateByDays > input.allowedDays;
  const text = typeof input.reason === "string" ? input.reason.trim() : "";
  if (text.length > REASON_MAX) throw new Error("LATE_REASON_TOO_LONG");
  if (outsideWindow && text.length < REASON_MIN) throw new Error("LATE_REASON_REQUIRED");
  return { lateByDays, outsideWindow, reason: text || null };
}
