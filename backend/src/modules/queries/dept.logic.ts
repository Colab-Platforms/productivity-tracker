// Query Desk department requests: the pure rules (no database), so they can be tested on their own.
// Two SEPARATE statuses: approvalStatus (who has agreed) and workStatus (what the department is doing, only after final approval).

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export const isPriority = (v: unknown): v is (typeof PRIORITIES)[number] => PRIORITIES.includes(v as never);

export type Approval = "PENDING_MANAGER" | "PENDING_ADMIN" | "APPROVED" | "REJECTED";
export type Work = "AWAITING_ACTION" | "NOT_STARTED" | "IN_PROGRESS" | "ON_HOLD" | "COMPLETED" | "REOPENED";

export const APPROVAL_LABEL: Record<Approval, string> = {
  PENDING_MANAGER: "Pending Manager Approval",
  PENDING_ADMIN: "Pending Admin Approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};
export const WORK_LABEL: Record<Work, string> = {
  AWAITING_ACTION: "Awaiting Department Action",
  NOT_STARTED: "Not Started",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold",
  COMPLETED: "Completed",
  REOPENED: "Reopened",
};
export const PRIORITY_LABEL: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "Urgent" };

/** What the department may set while working (Awaiting and Reopened are set by the system). */
export const SETTABLE_WORK = ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD", "COMPLETED"] as const;
export type SettableWork = (typeof SETTABLE_WORK)[number];

export type Viewer = {
  id: string;
  role: string;
  access: { all: boolean; ids: string[] };
  deptIds: string[]; // departments this person is a member of
  reportIds: ReadonlySet<string>; // people on this person's team (managers only)
};
export type Facts = {
  raisedById: string;
  platformId: string;
  departmentId: string;
  approvalStatus: Approval;
  workStatus: Work | null;
  managerId: string | null;
  adminApproverIds: readonly string[];
  assigneeId: string | null;
  confirmedAt: Date | string | null;
  /** The Admin the EMPLOYEE individually tagged when raising it (null = nobody; routing alone is not a tag). */
  taggedAdminId?: string | null;
};

const inScope = (v: Viewer, platformId: string) => v.access.all || v.access.ids.includes(platformId);
const isStaffInScope = (v: Viewer, t: Facts) => (v.role === "ADMIN" || v.role === "HR") && inScope(v, t.platformId);
const isDeptMember = (v: Viewer, t: Facts) => v.deptIds.includes(t.departmentId) && t.raisedById !== v.id;

// --- who the request goes to ----------------------------------------------------------------------------------------------
export type Boss = { id: string; role: string; status: string } | null;

/**
 * Stage 1: the person's own reporting manager, only when that person is an ACTIVE manager and is not the requester.
 * An Employee's boss who is an Admin/HR (or nobody) means there is no manager step: the request goes straight to the Admin stage.
 * A manager who raises a request has no manager step either (their boss is the Admin who approves).
 */
export function firstApprover(requester: { id: string; role: string }, boss: Boss): string | null {
  if (!boss || boss.id === requester.id || boss.status !== "ACTIVE") return null;
  if (requester.role === "MANAGER") return null;
  return boss.role === "MANAGER" ? boss.id : null;
}

/**
 * Stage 3 approver = the Admin the chain leads to: the manager's own boss when there is a manager step, otherwise the requester's
 * boss. `above` is that boss. Only an ACTIVE Admin who is not the requester counts; anything else means "no mapped Admin".
 */
export function mappedAdmin(requesterId: string, above: Boss): string | null {
  return above && above.role === "ADMIN" && above.status === "ACTIVE" && above.id !== requesterId ? above.id : null;
}

// --- reading -----------------------------------------------------------------------------------------------------------------
/** Oversight = the people who may read the approval comments: the asked manager, the Admin approvers, a manager of the requester, Admin/HR of the company. */
export function isOversight(v: Viewer, t: Facts): boolean {
  if (t.managerId === v.id || t.adminApproverIds.includes(v.id)) return true;
  if (v.role === "MANAGER" && v.reportIds.has(t.raisedById)) return true;
  return isStaffInScope(v, t);
}

