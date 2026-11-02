// ---------------------------------------------------------------------------
// ACTIVITY CLASSIFICATION: the ONE place that decides what each kind of away-time is, for the whole HRM.
//
//   Tea, Lunch, Personal (and Other, e.g. the "away between clock-out and clock-in" gap) -> BREAK: counted in break time, use the daily
//       break allowance, appear in break reports.
//   Washroom -> NEUTRAL: tracked and shown on its own, but NOT break time, NOT productive time and it never touches the break allowance.
//   Team Huddle / meetings -> productive (they are not break rows at all; see productiveBreakdown.ts).
//
// Every row in `tracker_breaks` is "away from work", so productive time is still clocked-in time minus ALL of these rows. That is why
// splitting Washroom out changes the Break figure but not productive time and not time on site:
//   time on site = productive + counted break + washroom
// Nothing may add or subtract a break type by name anywhere else; call these functions.
// ---------------------------------------------------------------------------

export type ActivityClass = "BREAK" | "NEUTRAL";

export function classOfBreakType(breakType: string): ActivityClass {
  return String(breakType) === "WASHROOM" ? "NEUTRAL" : "BREAK";
}

export const isCountedBreak = (breakType: string) => classOfBreakType(breakType) === "BREAK";
export const isWashroom = (breakType: string) => classOfBreakType(breakType) === "NEUTRAL";

type BreakLike = { breakType: string; startedAt: Date; endedAt: Date | null };

/** Seconds of one row; an open row runs until `now`. */
export const breakRowSeconds = (b: { startedAt: Date; endedAt: Date | null }, now: Date) =>
  Math.max(0, Math.floor(((b.endedAt ?? now).getTime() - b.startedAt.getTime()) / 1000));

/** Split a session's away-time rows into counted break seconds and washroom seconds. */
export function splitAwayTime(breaks: BreakLike[], now: Date): { breakSeconds: number; washroomSeconds: number } {
  let breakSeconds = 0;
  let washroomSeconds = 0;
  for (const b of breaks) {
    const s = breakRowSeconds(b, now);
    if (isWashroom(b.breakType)) washroomSeconds += s;
    else breakSeconds += s;
  }
  return { breakSeconds, washroomSeconds };
}

/**
 * Break and washroom seconds of one session, worked out from its break ROWS when they are loaded (always right, for old days and new days
 * alike: an older day's stored breakSeconds still includes Washroom, because history is deliberately not rewritten), otherwise from the
 * stored column. Productive time is unaffected either way: it is clocked-in time minus every row.
 */
export function awayOf(s: { breakSeconds: number; breaks?: BreakLike[] }, now: Date): { breakSeconds: number; washroomSeconds: number } {
  // With no rows at all the stored column is the only record there is, so it is used as is.
  return s.breaks && s.breaks.length > 0 ? splitAwayTime(s.breaks, now) : { breakSeconds: s.breakSeconds, washroomSeconds: 0 };
}
