// Progress of a task (is the work done?), shown the same way on every screen. It is separate from APPROVAL (has the manager accepted it?).
//   To Do        planned or assigned, work not started
//   In Progress  work has started
//   Completed    finished
//   Blocked      cannot go on (dependency, missing information, access or a technical problem): always has a written reason

export type ProgressValue = "TODO" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED";

export const PROGRESS_OPTIONS: { value: ProgressValue; label: string }[] = [
  { value: "TODO", label: "To Do" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "BLOCKED", label: "Blocked" },
];

// NOT_STARTED is the old name for To Do; it is still understood so nothing breaks if a screen or an older response says it.
export const PROGRESS_LABEL: Record<string, string> = {
  TODO: "To Do",
  NOT_STARTED: "To Do",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  BLOCKED: "Blocked",
  CANCELLED: "Cancelled",
};

export const PROGRESS_CHIP_CLASS: Record<string, string> = {
  TODO: "bg-slate-100 text-slate-600",
  NOT_STARTED: "bg-slate-100 text-slate-600",
  IN_PROGRESS: "bg-sky-50 text-sky-700",
  COMPLETED: "bg-emerald-50 text-emerald-700",
  BLOCKED: "bg-amber-100 text-amber-900",
  CANCELLED: "bg-slate-100 text-slate-500",
};

export const BLOCKED_REASON_MIN = 3;
export const BLOCKED_REASON_MAX = 500;

/** What is wrong with a blocked reason, in words, or null. The server checks the same rule. */
export function blockedReasonProblem(text: string): string | null {
  const t = text.trim();
  if (t.length < BLOCKED_REASON_MIN) return "Say what is blocking this task (at least 3 characters).";
  if (t.length > BLOCKED_REASON_MAX) return `Keep the blocked reason to ${BLOCKED_REASON_MAX} characters or fewer.`;
  return null;
}

/** The progress to show: the old name is mapped to To Do. */
export const normalProgress = (p: string | undefined | null): string => (p === "NOT_STARTED" ? "TODO" : p ?? "");
