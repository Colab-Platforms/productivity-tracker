// Repetitive task flags: who may read and do what. Pure rules (no database), so they are tested directly.
//
// Four kinds of viewer. The employee the flag is ABOUT is always treated as "EMPLOYEE", whatever their role (nobody reviews their own flag).
//   EMPLOYEE  sees: why it was flagged, the matching tasks and dates, the current status and outcome, and their OWN explanations. Never any reviewer text,
//             never who reviewed, never that it was escalated.
//   MANAGER   sees everything of the people they manage except notes private to HR and Admin (HR observations, the escalation to Admin).
//   HR        sees everything in their companies.
//   ADMIN     sees everything in the companies they act on.
// A flag is information for a human. It is never a finding of misconduct and never changes pay, rating, attendance or productivity.

export type Viewer = "EMPLOYEE" | "MANAGER" | "HR" | "ADMIN";
/** EMPLOYEE = everyone who can see the flag; STAFF = manager, HR, Admin; HR_ADMIN = HR and Admin only. */
export type Visibility = "EMPLOYEE" | "STAFF" | "HR_ADMIN";
export type NoteKind = "EXPLANATION" | "MANAGER_COMMENT" | "HR_OBSERVATION" | "ADMIN_NOTE" | "ESCALATION_ADMIN";
export type EventKind = "DETECTED" | "UPDATED" | "STATUS" | "COMMENT" | "ESCALATED";

export function viewerOf(role: string, isSubject: boolean): Viewer {
  if (isSubject) return "EMPLOYEE";
  return role === "MANAGER" || role === "HR" || role === "ADMIN" ? role : "EMPLOYEE";
}

export function canSee(viewer: Viewer, v: Visibility): boolean {
  if (viewer === "HR" || viewer === "ADMIN") return true;
  if (viewer === "MANAGER") return v === "EMPLOYEE" || v === "STAFF";
  return v === "EMPLOYEE";
}

/** What a reviewer's comment becomes: its kind and who may read it. The employee cannot comment (they explain). */
export function commentFor(viewer: Viewer): { kind: NoteKind; visibility: Visibility } | null {
  if (viewer === "MANAGER") return { kind: "MANAGER_COMMENT", visibility: "STAFF" };
  if (viewer === "HR") return { kind: "HR_OBSERVATION", visibility: "HR_ADMIN" };
  if (viewer === "ADMIN") return { kind: "ADMIN_NOTE", visibility: "HR_ADMIN" };
  return null;
}

export const canReview = (v: Viewer) => v === "MANAGER" || v === "HR" || v === "ADMIN";
export const canEscalateToHr = (v: Viewer) => v === "MANAGER";
export const canEscalateToAdmin = (v: Viewer) => v === "HR";

/** The history events of the first version of the flag tables (detection, status, comments, escalation to HR) as each viewer may read them. */
export function eventVisible(viewer: Viewer, kind: EventKind): boolean {
  if (viewer === "EMPLOYEE") return kind === "DETECTED" || kind === "UPDATED" || kind === "STATUS";
  return true;
}
/** A status change is shown to the employee with its new status only: the reviewer's note and name stay private. */
export const eventNoteVisible = (viewer: Viewer, kind: EventKind) => viewer !== "EMPLOYEE" || kind === "DETECTED" || kind === "UPDATED";

export type FlagLite = { status: string; escalatedToHr: boolean; escalatedToAdmin: boolean };
/** The buttons each viewer gets for a flag in its current state (the server re-checks every one). */
export function actionsFor(viewer: Viewer, f: FlagLite, notesReady: boolean) {
  const closed = f.status === "FALSE_POSITIVE" || f.status === "RESOLVED";
  return {
    status: canReview(viewer),
    comment: canReview(viewer),
    escalateHr: canEscalateToHr(viewer) && !f.escalatedToHr && !closed,
    escalateAdmin: canEscalateToAdmin(viewer) && notesReady && !f.escalatedToAdmin && !closed,
    explain: viewer === "EMPLOYEE" && notesReady && !closed,
  };
}

export const OUTCOME_TEXT: Record<string, string> = {
  NEW: "Under review: your manager has been told.",
  UNDER_REVIEW: "Being reviewed.",
  VALID: "Reviewed: the repeated entries were confirmed. This is not a finding of misconduct.",
  FALSE_POSITIVE: "Reviewed: dismissed. The entries were not repetition.",
  RESOLVED: "Closed.",
};
