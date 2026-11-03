// "Late Remark": how a day's first check-in sits against the arrival rule (on time up to 09:45, Late up to 10:15, Half Day after), with the late
// duration and the reason the person gave. The classification and the numbers come from the server (the same rule as the Attendance Calendar);
// this only words them. Nothing is invented: when no reason was typed it says "No remark provided".
import { clockTime } from "./format";

export type ArrivalCode = "ON_TIME" | "LATE" | "HALF_DAY" | "ABSENT" | "LEAVE" | "HOLIDAY" | "WEEK_OFF" | "NOT_TRACKED" | "NOT_CLOCKED_IN";

export const ARRIVAL_LABEL: Record<string, string> = {
  ON_TIME: "On time", LATE: "Late", HALF_DAY: "Half Day", ABSENT: "Absent",
  LEAVE: "Leave", HOLIDAY: "Holiday", WEEK_OFF: "Week-off", NOT_TRACKED: "Not tracked", NOT_CLOCKED_IN: "Not in yet",
};

export const ARRIVAL_CHIP: Record<string, string> = {
  ON_TIME: "bg-emerald-100 text-emerald-800", LATE: "bg-amber-100 text-amber-800", HALF_DAY: "bg-orange-100 text-orange-800", ABSENT: "bg-red-100 text-red-700",
  LEAVE: "bg-sky-100 text-sky-800", HOLIDAY: "bg-indigo-100 text-indigo-700", WEEK_OFF: "bg-slate-100 text-slate-500", NOT_TRACKED: "bg-slate-100 text-slate-500", NOT_CLOCKED_IN: "bg-slate-100 text-slate-600",
};

export const NO_REMARK = "No remark provided";

export type ArrivalFields = {
  arrival?: string | null;
  loginAt: string | null;
  arrivalMinutes?: number | null;
  arrivalLimit?: string | null;
  lateReason?: string | null;
  correctedBy?: string | null;
};

export function minutesText(m: number): string {
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
}

/** The "details" part only (no label): check-in, late duration and the reason, for Late and Half Day days. */
export function lateDetail(r: ArrivalFields, tz: string): string {
  if (r.arrival !== "LATE" && r.arrival !== "HALF_DAY") return "";
  const parts = [`checked in ${clockTime(r.loginAt, tz)}`];
  if (r.arrivalMinutes && r.arrivalMinutes > 0) parts.push(`${minutesText(r.arrivalMinutes)} after ${r.arrivalLimit ?? "09:45"}`);
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
