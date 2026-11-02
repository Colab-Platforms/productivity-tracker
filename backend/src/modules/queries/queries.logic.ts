// Complaint Centre / Query Desk: the pure rules (no database), so they can be tested on their own.

export const QUERY_CATEGORIES = ["LEAVE", "PAYROLL", "PROFILE_DOCUMENT", "TECHNICAL", "GENERAL_HR", "OTHER"] as const;
export type QueryCategory = (typeof QUERY_CATEGORIES)[number];

/** Everything a person can pick, including the attendance correction (which is NOT a ticket: it keeps its own approval workflow). */
export const PICKER_CATEGORIES = ["ATTENDANCE_CORRECTION", ...QUERY_CATEGORIES] as const;
export type PickerCategory = (typeof PICKER_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<PickerCategory, string> = {
  ATTENDANCE_CORRECTION: "Attendance correction",
  LEAVE: "Leave query",
  PAYROLL: "Payroll and salary",
  PROFILE_DOCUMENT: "Profile and documents",
  TECHNICAL: "Technical issue",
  GENERAL_HR: "General HR query",
  OTHER: "Other",
};

/** The old ticket category each new category is stored under, so the existing ticket machinery (routing, response targets) keeps working. */
export const TICKET_CATEGORY_FOR: Record<QueryCategory, "HR_QUERY" | "TECH_ISSUE" | "ADMIN_REQUEST"> = {
  LEAVE: "HR_QUERY",
  PAYROLL: "HR_QUERY",
  PROFILE_DOCUMENT: "HR_QUERY",
  GENERAL_HR: "HR_QUERY",
  TECHNICAL: "TECH_ISSUE",
  OTHER: "ADMIN_REQUEST",
};

/** The category of a ticket that has no query_meta row (an older ticket), read from its old category. */
export function legacyCategory(ticketCategory: string): PickerCategory {
  if (ticketCategory === "HR_QUERY") return "GENERAL_HR";
  if (ticketCategory === "TECH_ISSUE") return "TECHNICAL";
  if (ticketCategory === "ATTENDANCE_CORRECTION") return "ATTENDANCE_CORRECTION";
  return "OTHER";
}

export const isQueryCategory = (v: unknown): v is QueryCategory => QUERY_CATEGORIES.includes(v as QueryCategory);

// --- who sees and does what -------------------------------------------------------------------------------------------------

export type Viewer = { id: string; role: string; access: { all: boolean; ids: string[] } };
export type TicketFacts = { raisedById: string; platformId: string; assignedToId: string | null; categoryKey: PickerCategory };

const inScope = (v: Viewer, platformId: string) => v.access.all || v.access.ids.includes(platformId);

/**
 * May this person open this query?
 *  - the person who raised it, always;
 *  - HR / Admin for the companies they may act on (all of that company's queries);
 *  - a MANAGER only for queries raised by the people who report to them (their team), never a payroll or salary one, plus anything
 *    an HR/Admin explicitly assigned to them;
 *  - nobody else (an employee never sees another person's query).
 */
export function canViewQuery(v: Viewer, t: TicketFacts, teamIds: ReadonlySet<string>): boolean {
  if (t.raisedById === v.id) return true;
  if (v.role === "HR" || v.role === "ADMIN") return inScope(v, t.platformId);
  if (v.role === "MANAGER") {
    if (t.assignedToId === v.id) return true;
    return t.categoryKey !== "PAYROLL" && teamIds.has(t.raisedById);
  }
  return false;
}

/** Staff may reply, add internal notes and request information on a query they can see and did not raise. */
export const canHandleQuery = (v: Viewer, t: TicketFacts, teamIds: ReadonlySet<string>) => v.role !== "EMPLOYEE" && t.raisedById !== v.id && canViewQuery(v, t, teamIds);

/** Changing status or assigning: HR/Admin of the company, or the person it is assigned to. Never the person who raised it. */
export function canManageQuery(v: Viewer, t: TicketFacts): boolean {
  if (t.raisedById === v.id) return false;
  if (t.assignedToId === v.id && v.role !== "EMPLOYEE") return true;
  return (v.role === "HR" || v.role === "ADMIN") && inScope(v, t.platformId);
}

/** Assigning needs HR/Admin of that company, and the new owner must be active staff of the SAME company (a payroll query only to HR/Admin). */
export function canAssignTo(assignee: { role: string; platformId: string; status: string }, t: { platformId: string; categoryKey: PickerCategory }): boolean {
  if (assignee.status !== "ACTIVE" || assignee.platformId !== t.platformId) return false;
  if (assignee.role === "HR" || assignee.role === "ADMIN") return true;
  return assignee.role === "MANAGER" && t.categoryKey !== "PAYROLL";
}

// --- how a status is shown ---------------------------------------------------------------------------------------------------

export type DisplayStatus = "OPEN" | "IN_PROGRESS" | "WAITING_FOR_EMPLOYEE" | "RESOLVED" | "CLOSED" | "REJECTED";

/** Open and in-progress become "waiting for the employee" while information that was requested has not been answered. */
export function displayStatus(status: string, awaitingInfo: boolean): DisplayStatus {
  if (awaitingInfo && (status === "OPEN" || status === "IN_PROGRESS")) return "WAITING_FOR_EMPLOYEE";
  return status as DisplayStatus;
}

export const statusIsFinished = (status: string) => status === "RESOLVED" || status === "CLOSED" || status === "REJECTED";
