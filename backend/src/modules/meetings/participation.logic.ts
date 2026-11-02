// ---------------------------------------------------------------------------
// The RULES of in-person participation, as plain functions of times (no database), so every boundary can be tested.
// All times are exact instants (UTC). Participation is SELF-REPORTED: these rules judge declared times, nothing more.
// ---------------------------------------------------------------------------

/** People may press "I'm in the Meeting" from this many minutes before the scheduled start. */
export const JOIN_EARLY_MINUTES = 15;
const MIN = 60_000;

export type JoinWindow = { open: boolean; reason: "TOO_EARLY" | "CLOSED" | null; opensAt: Date; closesAt: Date };

/**
 * The join window runs from 15 minutes before the start until the expected end, both ends inclusive.
 * After it closes only the organizing manager can add someone (a correction).
 */
export function joinWindow(startsAt: Date, endsAt: Date, now: Date): JoinWindow {
  const opensAt = new Date(startsAt.getTime() - JOIN_EARLY_MINUTES * MIN);
  const closesAt = endsAt;
  if (now.getTime() < opensAt.getTime()) return { open: false, reason: "TOO_EARLY", opensAt, closesAt };
  if (now.getTime() > closesAt.getTime()) return { open: false, reason: "CLOSED", opensAt, closesAt };
  return { open: true, reason: null, opensAt, closesAt };
}

/** A late joiner declared joining MORE than `lateAfterMinutes` after the scheduled start (exactly on the line is on time). */
export function isLate(joinedAt: Date, startsAt: Date, lateAfterMinutes: number): boolean {
  return joinedAt.getTime() > startsAt.getTime() + lateAfterMinutes * MIN;
}

/** Whole minutes after the start, only meaningful for a late joiner. */
export function minutesAfterStart(joinedAt: Date, startsAt: Date): number {
  return Math.max(0, Math.floor((joinedAt.getTime() - startsAt.getTime()) / MIN));
}

/** Declared as joined, never ended, and the expected end has passed: flagged, never closed automatically. */
export function isStillActivePastEnd(p: { leftAt: Date | null }, endsAt: Date, now: Date): boolean {
  return p.leftAt === null && now.getTime() > endsAt.getTime();
}

export function durationSeconds(joinedAt: Date, leftAt: Date): number {
  return Math.max(0, Math.floor((leftAt.getTime() - joinedAt.getTime()) / 1000));
}

export type PState = "NOT_JOINED" | "IN_MEETING" | "ENDED";
export const stateOf = (p: { leftAt: Date | null } | null): PState => (!p ? "NOT_JOINED" : p.leftAt ? "ENDED" : "IN_MEETING");

/**
 * Actual length of the meeting as people declared it: first declared join to last declared exit. If anyone is still
 * "in" it runs to `now` (and `ongoing` says so). null when nobody joined.
 */
export function actualSpan(rows: { joinedAt: Date; leftAt: Date | null }[], now: Date): { seconds: number; ongoing: boolean } | null {
  if (rows.length === 0) return null;
  const start = Math.min(...rows.map((r) => r.joinedAt.getTime()));
  const ongoing = rows.some((r) => r.leftAt === null);
  const end = Math.max(...rows.map((r) => (r.leftAt ? r.leftAt.getTime() : now.getTime())));
  return { seconds: Math.max(0, Math.floor((end - start) / 1000)), ongoing };
}

// ---------------------------------------------------------------------------
// Invitation status, as the person (and the organizer) sees it. Worked out from three facts, never stored:
//   the person's answer (none / ACCEPTED / DECLINED), their participation record (none / still in / ended), and whether the meeting is over.
// ---------------------------------------------------------------------------
export type InviteStatus = "INVITED" | "ACCEPTED" | "DECLINED" | "JOINED" | "COMPLETED" | "NOT_JOINED";

export function inviteStatus(o: {
  response: "ACCEPTED" | "DECLINED" | null;
  participation: { leftAt: Date | null } | null;
  meetingOver: boolean;
  tracked: boolean; // "Not joined" only means something where joining is tracked
}): InviteStatus {
  if (o.participation) return o.participation.leftAt ? "COMPLETED" : "JOINED";
  if (o.response === "DECLINED") return "DECLINED";
  if (o.meetingOver && o.tracked) return "NOT_JOINED";
  if (o.response === "ACCEPTED") return "ACCEPTED";
  return "INVITED";
}

/** May this person still answer (accept or change their answer)? Invitees only, while the meeting is scheduled and not over. */
export const canRespondNow = (o: { isInvitee: boolean; cancelled: boolean; meetingOver: boolean; joined: boolean }) => o.isInvitee && !o.cancelled && !o.meetingOver && !o.joined;
