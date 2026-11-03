// ===========================================================================
// DAY MODEL: turns one day of real records into the pieces the timeline draws.
//
// Nothing is invented:
//   - Working time is the stretch from clock-in to clock-out MINUS the breaks.
//     A break is never drawn as work.
//   - Late is only drawn when the tracker stored a late clock-in for that day
//     (shift start + grace); it spans the minutes it recorded.
//   - Overtime is the existing rule: time on site beyond the configured work
//     day, and only once the same alert threshold the scheduler uses is passed.
//   - A day still open today is "ongoing" and ends at "now". An open session on
//     an EARLIER day has no clock-out: it is drawn only as far as the last
//     recorded event and labelled as missing, never stretched to a guess.
// ===========================================================================

import { ceilHour, floorHour, fmtHour, zonedToMs } from "./time";
import { BREAK_LABEL, MEETING_LABEL, type TsDay, type TsSchedule } from "./types";

export type SegKind = "work" | "break" | "washroom" | "overtime" | "late";
export type Seg = { kind: SegKind; start: number; end: number; label: string };

export type DayModel = {
  date: string;
  day: TsDay;
  hasSession: boolean;
  isToday: boolean;
  loginMs: number;
  finishMs: number;
  logoutMs: number | null;
  ongoing: boolean;
  missingClockOut: boolean;
  autoClosed: boolean;
  axisStart: number;
  axisEnd: number;
  ticks: { ms: number; label: string }[];
  segs: Seg[];
  elapsedSeconds: number;
  workSeconds: number;
  breakSeconds: number;
  washroomSeconds: number;
  overtimeSeconds: number;
  lateMinutes: number;
  meetings: { start: number; end: number | null; label: string }[];
  // Unscheduled discussions (Meeting / Team Huddle from the activity menu): working time, listed with the remark in the entry log.
  discussions: { start: number; end: number | null; remark: string }[];
};

const HOUR = 3_600_000;

