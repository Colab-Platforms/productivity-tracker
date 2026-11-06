// Daily task entry rules that need no database: progress, hours, and who may review. Pure, so they can be tested on their own.
//
// PROGRESS (is the work done?) and APPROVAL (has the manager accepted it?) are two separate things:
//   progress: Completed | In Progress | Blocked      (stored as daily_tasks.status + a "blocked" flag in task_entry_details)
//   approval: Pending | Approved | Rejected          (daily_tasks.approvalStatus, untouched)
// A task can be submitted as Completed while its approval is still Pending.

export type Progress = "COMPLETED" | "IN_PROGRESS" | "BLOCKED";
export const PROGRESS_VALUES: Progress[] = ["COMPLETED", "IN_PROGRESS", "BLOCKED"];
export const PROGRESS_LABEL: Record<Progress | "NOT_STARTED", string> = {
  COMPLETED: "Completed",
  IN_PROGRESS: "In Progress",
  BLOCKED: "Blocked",
  NOT_STARTED: "Not started",
};

/** The progress the person picked, or null when none was sent. Anything else is not a valid progress. */
export function parseProgress(v: unknown): Progress | null | "BAD" {
  if (v === undefined || v === null || v === "") return null;
  return PROGRESS_VALUES.find((p) => p === v) ?? "BAD";
}

/** How a progress is stored. "Blocked" is still an unfinished task (status In Progress) with the blocked flag set. */
export function storeProgress(p: Progress): { status: "COMPLETED" | "IN_PROGRESS"; blocked: boolean } {
  if (p === "COMPLETED") return { status: "COMPLETED", blocked: false };
  if (p === "BLOCKED") return { status: "IN_PROGRESS", blocked: true };
  return { status: "IN_PROGRESS", blocked: false };
}

/** The progress to show for a stored task. A finished task is never "blocked"; a never-started legacy task is "Not started". */
export function progressOf(status: string, blocked: boolean): Progress | "NOT_STARTED" {
  if (status === "COMPLETED") return "COMPLETED";
  if (blocked) return "BLOCKED";
  if (status === "IN_PROGRESS") return "IN_PROGRESS";
  return "NOT_STARTED";
}

/** Hours spent: nothing sent = null; otherwise a number from 0 to 24, kept to two decimals. Anything else is "BAD". */
export function parseHours(v: unknown): number | null | "BAD" {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 24) return "BAD";
  return Math.round(n * 100) / 100;
}

/**
 * May this person approve, reject or grade the task?
 *  - A task tagged to an active manager can be reviewed by THAT manager only (nobody else, not another manager, not HR, not an Admin).
 *  - A task with no tag, or tagged to someone who can no longer sign in, keeps the earlier rule: `legacyOk` (the task's project/team manager
 *    or the person's reporting line). HR and Admin are never reviewers just by their role.
 */
export function mayReview(input: { actorId: string; taggedId: string | null; taggedActive: boolean; legacyOk: boolean }): boolean {
  if (input.taggedId && input.taggedActive) return input.actorId === input.taggedId;
  return input.legacyOk;
}
