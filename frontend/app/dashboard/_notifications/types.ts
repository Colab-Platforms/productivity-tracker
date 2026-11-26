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
  TASK_DELETED: "Task removed",
  REPETITIVE_TASK_ALERT: "Similar tasks noticed",
  REPETITIVE_TASK_STATUS: "Task alert updated",
  REPETITIVE_TASK_EXPLAINED: "Employee explanation",
  REPETITIVE_TASK_FLAG: "Repetitive task alert",
  REPETITIVE_TASK_ESCALATED: "Repetitive task escalated",
  ASSIGNED_TASK_UPDATED: "Assigned task changed",
  ASSIGNED_TASK_PROGRESS: "Assigned task progress",
  ASSIGNED_TASK_DONE: "Assigned task done",
  ASSIGNED_TASK_COMMENT: "Assigned task comment",
  ASSIGNED_TASK_CONFIRMED: "Task confirmed",
  ASSIGNED_TASK_SENT_BACK: "Task sent back",
  TASK_MOVED: "Task moved",
  DEPT_QUERY_MANAGER_REVIEW: "Query needs your approval",
  DEPT_QUERY_ADMIN_REVIEW: "Query needs final approval",
  DEPT_QUERY_TAGGED: "Query tagged to you",
  DEPT_QUERY_APPROVED: "Query approved",
  DEPT_QUERY_REJECTED: "Query not approved",
  DEPT_QUERY_FOR_DEPARTMENT: "New request for your department",
  DEPT_QUERY_ACCEPTED: "Query picked up",
  DEPT_QUERY_PROGRESS: "Query progress",
  DEPT_QUERY_COMPLETED: "Query completed",
  DEPT_QUERY_COMMENT: "Query comment",
  DEPT_QUERY_ASSIGNED: "Query assigned to you",
  DEPT_QUERY_CONFIRMED: "Query confirmed",
  DEPT_QUERY_REOPENED: "Query reopened",
  TASK_CORRECTION_REQUESTED: "Correction requested",
  TASK_CORRECTION_DECIDED: "Correction answer",
  MEETING_RESPONDED: "Invitation answer",
  HOLIDAY_CALENDAR: "Holiday calendar",
  DOCUMENT_SUBMITTED: "Document submitted",
  DOCUMENT_VERIFIED: "Document verified",
  DOCUMENT_REJECTED: "Document rejected",
  OPTIONAL_HOLIDAY_REQUEST: "Optional holiday request",
  OPTIONAL_HOLIDAY_DECIDED: "Optional holiday answer",
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
  ATTENDANCE_CLOCK_IN: "Clock-in",
  ATTENDANCE_CLOCK_OUT: "Clock-out",
  ATTENDANCE_LATE: "Late arrival",
  ATTENDANCE_NOT_CLOCKED_IN: "Not clocked in",
  ATTENDANCE_MISSING_CLOCK_OUT: "Clock-out reminder",
  BREAK_STARTED: "Break",
  BREAK_ENDED: "Break",
  BREAK_EXCEEDED: "Break Time exceeded",
  BREAK_LIMIT_EXCEEDED: "Break limit exceeded",
  BREAK_LIMIT_EXCEEDED_TEAM: "Long break",
  TASK_OVERDUE: "Task overdue",
  TASK_OVERDUE_TEAM: "Team tasks overdue",
  TASK_DUE_SOON: "Task due soon",
  MEETING_STARTING_SOON: "Starting soon",
  MEETING_ENDED: "Ended",
  WARNING_LETTER_ISSUED: "Warning letter",
  WARNING_LETTER_ACKNOWLEDGED: "Warning letter",
};

export const labelOf = (type: string) => TYPE_LABEL[type] ?? "Notification";

// Events important enough to pop up on screen when they arrive. Everything still lands in the bell either way.
export const POPUP_TYPES = new Set(["DOCUMENT_REJECTED", "DOCUMENT_VERIFIED", "TASK_ASSIGNED", "TASK_PROPOSED", "TASK_SUBMITTED", "TASK_PROPOSAL_APPROVED", "TASK_PROPOSAL_RETURNED", "TASK_APPROVED", "TASK_REJECTED", "TASK_REVERTED", "TASK_DELETED", "REPETITIVE_TASK_ALERT", "REPETITIVE_TASK_STATUS", "ASSIGNED_TASK_DONE", "ASSIGNED_TASK_CONFIRMED", "ASSIGNED_TASK_SENT_BACK", "TASK_CORRECTION_REQUESTED", "TASK_CORRECTION_DECIDED", "POLICY_PUBLISHED", "POLICY_UPDATED", "PAYSLIP_PUBLISHED", "MEETING_INVITED", "MEETING_UPDATED", "MEETING_PARTICIPATION_CORRECTED", "MEETING_RECORDING", "MEETING_MINUTES", "LEAVE_REQUESTED", "LEAVE_DECIDED", "DEPT_QUERY_MANAGER_REVIEW", "DEPT_QUERY_ADMIN_REVIEW", "DEPT_QUERY_TAGGED", "DEPT_QUERY_FOR_DEPARTMENT", "DEPT_QUERY_REJECTED", "DEPT_QUERY_COMPLETED", "DEPT_QUERY_REOPENED", "DEPT_QUERY_APPROVED", "DEPT_QUERY_ASSIGNED", "DEPT_QUERY_COMMENT", "CORRECTION_SUBMITTED", "CORRECTION_DECIDED", "OPTIONAL_HOLIDAY_REQUEST", "OPTIONAL_HOLIDAY_DECIDED", "WARNING_LETTER_ISSUED", "MEETING_CANCELLED", "MEETING_ENDED", "MEETING_STARTING_SOON", "MEETING_RESPONDED", "ATTENDANCE_CLOCK_IN", "ATTENDANCE_CLOCK_OUT", "ATTENDANCE_LATE", "ATTENDANCE_NOT_CLOCKED_IN", "ATTENDANCE_MISSING_CLOCK_OUT", "BREAK_STARTED", "BREAK_ENDED", "BREAK_EXCEEDED", "BREAK_LIMIT_EXCEEDED", "BREAK_LIMIT_EXCEEDED_TEAM", "TASK_OVERDUE", "TASK_OVERDUE_TEAM", "TASK_DUE_SOON", "ASSIGNED_TASK_UPDATED", "ASSIGNED_TASK_COMMENT", "TASK_MOVED"]);

export const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

export const stamp = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso));
