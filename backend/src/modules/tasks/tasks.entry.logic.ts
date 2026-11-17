// Daily task entry rules that need no database: progress, hours, and who may review. Pure, so they can be tested on their own.
//
// PROGRESS (is the work done?) and APPROVAL (has the manager accepted it?) are two separate things:
//   progress: To Do | In Progress | Completed | Blocked   (stored as daily_tasks.status + a "blocked" flag in task_entry_details)
//   approval: Pending | Approved | Rejected               (daily_tasks.approvalStatus, untouched)
// A task can be submitted as Completed while its approval is still Pending.
//
// TO DO = planned or assigned, work not started. It is stored as the status the app always had for that (daily_tasks.status = PENDING), so no
// column or table was added and no existing task was changed: every task that was already PENDING simply reads "To Do".
// BLOCKED = cannot go on (dependency, missing information, access or a technical problem); it always carries a written reason.

export type Progress = "TODO" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED";
export const PROGRESS_VALUES: Progress[] = ["TODO", "IN_PROGRESS", "COMPLETED", "BLOCKED"];
export const PROGRESS_LABEL: Record<Progress, string> = {
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  BLOCKED: "Blocked",
};

export const BLOCKED_REASON_MIN = 3;
export const BLOCKED_REASON_MAX = 500;

/** The reason for a Blocked task: required, 3 to 500 characters, trimmed. */
export function checkBlockedReason(v: unknown): string {
  const text = typeof v === "string" ? v.trim() : "";
  if (text.length < BLOCKED_REASON_MIN) throw new Error("BLOCKED_REASON_REQUIRED");
  if (text.length > BLOCKED_REASON_MAX) throw new Error("BLOCKED_REASON_TOO_LONG");
  return text;
}

/** The progress the person picked, or null when none was sent. Anything else is not a valid progress. */
export function parseProgress(v: unknown): Progress | null | "BAD" {
  if (v === undefined || v === null || v === "") return null;
  return PROGRESS_VALUES.find((p) => p === v) ?? "BAD";
}

/** How a progress is stored. "To Do" is the old not-started status (PENDING); "Blocked" is an unfinished task (In Progress) with the blocked flag set. */
export function storeProgress(p: Progress): { status: "PENDING" | "COMPLETED" | "IN_PROGRESS"; blocked: boolean } {
  if (p === "TODO") return { status: "PENDING", blocked: false };
  if (p === "COMPLETED") return { status: "COMPLETED", blocked: false };
  if (p === "BLOCKED") return { status: "IN_PROGRESS", blocked: true };
  return { status: "IN_PROGRESS", blocked: false };
}

/** The progress to show for a stored task. A finished task is never "blocked"; a task that was never started is "To Do". */
export function progressOf(status: string, blocked: boolean): Progress {
  if (status === "COMPLETED") return "COMPLETED";
  if (blocked) return "BLOCKED";
  if (status === "IN_PROGRESS") return "IN_PROGRESS";
  return "TODO";
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

/**
 * Does a task that is still WAITING for its manager's decision show up for this viewer?
 *  - HR: only a task tagged to this HR person (they are that employee's reporting manager); every other waiting task only after approval.
 *  - Admin: yes, as read-only monitoring; the Needs Approval list still contains only what the Admin may decide (canAct).
 *  - Manager (and anyone else): only when the task is theirs to decide (they are the tagged manager, or the task has no usable tag and the
 *    earlier reporting-line rule applies). Another manager's queue stays invisible to them.
 */
export function pendingTaskVisibleTo(role: string, canAct: boolean): boolean {
  // HR sees a waiting task only when it is tagged to them (canAct): the employee's own reporting manager, when that is HR.
  if (role === "HR") return canAct;
  if (role === "ADMIN") return true;
  return canAct;
}

// ---------------------------------------------------------------------------
// DEFAULT PROJECT AND REPORTING MANAGER for a new task, worked out from the employee's own records. Nothing is typed in or hardcoded and
// nothing is guessed: when the records do not give ONE clear answer the field is left empty and the person chooses.
//   project  = the employee's primary team, or, with no primary team, their only team. Two teams and none primary, or two primaries, is ambiguous.
//   manager  = their reporting manager (users.reportsToId), but only if that person can be tagged (an active Manager or Admin the form offers);
//              with no usable reporting manager, an additional reporting manager if there is exactly one that can be tagged.
// The server still saves exactly what the person selected, and still refuses a task with no manager chosen.
// ---------------------------------------------------------------------------
export type DefaultSource = "PRIMARY_TEAM" | "ONLY_TEAM" | "REPORTING_MANAGER" | "ADDITIONAL_MANAGER";
export type EntryDefaults = { projectId: string | null; managerId: string | null; projectSource: DefaultSource | null; managerSource: DefaultSource | null };

export function pickDefaults(i: {
  reportsToId: string | null;
  linkedManagerIds: string[];
  memberships: { teamId: string; isPrimary: boolean }[];
  projectIds: string[]; // the projects the form offers
  managerIds: string[]; // the managers the form offers
}): EntryDefaults {
  const offeredProjects = new Set(i.projectIds);
  const offeredManagers = new Set(i.managerIds);
  const mine = i.memberships.filter((m) => offeredProjects.has(m.teamId));
  let projectId: string | null = null;
  let projectSource: DefaultSource | null = null;
  const primary = mine.filter((m) => m.isPrimary);
  if (primary.length === 1) {
    projectId = primary[0].teamId;
    projectSource = "PRIMARY_TEAM";
  } else if (primary.length === 0 && mine.length === 1) {
    projectId = mine[0].teamId;
    projectSource = "ONLY_TEAM";
  }
  let managerId: string | null = null;
  let managerSource: DefaultSource | null = null;
  if (i.reportsToId && offeredManagers.has(i.reportsToId)) {
    managerId = i.reportsToId;
    managerSource = "REPORTING_MANAGER";
  } else {
    const extra = [...new Set(i.linkedManagerIds)].filter((id) => offeredManagers.has(id));
    if (extra.length === 1) {
      managerId = extra[0];
      managerSource = "ADDITIONAL_MANAGER";
    }
  }
  return { projectId, managerId, projectSource, managerSource };
}
