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

export type CalendarStatus = ArrivalStatus | "ABSENT" | "LEAVE" | "HALF_DAY_LEAVE" | "HOLIDAY" | "WEEK_OFF" | "NOT_TRACKED" | "NOT_CLOCKED_IN";

/**
 * The calendar's status for one day, in this order of priority:
 *  1. Approved leave (a full day is "Leave"; half a day is "Half-day leave", shown apart)
 *  2. Company holiday
 *  3. Scheduled week-off
 *  4. A check-in: classified by the first check-in time (Present / Late / Half day)
 *  5. Absent: a finished scheduled working day on which the company was tracking and there is neither a check-in nor approved leave
 *  6. Not tracked: nobody in the company used the tracker that day
 * Leave, holiday and week-off come from the existing attendance engine (which reads approved leave, the company holiday calendar and the
 * person's shift), so they win even if the person happened to clock in; the worked time is still shown. Nobody is "Absent" while the day is
 * still in progress: today with no check-in is "Not clocked in yet". Returns null for days that show nothing (future, before joining).
 */
export function calendarStatus(input: { engineStatus: string; loginAt: Date | null; isToday: boolean; timezone: string; halfDayLeave?: boolean; rules?: ArrivalRules }): CalendarStatus | null {
  const { engineStatus, loginAt, isToday, timezone, rules } = input;
  if (engineStatus === "LEAVE" || engineStatus === "HOLIDAY" || engineStatus === "WEEK_OFF") return engineStatus;
  if (engineStatus === "FUTURE" || engineStatus === "NOT_EMPLOYED") return loginAt ? classifyArrival(loginAt, timezone, rules ?? ARRIVAL_RULES) : null;
  if (input.halfDayLeave) return "HALF_DAY_LEAVE";
  if (loginAt) return classifyArrival(loginAt, timezone, rules ?? ARRIVAL_RULES);
  switch (engineStatus) {
    case "NOT_TRACKED":
      return engineStatus;
    default: // ABSENT, or the engine's hours-based verdicts for a day with no check-in
      return isToday ? "NOT_CLOCKED_IN" : "ABSENT";
  }
}
