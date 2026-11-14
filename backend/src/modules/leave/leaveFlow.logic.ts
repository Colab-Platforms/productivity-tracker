// The leave approval flow as pure rules (no database), so they can be tested on their own.
//
//   Employee -> tagged Manager -> HR (final)
//   Manager  -> mapped Admin   -> HR (final)
//   HR       -> tagged Admin   (final)
//   Admin    -> approved automatically
//
// A request with no first-level step (made before the hierarchy existed, or the person has no valid approver mapped yet) goes straight to
// HR, exactly as it always did; those are flagged for manual configuration.

export type Role = "EMPLOYEE" | "MANAGER" | "HR" | "ADMIN";
export type FirstLevel = "MANAGER" | "ADMIN" | "NONE";

/** Who answers first, by the role of the person asking. */
export function firstLevelFor(requesterRole: string): FirstLevel {
  if (requesterRole === "EMPLOYEE") return "MANAGER";
  if (requesterRole === "MANAGER" || requesterRole === "HR") return "ADMIN";
  return "NONE"; // Admin: nobody
}

/** Does HR give a final approval after the first level? (HR's own leave is final at the Admin; an Admin's needs nobody.) */
export function needsHrFinal(requesterRole: string): boolean {
  return requesterRole === "EMPLOYEE" || requesterRole === "MANAGER";
}

export const AUTO_APPROVED_ROLE = "ADMIN";

export type Stage = "PENDING_MANAGER" | "PENDING_ADMIN" | "PENDING_HR" | "APPROVED" | "REJECTED" | "CANCELLED";

export const STAGE_LABEL: Record<Stage, string> = {
  PENDING_MANAGER: "Pending Manager Approval",
  PENDING_ADMIN: "Pending Admin Approval",
  PENDING_HR: "Pending HR Approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

/**
 * The one status shown everywhere. `requestStatus` is leave_requests.status; `stepStatus` is the first-level step
 * (PENDING | APPROVED | REJECTED | SKIPPED) or null when the request has no step.
 */
export function stageOf(input: { requesterRole: string; requestStatus: string; stepStatus: string | null }): Stage {
  const { requesterRole, requestStatus, stepStatus } = input;
  if (requestStatus === "APPROVED") return "APPROVED";
  if (requestStatus === "REJECTED") return "REJECTED";
  if (requestStatus === "CANCELLED") return "CANCELLED";
  if (stepStatus === "PENDING") return firstLevelFor(requesterRole) === "ADMIN" ? "PENDING_ADMIN" : "PENDING_MANAGER";
  return "PENDING_HR"; // first level done (or none): HR's turn
}

export type Candidate = { id: string; role: string; status: string; platformId: string };

/**
 * May `candidate` be the first-level approver of `requester`? The candidate must be active, never the requester, with the right role
 * (Manager for an employee, Admin for a manager or HR). Employees and managers need the same company; an HR person may tag an Admin of any
 * company they act on (the caller passes that through `companyOk`).
 */
export function approverOk(requester: { id: string; role: string; platformId: string }, candidate: Candidate | null, companyOk = true, ownLine = false): boolean {
  if (!candidate) return false;
  if (candidate.id === requester.id) return false;
  if (candidate.status !== "ACTIVE") return false;
  const need = firstLevelFor(requester.role);
  if (need === "NONE" || candidate.role !== need) return false;
  if (requester.role === "HR") return companyOk;
  // The person's OWN reporting manager (the line an Admin set on purpose, which may cross companies) is accepted whatever company they are in.
  // Anyone else must be of the requester's company.
  return ownLine || candidate.platformId === requester.platformId;
}

/** May this person give the FINAL answer on the request? HR only, and only once the first level has approved (or there was none). */
export type FinalGate = "OK" | "WAITING_FIRST_LEVEL" | "FIRST_LEVEL_REJECTED" | "NOT_FINAL_STAGE";
export function finalGate(input: { requesterRole: string; stepStatus: string | null; actorRole: string; legacyNoStep: boolean }): FinalGate {
  const { requesterRole, stepStatus, actorRole, legacyNoStep } = input;
  if (!needsHrFinal(requesterRole) && !legacyNoStep) return "NOT_FINAL_STAGE"; // HR's own leave is final at the Admin
  if (stepStatus === "PENDING") return "WAITING_FIRST_LEVEL";
  if (stepStatus === "REJECTED") return "FIRST_LEVEL_REJECTED";
  if (actorRole === "HR") return "OK";
  return actorRole === "ADMIN" && legacyNoStep ? "OK" : "NOT_FINAL_STAGE"; // an Admin only closes a legacy request that never had a step
}
