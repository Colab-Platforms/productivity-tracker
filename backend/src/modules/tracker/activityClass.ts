// ---------------------------------------------------------------------------
// ACTIVITY CLASSIFICATION: the ONE place that decides what each kind of away-time is, for the whole HRM.
//
//   Tea, Lunch, Personal (and Other, e.g. the "away between clock-out and clock-in" gap) -> BREAK: counted in break time, use the daily
//       break allowance, appear in break reports.
//   Washroom -> NEUTRAL: tracked and shown on its own, but NOT break time, NOT productive time and it never touches the break allowance.
//   Discussion ("Meeting / Team Huddle" chosen from the activity menu, with a remark) -> PRODUCTIVE: an unscheduled talk with a manager or
//       colleague. It is stored as an `OTHER` row whose reason starts with "Discussion: " (no enum change, no migration), it is NOT break
//       time and does not use the allowance, and the time stays inside productive time (nothing subtracts it). It is NOT a scheduled Team
//       Huddle: those are `meeting_participation` records and never mix with these rows.
//   Scheduled Team Huddle / approved meetings -> productive (they are not break rows at all; see productiveBreakdown.ts).
//
// Break and washroom rows come out of the day, so productive time = clocked in - break - washroom, and
//   time on site = productive + counted break + washroom   (a discussion sits INSIDE productive time).
// Nothing may add or subtract a row by type name anywhere else; call these functions.
// ---------------------------------------------------------------------------

export type ActivityClass = "BREAK" | "NEUTRAL" | "PRODUCTIVE";

/** Marks an `OTHER` row as an unscheduled discussion. The remark follows it. */
export const DISCUSSION_PREFIX = "Discussion: ";
export const REMARK_MIN = 3;
export const REMARK_MAX = 300;

type Row = { breakType: string; reason?: string | null };
type BreakLike = Row & { startedAt: Date; endedAt: Date | null };

export const isDiscussion = (b: Row) => String(b.breakType) === "OTHER" && String(b.reason ?? "").startsWith(DISCUSSION_PREFIX);
export const discussionRemark = (b: Row) => (isDiscussion(b) ? String(b.reason).slice(DISCUSSION_PREFIX.length) : null);

export function classOfRow(b: Row): ActivityClass {
  if (isDiscussion(b)) return "PRODUCTIVE";
  return String(b.breakType) === "WASHROOM" ? "NEUTRAL" : "BREAK";
}

/** Kept for callers that only know the type: a bare type can never be a discussion. */
export function classOfBreakType(breakType: string): ActivityClass {
  return classOfRow({ breakType });
}

export const isCountedBreak = (b: string | Row) => (typeof b === "string" ? classOfBreakType(b) : classOfRow(b)) === "BREAK";
export const isWashroom = (b: string | Row) => (typeof b === "string" ? classOfBreakType(b) : classOfRow(b)) === "NEUTRAL";

/** The rows that come out of the day (breaks and washroom). Discussion rows stay in productive time, so this drops them. */
export const awayRows = <T extends Row>(rows: T[]): T[] => rows.filter((r) => !isDiscussion(r));

/** Seconds of one row; an open row runs until `now`. */
export const breakRowSeconds = (b: { startedAt: Date; endedAt: Date | null }, now: Date) =>
  Math.max(0, Math.floor(((b.endedAt ?? now).getTime() - b.startedAt.getTime()) / 1000));

/** Split a session's rows into counted break seconds, washroom seconds and discussion seconds (the last is inside productive time). */
export function splitAwayTime(breaks: BreakLike[], now: Date): { breakSeconds: number; washroomSeconds: number; discussionSeconds: number } {
  let breakSeconds = 0;
  let washroomSeconds = 0;
  let discussionSeconds = 0;
  for (const b of breaks) {
    const s = breakRowSeconds(b, now);
    const c = classOfRow(b);
    if (c === "NEUTRAL") washroomSeconds += s;
    else if (c === "PRODUCTIVE") discussionSeconds += s;
    else breakSeconds += s;
  }
  return { breakSeconds, washroomSeconds, discussionSeconds };
}

/**
 * Break, washroom and discussion seconds of one session, worked out from its break ROWS when they are loaded (always right, for old days
 * and new days alike: an older day's stored breakSeconds still includes Washroom, because history is deliberately not rewritten),
 * otherwise from the stored column. Productive time is unaffected by the split: it is clocked-in time minus break and washroom rows.
 */
export function awayOf(
  s: { breakSeconds: number; breaks?: BreakLike[] },
  now: Date
): { breakSeconds: number; washroomSeconds: number; discussionSeconds: number } {
  // With no rows at all the stored column is the only record there is, so it is used as is.
  return s.breaks && s.breaks.length > 0 ? splitAwayTime(s.breaks, now) : { breakSeconds: s.breakSeconds, washroomSeconds: 0, discussionSeconds: 0 };
}