/**
 * May this person open this request?
 *  - the person who raised it;
 *  - the manager asked, a manager of the requester's team, the named Admin approvers, Admin/HR of the company (monitoring);
 *  - a member of the tagged department, ONLY once the request is fully approved;
 *  - whoever is assigned to it.
 * Anyone else is told it does not exist.
 */
export function canView(v: Viewer, t: Facts): boolean {
  if (t.raisedById === v.id) return true;
  if (isOversight(v, t)) return true;
  if (t.assigneeId === v.id && t.approvalStatus === "APPROVED") return true;
  return t.approvalStatus === "APPROVED" && isDeptMember(v, t);
}

export type NoteVisibility = "ALL" | "APPROVERS" | "DEPT";
/** The employee sees only ALL notes; department members see ALL and DEPT; oversight sees everything. */
export function canSeeNote(v: Viewer, t: Facts, vis: NoteVisibility): boolean {
  if (vis === "ALL") return true;
  if (isOversight(v, t)) return true;
  if (vis === "DEPT") return t.approvalStatus === "APPROVED" && isDeptMember(v, t);
  return false;
}

// --- approvals ---------------------------------------------------------------------------------------------------------------
export const canManagerDecide = (v: Viewer, t: Facts) => t.approvalStatus === "PENDING_MANAGER" && t.managerId === v.id && t.raisedById !== v.id;
export const canAdminDecide = (v: Viewer, t: Facts) =>
  t.approvalStatus === "PENDING_ADMIN" && v.role === "ADMIN" && t.adminApproverIds.includes(v.id) && t.raisedById !== v.id;

// --- department work ---------------------------------------------------------------------------------------------------------
const approved = (t: Facts) => t.approvalStatus === "APPROVED";
/** Take ownership: a department member, once approved, while nobody owns it yet and the work is not finished. */
export const canAccept = (v: Viewer, t: Facts) => approved(t) && isDeptMember(v, t) && t.assigneeId === null && (t.workStatus === "AWAITING_ACTION" || t.workStatus === "REOPENED");
/** Only the owner moves progress, and not once it is completed (the employee must reopen it). */
export const canUpdateProgress = (v: Viewer, t: Facts) => approved(t) && t.assigneeId === v.id && t.workStatus !== null && t.workStatus !== "COMPLETED" && t.workStatus !== "AWAITING_ACTION";
/** The owner hands it to another member, or an Admin of the company does. Not once completed. */
export const canReassign = (v: Viewer, t: Facts) => approved(t) && t.workStatus !== null && t.workStatus !== "COMPLETED" && (t.assigneeId === v.id || (v.role === "ADMIN" && isStaffInScope(v, t)));

export function progressAllowed(from: Work | null, to: string): to is SettableWork {
  if (!SETTABLE_WORK.includes(to as SettableWork)) return false;
  if (from === null || from === "COMPLETED" || from === "AWAITING_ACTION") return false;
  return from !== to;
}
/** Putting work on hold, or finishing it, needs a few words so the employee understands. */
export const progressNeedsNote = (to: SettableWork) => to === "ON_HOLD" || to === "COMPLETED";

// --- the employee's answer ---------------------------------------------------------------------------------------------------
export const canConfirm = (v: Viewer, t: Facts) => t.raisedById === v.id && approved(t) && t.workStatus === "COMPLETED" && !t.confirmedAt;
export const canReopen = canConfirm;

// --- commenting ------------------------------------------------------------------------------------------------------------
/** Who may write which kind of note. Returns the visibilities the viewer may use (empty = may not comment). */
export function commentVisibilities(v: Viewer, t: Facts): NoteVisibility[] {
  if (t.approvalStatus === "REJECTED") return [];
  const out: NoteVisibility[] = [];
  if (t.raisedById === v.id) return ["ALL"];
  if (isOversight(v, t)) out.push("ALL", "APPROVERS");
  if (approved(t) && isDeptMember(v, t)) { if (!out.includes("ALL")) out.push("ALL"); out.push("DEPT"); }
  return out;
}

