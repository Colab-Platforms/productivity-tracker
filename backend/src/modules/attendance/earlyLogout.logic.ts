// Early Logout Policy: pure rules, no database. On the 2nd and 4th Saturday of a month the working day ends early (default 16:00).
// Everything here works on plain "YYYY-MM-DD" calendar days (UTC midnight, the way @db.Date comes back) and IST clock times.

export const DEFAULT_EARLY_LOGOUT_TIME = "16:00";
export const EARLY_LOGOUT_SATURDAYS = [2, 4] as const;
export const IST_OFFSET_MINUTES = 330;

export type EarlyLogoutPolicy = {
  enabled: boolean;
  logoutTime: string; // "HH:MM"
  startDate: string | null; // first day the policy applies ("YYYY-MM-DD"); earlier days are never touched
  targetHours: number | null; // expected productive hours on those Saturdays; null = scale the normal target by the person's shift
};

export const POLICY_OFF: EarlyLogoutPolicy = { enabled: false, logoutTime: DEFAULT_EARLY_LOGOUT_TIME, startDate: null, targetHours: null };

/** "16:00" -> 960. Anything that is not a real HH:MM returns null. */
export function parseHHMM(v: string | null | undefined): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** "16:00" -> "4:00 PM". */
export function formatTime12(hhmm: string): string {
  const mins = parseHHMM(hhmm);
  if (mins === null) return hhmm;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** The label shown in the calendar and reports. */
export function earlyLogoutLabel(hhmm: string): string {
  return `Early Logout – ${formatTime12(hhmm)}`;
}

function parseDay(iso: string): { y: number; m: number; d: number } | null {
  const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!mm) return null;
  const y = Number(mm[1]);
  const m = Number(mm[2]);
  const d = Number(mm[3]);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** 1 = first Saturday of its month, 2 = second ... 0 when the day is not a Saturday (or not a real date). */
export function saturdayNumber(iso: string): number {
  const p = parseDay(iso);
  if (!p) return 0;
  if (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() !== 6) return 0;
  return Math.floor((p.d - 1) / 7) + 1;
}

/** True for the 2nd and 4th Saturday of any month, in any year. */
export function isSecondOrFourthSaturday(iso: string): boolean {
  const n = saturdayNumber(iso);
  return n === 2 || n === 4;
}

/** The 2nd and 4th Saturday of one month, as "YYYY-MM-DD". */
export function earlyLogoutSaturdaysOf(year: number, month: number): string[] {
  const out: string[] = [];
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= days; d++) {
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (isSecondOrFourthSaturday(iso)) out.push(iso);
  }
  return out;
}

/** Is this calendar day an early-logout day under the policy? (Whether the person works that day is the engine's call.) */
export function isEarlyLogoutDay(policy: EarlyLogoutPolicy, iso: string): boolean {
  if (!policy.enabled) return false;
  if (parseHHMM(policy.logoutTime) === null) return false;
  if (!policy.startDate || iso < policy.startDate) return false;
  return isSecondOrFourthSaturday(iso);
}

/** IST minutes of the day for an instant. */
export function istMinutesOfDay(at: Date): number {
  const s = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  return s.getUTCHours() * 60 + s.getUTCMinutes();
}

