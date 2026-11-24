// Manager-assigned tasks: the shapes the server sends and the words/colours the screens use. (Server rules: backend tasks.assigned.logic.ts.)

import type { TaskTimerData } from "../_timer/TaskTimer";
export type Stage = "TODO" | "IN_PROGRESS" | "AWAITING_CONFIRMATION" | "CONFIRMED" | "CANCELLED";

export type AssignedTask = {
  id: string; title: string; description: string | null; priority: string; projectId: string | null; project: string | null;
  employeeId: string; employee: string; employeeCode: string | null; assignedById: string | null; assignedBy: string; assignedOn: string;
  due: string | null; overdue: boolean; stage: Stage; completionNote: string | null; completedAt: string | null; rating?: number | null; confirmedAt: string | null;
  timer?: TaskTimerData; sentBackReason: string | null; commentCount: number; lastComment: { text: string; at: string } | null; updatedAt: string;
};
export type AssignedCounts = { total: number; todo: number; inProgress: number; awaiting: number; confirmed: number; overdue: number };
export type AssignedPayload = { ready: boolean; tasks: AssignedTask[]; counts: AssignedCounts };

export const STAGE_LABEL: Record<Stage, string> = {
  TODO: "To do", IN_PROGRESS: "In progress", AWAITING_CONFIRMATION: "Waiting for confirmation", CONFIRMED: "Confirmed", CANCELLED: "Removed",
};
export const STAGE_CHIP: Record<Stage, string> = {
  TODO: "bg-slate-100 text-slate-600", IN_PROGRESS: "bg-sky-50 text-sky-700", AWAITING_CONFIRMATION: "bg-amber-50 text-amber-700",
  CONFIRMED: "bg-emerald-50 text-emerald-700", CANCELLED: "bg-slate-100 text-slate-400",
};
export const PRIORITY_LABEL: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" };
export const PRIORITY_CHIP: Record<string, string> = { LOW: "bg-[#E7F6F1] text-slate-600", MEDIUM: "bg-sky-50 text-sky-700", HIGH: "bg-amber-50 text-amber-700", CRITICAL: "bg-rose-50 text-rose-700" };

export type FilterKey = "ALL" | "TODO" | "IN_PROGRESS" | "AWAITING_CONFIRMATION" | "CONFIRMED" | "OVERDUE";
export const FILTERS: [FilterKey, string][] = [
  ["ALL", "All"], ["TODO", "To do"], ["IN_PROGRESS", "In progress"], ["AWAITING_CONFIRMATION", "Waiting for confirmation"], ["CONFIRMED", "Confirmed"], ["OVERDUE", "Overdue"],
];
export function matchesFilter(t: AssignedTask, f: FilterKey): boolean {
  if (t.stage === "CANCELLED") return false;
  if (f === "ALL") return true;
  if (f === "OVERDUE") return t.overdue;
  return t.stage === f;
}
export function filterCount(tasks: AssignedTask[], f: FilterKey): number {
  return tasks.filter((t) => matchesFilter(t, f)).length;
}

/** "2026-11-20" -> "20 Nov 2026" without any timezone shift (it is a calendar day, not a moment). */
export function dayLabel(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