export function buildDayModel(day: TsDay, tz: string, schedule: TsSchedule, nowMs: number, today: string): DayModel {
  const s = day.session;
  const isToday = day.date === today;
  const empty: DayModel = {
    date: day.date, day, hasSession: false, isToday, loginMs: 0, finishMs: 0, logoutMs: null, ongoing: false,
    missingClockOut: false, autoClosed: false, axisStart: 0, axisEnd: 0, ticks: [], segs: [], elapsedSeconds: 0,
    workSeconds: 0, breakSeconds: 0, washroomSeconds: 0, overtimeSeconds: 0, lateMinutes: 0, meetings: [], discussions: [],
  };
  if (!s) return empty;

  const login = Date.parse(s.loginAt);
  const logout = s.logoutAt ? Date.parse(s.logoutAt) : null;
  const ongoing = logout === null && s.status === "ACTIVE" && isToday;

  // The last thing we actually know happened, for a session that never closed.
  let lastEvent = login;
  for (const b of s.breaks) lastEvent = Math.max(lastEvent, Date.parse(b.endedAt ?? b.startedAt));
  for (const m of s.meetings) if (m.startedAt) lastEvent = Math.max(lastEvent, Date.parse(m.endedAt ?? m.startedAt));

  const finish = logout ?? (ongoing ? Math.max(nowMs, login) : lastEvent);
  const missingClockOut = logout === null && !ongoing;

  // --- breaks, clipped to the session --------------------------------------------------
  const isDiscussionRow = (b: { breakType: string; reason?: string | null }) => b.breakType === "OTHER" && String(b.reason ?? "").startsWith("Discussion: ");
  const breaks = s.breaks
    .filter((b) => !isDiscussionRow(b))
    .map((b) => ({ start: Date.parse(b.startedAt), end: b.endedAt ? Date.parse(b.endedAt) : finish, label: BREAK_LABEL[b.breakType] ?? b.breakType, washroom: b.breakType === "WASHROOM" }))
    .map((b) => ({ ...b, start: Math.max(b.start, login), end: Math.min(b.end, finish) }))
    .filter((b) => b.end > b.start)
    .sort((a, z) => a.start - z.start);

  // --- working time = the gaps between breaks ---------------------------------------------
  const work: { start: number; end: number }[] = [];
  let cursor = login;
  for (const b of breaks) {
    if (b.start > cursor) work.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (finish > cursor) work.push({ start: cursor, end: finish });

  // --- overtime (existing rule) -----------------------------------------------------------------
  const overtimeStart = login + schedule.dailyWorkHours * HOUR;
  const overtimeApplies = finish > overtimeStart + schedule.overtimeAlertMinutes * 60_000;

  const segs: Seg[] = [];
  for (const w of work) {
    if (overtimeApplies && w.end > overtimeStart) {
      if (w.start < overtimeStart) segs.push({ kind: "work", start: w.start, end: overtimeStart, label: "Working time" });
      segs.push({ kind: "overtime", start: Math.max(w.start, overtimeStart), end: w.end, label: "Overtime" });
    } else segs.push({ kind: "work", start: w.start, end: w.end, label: "Working time" });
  }
  // Tea / Lunch / Personal are breaks; Washroom is its own neutral kind (not break time, not productive time).
  for (const b of breaks) segs.push(b.washroom ? { kind: "washroom", start: b.start, end: b.end, label: "Washroom" } : { kind: "break", start: b.start, end: b.end, label: `${b.label} break` });

  // --- late (only what the tracker recorded) -------------------------------------------------------
  let lateStart: number | null = null;
  if (s.wasLateLogin && s.lateByMinutes > 0) {
    lateStart = login - s.lateByMinutes * 60_000;
    segs.push({ kind: "late", start: lateStart, end: login, label: `Late by ${s.lateByMinutes}m` });
  }
  segs.sort((a, z) => a.start - z.start);

  // --- the axis -------------------------------------------------------------------------------------------
  const shift = schedule.shift;
  let shiftStart: number | null = null;
  let shiftEnd: number | null = null;
  if (shift) {
    shiftStart = zonedToMs(day.date, s.shiftStartTime ?? shift.startTime, tz);
    shiftEnd = zonedToMs(day.date, shift.endTime, tz);
    if (shiftEnd <= shiftStart) shiftEnd += 24 * HOUR; // an overnight shift ends the next morning
  }
  const lo = Math.min(login, lateStart ?? login, shiftStart ?? login);
  const hi = Math.max(finish, shiftEnd ?? finish);
  const axisStart = floorHour(lo, tz);
  let axisEnd = ceilHour(hi, tz);
  if (axisEnd - axisStart < 4 * HOUR) axisEnd = axisStart + 4 * HOUR;

  const hours = (axisEnd - axisStart) / HOUR;
  const step = Math.max(1, Math.ceil(hours / 8));
  const ticks: DayModel["ticks"] = [];
  for (let t = axisStart; t <= axisEnd; t += step * HOUR) ticks.push({ ms: t, label: fmtHour(t, tz) });

  const sum = (kind: SegKind) => segs.filter((g) => g.kind === kind).reduce((n, g) => n + (g.end - g.start) / 1000, 0);

  return {
    date: day.date, day, hasSession: true, isToday, loginMs: login, finishMs: finish, logoutMs: logout, ongoing,
    missingClockOut, autoClosed: s.autoClosed, axisStart, axisEnd, ticks, segs,
    elapsedSeconds: Math.max(0, Math.round((finish - login) / 1000)),
    workSeconds: sum("work") + sum("overtime"),
    breakSeconds: sum("break"),
    washroomSeconds: sum("washroom"),
    overtimeSeconds: sum("overtime"),
    lateMinutes: s.wasLateLogin ? s.lateByMinutes : 0,
    discussions: s.breaks.filter(isDiscussionRow).map((b) => ({ start: Date.parse(b.startedAt), end: b.endedAt ? Date.parse(b.endedAt) : null, remark: String(b.reason).slice("Discussion: ".length) })),
    meetings: s.meetings
      .filter((m) => m.startedAt)
      .map((m) => ({ start: Date.parse(m.startedAt!), end: m.endedAt ? Date.parse(m.endedAt) : null, label: m.title ? `${MEETING_LABEL[m.meetingType] ?? "Meeting"}: ${m.title}` : (MEETING_LABEL[m.meetingType] ?? "Meeting") })),
  };
}

export const SEG_COLOR: Record<SegKind, string> = {
  work: "#7c5cfc",
  break: "#38bdf8",
  washroom: "#94a3b8",
  overtime: "#f5b324",
  late: "#ef4444",
};