/** The IST calendar day of an instant, "YYYY-MM-DD". */
export function istDayOf(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/**
 * Did the person stay until the early-logout time? True when the last logout falls on that same IST day at or after the time.
 * Exactly 16:00 counts; 15:59 does not. A day that was never closed (no logout) is not judged here.
 */
export function stayedUntil(logoutAt: Date | null, dayIso: string, logoutTime: string): boolean {
  if (!logoutAt) return false;
  const limit = parseHHMM(logoutTime);
  if (limit === null) return false;
  const day = istDayOf(logoutAt);
  if (day > dayIso) return true; // worked past midnight
  if (day < dayIso) return false;
  return istMinutesOfDay(logoutAt) >= limit;
}

/** The end of the scheduled day on an early-logout Saturday: the earlier of the shift end and the policy time. */
export function scheduledEndMinutes(shiftEnd: string | null | undefined, policyTime: string): number | null {
  const p = parseHHMM(policyTime);
  if (p === null) return null;
  const s = parseHHMM(shiftEnd);
  return s === null ? p : Math.min(s, p);
}

/**
 * How much of a normal day an early-logout Saturday is (0 to 1), from the person's own shift:
 * (scheduled end - start) / (shift end - start). 1 when the shift is unknown, spans midnight or is already shorter than the policy day,
 * so nothing is ever scaled up or guessed.
 */
export function scheduleRatio(shift: { startTime?: string | null; endTime?: string | null; spansMidnight?: boolean | null } | null | undefined, policyTime: string): number {
  if (!shift || shift.spansMidnight) return 1;
  const start = parseHHMM(shift.startTime);
  const end = parseHHMM(shift.endTime);
  const policy = parseHHMM(policyTime);
  if (start === null || end === null || policy === null) return 1;
  const normal = end - start;
  if (normal <= 0) return 1;
  const early = Math.min(end, policy) - start;
  if (early <= 0 || early >= normal) return 1;
  return early / normal;
}

/**
 * The expected productive seconds for a person on an early-logout Saturday. A target set in the policy applies to everyone (no shift needed);
 * without one, the normal target is scaled by the person's own shift (unchanged when the shift is unknown).
 */
export function earlyDayTargetSeconds(policy: EarlyLogoutPolicy, normalSeconds: number, shift: Parameters<typeof scheduleRatio>[0]): number {
  if (policy.targetHours !== null && policy.targetHours !== undefined) return Math.round(policy.targetHours * 3600);
  return Math.round(normalSeconds * scheduleRatio(shift, policy.logoutTime));
}

/** Validates what an Admin typed. Returns the clean value or an error code. */
export function checkPolicyInput(input: { enabled?: unknown; logoutTime?: unknown; startDate?: unknown; targetHours?: unknown }):
  | { ok: true; enabled: boolean; logoutTime: string; startDate: string | null; targetHours: number | null }
  | { ok: false; error: "BAD_ENABLED" | "BAD_TIME" | "BAD_START_DATE" | "START_DATE_REQUIRED" | "BAD_TARGET_HOURS" } {
  if (typeof input.enabled !== "boolean") return { ok: false, error: "BAD_ENABLED" };
  const t = typeof input.logoutTime === "string" ? input.logoutTime.trim() : "";
  const mins = parseHHMM(t);
  // An early logout is a time after the working day has started; keep it between 12:00 and 18:59 so a typo cannot cut the day to nothing.
  if (mins === null || mins < 12 * 60 || mins >= 19 * 60) return { ok: false, error: "BAD_TIME" };
  const hhmm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  let startDate: string | null = null;
  if (input.startDate !== undefined && input.startDate !== null && input.startDate !== "") {
    if (typeof input.startDate !== "string" || !parseDay(input.startDate)) return { ok: false, error: "BAD_START_DATE" };
    startDate = input.startDate;
  }
  if (input.enabled && !startDate) return { ok: false, error: "START_DATE_REQUIRED" };
  // Optional expected productive hours for those Saturdays: blank = work it out from each person's shift. 1 to 12 hours, in quarter hours.
  let targetHours: number | null = null;
  if (input.targetHours !== undefined && input.targetHours !== null && input.targetHours !== "") {
    const n = typeof input.targetHours === "number" ? input.targetHours : typeof input.targetHours === "string" ? Number(input.targetHours) : NaN;
    if (!Number.isFinite(n) || n < 1 || n > 12 || Math.abs(n * 4 - Math.round(n * 4)) > 1e-9) return { ok: false, error: "BAD_TARGET_HOURS" };
    targetHours = n;
  }
  return { ok: true, enabled: input.enabled, logoutTime: hhmm, startDate, targetHours };
}
