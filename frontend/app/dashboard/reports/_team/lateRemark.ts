// "Late Remark": how a day's first check-in sits against the arrival rule (on time up to 09:45, Late up to 10:00, Half Day after), with the late
// duration and the reason the person gave. The classification and the numbers come from the server (the same rule as the Attendance Calendar);
// this only words them. Nothing is invented: when no reason was typed it says "No remark provided".
import { clockTime } from "./format";

export type ArrivalCode = "ON_TIME" | "LATE" | "HALF_DAY" | "ABSENT" | "LEAVE" | "HALF_DAY_LEAVE" | "HOLIDAY" | "WEEK_OFF" | "NOT_TRACKED" | "NOT_CLOCKED_IN";

export const ARRIVAL_LABEL: Record<string, string> = {
  ON_TIME: "On time", LATE: "Late", HALF_DAY: "Half Day", ABSENT: "Absent",
  LEAVE: "Leave", HALF_DAY_LEAVE: "Half-day leave", HOLIDAY: "Holiday", WEEK_OFF: "Week-off", NOT_TRACKED: "Not tracked", NOT_CLOCKED_IN: "Not in yet",
};

export const ARRIVAL_CHIP: Record<string, string> = {
  ON_TIME: "bg-emerald-100 text-emerald-800", LATE: "bg-amber-100 text-amber-800", HALF_DAY: "bg-orange-100 text-orange-800", ABSENT: "bg-red-100 text-red-700",
  LEAVE: "bg-sky-100 text-sky-800", HALF_DAY_LEAVE: "bg-cyan-100 text-cyan-800", HOLIDAY: "bg-indigo-100 text-indigo-700", WEEK_OFF: "bg-slate-100 text-slate-500", NOT_TRACKED: "bg-slate-100 text-slate-500", NOT_CLOCKED_IN: "bg-slate-100 text-slate-600",
};

export const NO_REMARK = "No remark provided";

export type ArrivalFields = {
  arrival?: string | null;
  loginAt: string | null;
  arrivalMinutes?: number | null;
  arrivalLimit?: string | null;
  /** a Late turned into a Half Day by the 3rd-late-working-day-in-a-row rule */
  arrivalStreak?: boolean;
  lateReason?: string | null;
  correctedBy?: string | null;
};

/**
 * The ONE rule for "this day is a late arrival", used by every summary count and the late-arrival sheet so they can never disagree with the daily rows.
 * The daily rows classify the first check-in against the arrival rule (on time up to 09:45, Late up to 10:15, Half Day after), so Late and Half Day both
 * count. Only when a row carries no arrival classification at all (an older answer) does the shift-based late minutes decide. A typed remark is NEVER
 * part of this: a late day with no remark is still a late arrival. HR-approved corrections already change the check-in time the classification is made from.
 */
export function isLateArrival(r: { arrival?: string | null; lateMinutes?: number | null }): boolean {
  if (r.arrival === "LATE" || r.arrival === "HALF_DAY") return true;
  if (r.arrival) return false; // classified as on time (or absent, leave, holiday ...): the arrival rule has spoken
  return (r.lateMinutes ?? 0) > 0;
}

/** A reason the person actually typed (not the words "No remark provided"). Counted on its own, apart from late arrivals. */
export function hasTypedRemark(r: { lateReason?: string | null }): boolean {
  return typeof r.lateReason === "string" && r.lateReason.trim().length > 0;
}

export function minutesText(m: number): string {
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
}

/** The "details" part only (no label): check-in, late duration and the reason, for Late and Half Day days. */
export function lateDetail(r: ArrivalFields, tz: string): string {
  if (r.arrival !== "LATE" && r.arrival !== "HALF_DAY") return "";
  const parts = [`checked in ${clockTime(r.loginAt, tz)}`];
  if (r.arrivalMinutes && r.arrivalMinutes > 0) parts.push(`${minutesText(r.arrivalMinutes)} after ${r.arrivalLimit ?? "09:45"}`);
  if (r.arrivalStreak) parts.push("3rd late working day in a row: counted as a half day");
  parts.push(r.lateReason ? `Reason: ${r.lateReason}` : NO_REMARK);
  return parts.join(" · ");
}

/** One line for a table cell, CSV or Excel. */
export function lateRemarkText(r: ArrivalFields, tz: string): string {
  const code = r.arrival;
  if (!code) return "";
  const label = ARRIVAL_LABEL[code] ?? code;
  let text = label;
  if (code === "ON_TIME") text = `${label} · ${clockTime(r.loginAt, tz)}`;
  else if (code === "LATE" || code === "HALF_DAY") text = `${label} · ${lateDetail(r, tz)}`;
  if (r.correctedBy && r.loginAt) text += ` · Corrected by ${r.correctedBy}`;
  return text;
}
