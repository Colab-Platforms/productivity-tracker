// Shared by the employee's Daily Tasks (edit / correction request), the manager's Approvals (Edited label, history, correction requests).
import { PROGRESS_LABEL } from "../_progress/progress";

export type EditedInfo = { at: string | null; count: number } | null;

/** What a task row carries (from /tasks, /tasks/range and the review queue). */
export type EditableTask = {
  id: string;
  title: string;
  description: string | null;
  date: string;
  weight: string;
  approvalStatus: string;
  progress?: string;
  hoursSpent?: number | null;
  projectId?: string | null;
  project?: string | null;
  taggedManagerId?: string | null;
  taggedManager?: string | null;
  blockedNote?: string | null;
  rejectionNote?: string | null;
  rating?: number | null;
  version?: number;
  // DIRECT = the owner edits it; CORRECTION = approved or rated, only a correction request; null = cannot be edited by the owner
  editRoute?: "DIRECT" | "CORRECTION" | null;
  edited?: EditedInfo;
  pendingCorrection?: boolean;
};

export type EditChoices = {
  projects: { id: string; label: string }[];
  managers: { id: string; name: string; role?: string }[];
};

export type FieldChange = { label: string; from: string; to: string };

const ORDER = ["title", "description", "projectId", "managerId", "date", "hoursSpent", "priority", "progress", "blockedReason"] as const;
const LABEL: Record<string, string> = {
  title: "Task",
  description: "Details",
  projectId: "Project",
  managerId: "Reporting manager",
  date: "Task date",
  hoursSpent: "Hours spent",
  priority: "Priority",
  progress: "Progress",
  blockedReason: "Blocked reason",
};

const show = (v: unknown): string => (v === null || v === undefined || v === "" ? "—" : String(v));

/** Old and new value of each changed field, in plain words (names, not ids). */
export function fieldChanges(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const k of ORDER) {
    if (!(k in after) && !(k in before)) continue;
    let from: string, to: string;
    if (k === "projectId") [from, to] = [show(before.project), show(after.project)];
    else if (k === "managerId") [from, to] = [show(before.manager), show(after.manager)];
    else if (k === "progress") [from, to] = [before.progress ? PROGRESS_LABEL[String(before.progress)] ?? show(before.progress) : "—", after.progress ? PROGRESS_LABEL[String(after.progress)] ?? show(after.progress) : "—"];
    else if (k === "priority") [from, to] = [show(String(before.priority ?? "").toLowerCase() || null), show(String(after.priority ?? "").toLowerCase() || null)];
    else if (k === "hoursSpent") [from, to] = [before.hoursSpent == null ? "—" : `${before.hoursSpent} h`, after.hoursSpent == null ? "—" : `${after.hoursSpent} h`];
    else [from, to] = [show(before[k]), show(after[k])];
    out.push({ label: LABEL[k], from, to });
  }
  return out;
}
