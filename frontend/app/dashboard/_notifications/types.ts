// Shared by the bell, the popups and the notification centre.

export type Item = { id: string; type: string; title: string; body: string; link: string | null; readAt: string | null; createdAt: string };
export type Inbox = { unread: number; items: Item[] };

// The short label shown on each notification, by type.
export const TYPE_LABEL: Record<string, string> = {
  TASK_ASSIGNED: "Task assigned",
  TASK_PROPOSED: "Needs approval",
  TASK_SUBMITTED: "Submitted for review",
  TASK_PROPOSAL_APPROVED: "Task approved",
  TASK_PROPOSAL_RETURNED: "Task sent back",
  TASK_APPROVED: "Work approved",
  TASK_REJECTED: "Work not accepted",
  TASK_REVERTED: "Task reopened",
  MEETING_RESPONDED: "Invitation answer",
  LEAVE_REQUESTED: "Leave request",
  LEAVE_DECIDED: "Leave answer",
  CORRECTION_SUBMITTED: "Attendance correction",
  CORRECTION_DECIDED: "Attendance correction",
  MEETING_INVITE: "Meeting",
  MEETING_INVITED: "Meeting invitation",
  MEETING_REMOVED: "Meeting",
  MEETING_UPDATED: "Meeting",
  MEETING_CANCELLED: "Meeting",
  MEETING_PARTICIPATION_CORRECTED: "Meeting",
  MEETING_RECORDING: "Meeting recording",
  MEETING_MINUTES: "Meeting minutes",
  POLICY_PUBLISHED: "Policy",
  POLICY_UPDATED: "Policy",
  PAYSLIP_PUBLISHED: "Salary slip",
};

export const labelOf = (type: string) => TYPE_LABEL[type] ?? "Notification";

// Events important enough to pop up on screen when they arrive. Everything still lands in the bell either way.
export const POPUP_TYPES = new Set(["TASK_ASSIGNED", "TASK_PROPOSED", "TASK_SUBMITTED", "TASK_PROPOSAL_APPROVED", "TASK_PROPOSAL_RETURNED", "TASK_APPROVED", "TASK_REJECTED", "TASK_REVERTED", "POLICY_PUBLISHED", "POLICY_UPDATED", "PAYSLIP_PUBLISHED", "MEETING_INVITED", "MEETING_UPDATED", "MEETING_PARTICIPATION_CORRECTED", "MEETING_RECORDING", "MEETING_MINUTES", "LEAVE_REQUESTED", "LEAVE_DECIDED"]);

export const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

export const stamp = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso));