// --- the screen's work queue views -----------------------------------------------------------------------------------------
export type View = "ALL" | "MINE" | "TAGGED" | "APPROVE" | "DEPT_AWAITING" | "DEPT_ASSIGNED" | "DEPT_PROGRESS" | "DEPT_HOLD" | "DEPT_DONE";
export const VIEWS: View[] = ["ALL", "MINE", "TAGGED", "APPROVE", "DEPT_AWAITING", "DEPT_ASSIGNED", "DEPT_PROGRESS", "DEPT_HOLD", "DEPT_DONE"];
export function inView(view: View, v: Viewer, t: Facts): boolean {
  const deptSide = approved(t) && (v.deptIds.includes(t.departmentId) || t.assigneeId === v.id);
  switch (view) {
    case "ALL": return true;
    case "MINE": return t.raisedById === v.id;
    // Tagged = the employee picked THIS Admin. Being on the approver list through routing (the Admin above the manager, or every Admin of a
    // company with no mapped Admin) is NOT a tag, and neither is a department.
    case "TAGGED": return v.role === "ADMIN" && !!t.taggedAdminId && t.taggedAdminId === v.id;
    case "APPROVE": return canManagerDecide(v, t) || canAdminDecide(v, t);
    case "DEPT_AWAITING": return deptSide && (t.workStatus === "AWAITING_ACTION" || t.workStatus === "REOPENED") && t.assigneeId === null;
    case "DEPT_ASSIGNED": return approved(t) && t.assigneeId === v.id && t.workStatus !== "COMPLETED";
    case "DEPT_PROGRESS": return deptSide && (t.workStatus === "IN_PROGRESS" || t.workStatus === "NOT_STARTED" || (t.workStatus === "REOPENED" && t.assigneeId !== null));
    case "DEPT_HOLD": return deptSide && t.workStatus === "ON_HOLD";
    case "DEPT_DONE": return deptSide && t.workStatus === "COMPLETED";
  }
}

/** Whose move it is, in words (for the "current stage" line). */
export function stageOf(t: Pick<Facts, "approvalStatus" | "workStatus" | "confirmedAt">): string {
  if (t.approvalStatus === "PENDING_MANAGER") return "Waiting for the reporting manager";
  if (t.approvalStatus === "PENDING_ADMIN") return "Waiting for the Admin";
  if (t.approvalStatus === "REJECTED") return "Rejected";
  if (t.workStatus === "COMPLETED") return t.confirmedAt ? "Resolved and confirmed" : "Waiting for the employee to confirm";
  if (t.workStatus === "AWAITING_ACTION") return "Waiting for the department to take it";
  if (t.workStatus === "REOPENED") return "Reopened, with the department";
  return "With the department";
}

// --- the Admin overview's five status groups (every request is in exactly one, so they add up to the total) -----------------
export type StatusBucket = "PENDING" | "APPROVED" | "REJECTED" | "ON_HOLD" | "RESOLVED";
export const STATUS_BUCKETS: StatusBucket[] = ["PENDING", "APPROVED", "REJECTED", "ON_HOLD", "RESOLVED"];
export function statusBucket(t: Pick<Facts, "approvalStatus" | "workStatus">): StatusBucket {
  if (t.approvalStatus === "PENDING_MANAGER" || t.approvalStatus === "PENDING_ADMIN") return "PENDING";
  if (t.approvalStatus === "REJECTED") return "REJECTED";
  if (t.workStatus === "ON_HOLD") return "ON_HOLD";
  if (t.workStatus === "COMPLETED") return "RESOLVED";
  return "APPROVED"; // approved and still open (awaiting, not started, in progress, reopened)
}
/** An Admin can be tagged only if they are on the list of Admins offered for the employee's company. */
export function mayTagAdmin(choiceIds: readonly string[], taggedId: string): boolean {
  return choiceIds.includes(taggedId);
}
