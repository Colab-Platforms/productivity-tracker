// ---------------------------------------------------------------------------
// ATTENDANCE CALENDAR: classify a day by the first check-in time.
// Pure rules, no database. Times are read as the wall clock in the COMPANY's timezone, to the minute (the same precision the existing late rule
// uses: 9:45:40 is "9:45"). This is a view for the calendar only; payroll/Reports keep their own late (grace) and half-day (hours) rules.
// ---------------------------------------------------------------------------

/** One place for the two limits. A per-team override would need a schema change, so these are defaults in code for now. */
export const ARRIVAL_RULES = { presentUntil: "09:45", lateUntil: "10:15" } as const;

export type ArrivalRules = { presentUntil: string; lateUntil: string };
export type ArrivalStatus = "PRESENT" | "LATE" | "HALF_DAY";

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Minutes since local midnight in `timezone`. */
export function localMinuteOfDay(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

/** at or before presentUntil = Present; after it and at or before lateUntil = Late; after lateUntil = Half Day. */
export function classifyArrival(at: Date, timezone: string, rules: ArrivalRules = ARRIVAL_RULES): ArrivalStatus {
  const m = localMinuteOfDay(at, timezone);
  if (m <= toMinutes(rules.presentUntil)) return "PRESENT";
  if (m <= toMinutes(rules.lateUntil)) return "LATE";
  return "HALF_DAY";
}

/** Whole minutes after the Present limit (0 when on time). Shown as the late-arrival indicator. */
export function minutesAfterLimit(at: Date, timezone: string, rules: ArrivalRules = ARRIVAL_RULES): number {
  return Math.max(0, localMinuteOfDay(at, timezone) - toMinutes(rules.presentUntil));
}

export type CalendarStatus = ArrivalStatus | "ABSENT" | "LEAVE" | "HOLIDAY" | "WEEK_OFF" | "NOT_TRACKED" | "NOT_CLOCKED_IN";

/**
 * The calendar's status for one day.
 *  - Someone who checked in is classified by that first check-in, whatever else is true that day.
 *  - Nobody is "Absent" while the day is still in progress: today with no check-in is "Not clocked in yet".
 *  - Everything else comes from the existing attendance engine unchanged (leave, holiday, week-off, not tracked, and its own Absent for
 *    a finished day on which the company was tracking and the person never clocked in).
 * Returns null for days that should show nothing (future days, before joining).
 */
export function calendarStatus(input: { engineStatus: string; loginAt: Date | null; isToday: boolean; timezone: string; rules?: ArrivalRules }): CalendarStatus | null {
  const { engineStatus, loginAt, isToday, timezone, rules } = input;
  if (loginAt) return classifyArrival(loginAt, timezone, rules ?? ARRIVAL_RULES);
  switch (engineStatus) {
    case "FUTURE":
    case "NOT_EMPLOYED":
      return null;
    case "LEAVE":
    case "HOLIDAY":
    case "WEEK_OFF":
    case "NOT_TRACKED":
      return engineStatus;
    case "ABSENT":
    case "HALF_DAY": // the engine only says these for a day with no check-in when it is absent
    case "PRESENT":
      return isToday ? "NOT_CLOCKED_IN" : "ABSENT";
    default:
      return isToday ? "NOT_CLOCKED_IN" : "ABSENT";
  }
}
