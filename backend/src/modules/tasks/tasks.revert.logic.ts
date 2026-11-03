// ---------------------------------------------------------------------------
// TASK REVERT / REOPEN: the pure rules (no database), so they can be tested on their own.
//
// A manager (or a higher-level person) can send a Completed task back to In Progress with a required remark, as one of two kinds:
//   PARTIAL  = "Partially completed": part of the work is done, the rest is not.
//   NOT_FULL = "Not fully completed": it was marked completed wrongly / the work was not actually done.
// Both return the task to In Progress and keep the employee's own submission note. The permanent record of every revert (previous and new
// status, kind, who, when, the remark, and the original grade) is written to the immutable audit log. On the task itself the LATEST revert is
// kept in `reviewNote` behind a marker, so the employee sees who/why without any new column or table.
// ---------------------------------------------------------------------------

export type RevertType = "PARTIAL" | "NOT_FULL";
export const REVERT_TYPES: RevertType[] = ["PARTIAL", "NOT_FULL"];
export const REVERT_LABEL: Record<RevertType, string> = { PARTIAL: "Partially completed", NOT_FULL: "Not fully completed" };
export const REVERT_MARK: Record<RevertType, string> = { PARTIAL: "[Reopened: partial] ", NOT_FULL: "[Reopened: not full] " };
/** Every marker starts with this, so reopened tasks can be found with one prefix match. */
export const REVERT_MARK_PREFIX = "[Reopened: ";
export const REMARK_MIN = 3;
export const REMARK_MAX = 300;

export function encodeRevertNote(type: RevertType, remark: string): string {
  return REVERT_MARK[type] + remark.trim();
}

export function decodeRevertNote(reviewNote: string | null | undefined): { type: RevertType; label: string; remark: string } | null {
  const s = String(reviewNote ?? "");
  for (const type of REVERT_TYPES) {
    if (s.startsWith(REVERT_MARK[type])) return { type, label: REVERT_LABEL[type], remark: s.slice(REVERT_MARK[type].length) };
  }
  return null;
}

/** Returns an error code, or null when the remark is acceptable. */
export function checkRemark(remark: unknown): { error: "REMARK_REQUIRED" | "REMARK_TOO_LONG" } | { text: string } {
  const text = typeof remark === "string" ? remark.trim() : "";
  if (text.length < REMARK_MIN) return { error: "REMARK_REQUIRED" };
  if (text.length > REMARK_MAX) return { error: "REMARK_TOO_LONG" };
  return { text };
}

/** May this task be reverted right now? Only an approved task that is currently Completed. A task already sent back is "already reopened". */
export function revertBlock(t: { approvalStatus: string; status: string; reviewNote: string | null; selfManaged: boolean }): "SELF_MANAGED" | "NOT_APPROVED" | "ALREADY_REOPENED" | "NOT_FINISHED_YET" | null {
  if (t.selfManaged) return "SELF_MANAGED";
  if (t.approvalStatus !== "APPROVED") return "NOT_APPROVED";
  if (t.status === "COMPLETED") return null;
  return decodeRevertNote(t.reviewNote) ? "ALREADY_REOPENED" : "NOT_FINISHED_YET";
}

/** What the screens show for a task that was sent back. `resubmitted` = the employee finished it again and it waits for review. */
export function reopenedView(t: { status: string; outcome: string | null; reviewNote: string | null }) {
  const d = decodeRevertNote(t.reviewNote);
  if (!d || t.outcome) return null; // a fresh grade replaces the marker
  return { type: d.type, label: d.label, remark: d.remark, resubmitted: t.status === "COMPLETED" };
}
