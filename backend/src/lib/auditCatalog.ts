// ---------------------------------------------------------------------------
// AUDIT CATALOGUE
//
// Turns "POST /api/leave/requests/<uuid>/decide" into something a person can read:
// module "Leave", action APPROVE, summary "Decided a leave request", record = that id.
// Every new write route should get a line here; anything not listed still gets logged
// as module "Other" so nothing is ever silently missed.
// ---------------------------------------------------------------------------

export const ACTIONS = ["CREATE", "UPDATE", "DELETE", "APPROVE", "REJECT", "SUBMIT", "CANCEL", "LOGIN", "UPLOAD", "PASSWORD", "PERMISSION", "CLOCK", "OTHER"] as const;
export type AuditAction = (typeof ACTIONS)[number];

export const MODULES = [
  "Authentication", "Attendance", "Tasks", "Employees", "Teams & rules", "Leave", "Tickets", "Documents",
  "Payroll", "Holidays", "Offers", "Projects", "Policies", "Companies", "Meetings", "Other",
] as const;

export type Classified = {
  module: string;
  action: AuditAction;
  summary: string;
  recordType: string | null;
  recordId: string | null;
  targetUserId: string | null;
  skip: boolean;
};

type Body = Record<string, unknown> | null | undefined;

type Rule = {
  method: string;
  re: RegExp; // matched against the path with UUIDs replaced by ":id"
  module: string;
  action: AuditAction | ((b: Body) => AuditAction);
  summary: string | ((b: Body) => string);
  recordType?: string;
  // which UUID in the path (0 = first) is the record, and whether it is also the affected employee
  idIndex?: number;
  targetIsId?: boolean;
  skip?: boolean;
};

const verdict = (b: Body, key: string, yes: unknown[], a: AuditAction, no: AuditAction): AuditAction => (yes.includes(b?.[key]) ? a : no);

const RULES: Rule[] = [
  // Talk to Management is confidential: never logged, so HR (who can read the audit log) can never see it. First rule on purpose.
  { method: "POST", re: /^\/api\/management-talk(\/.*)?$/, module: "Other", action: "OTHER", summary: "Confidential", skip: true },
  { method: "PUT", re: /^\/api\/management-talk(\/.*)?$/, module: "Other", action: "OTHER", summary: "Confidential", skip: true },
  { method: "PATCH", re: /^\/api\/management-talk(\/.*)?$/, module: "Other", action: "OTHER", summary: "Confidential", skip: true },
  { method: "DELETE", re: /^\/api\/management-talk(\/.*)?$/, module: "Other", action: "OTHER", summary: "Confidential", skip: true },
  { method: "POST", re: /^\/api\/auth\/login$/, module: "Authentication", action: "LOGIN", summary: "Signed in" },

  { method: "POST", re: /^\/api\/tracker\/clock-in$/, module: "Attendance", action: "CLOCK", summary: "Clocked in" },
  { method: "POST", re: /^\/api\/tracker\/clock-out$/, module: "Attendance", action: "CLOCK", summary: "Clocked out" },
  { method: "POST", re: /^\/api\/tracker\/break\/start$/, module: "Attendance", action: "CLOCK", summary: "Started a break" },
  { method: "POST", re: /^\/api\/tracker\/break\/end$/, module: "Attendance", action: "CLOCK", summary: "Ended a break" },
  { method: "POST", re: /^\/api\/tracker\/meetings\/invite$/, module: "Meetings", action: "CREATE", summary: "Invited people to a tracked meeting" },
  { method: "POST", re: /^\/api\/tracker\/invites\/:id\/respond$/, module: "Meetings", action: (b) => verdict(b, "accept", [true], "APPROVE", "REJECT"), summary: (b) => (b?.accept === true ? "Accepted a meeting invite" : "Declined a meeting invite"), recordType: "MeetingInvite" },
  { method: "POST", re: /^\/api\/tracker\/meeting\/end$/, module: "Meetings", action: "UPDATE", summary: "Ended a tracked meeting" },
  { method: "POST", re: /^\/api\/tracker\/alerts\/:id\/ack$/, module: "Attendance", action: "UPDATE", summary: "Acknowledged an alert", recordType: "Alert" },

  { method: "POST", re: /^\/api\/tasks$/, module: "Tasks", action: "CREATE", summary: "Proposed a task" },
  { method: "PATCH", re: /^\/api\/tasks\/:id$/, module: "Tasks", action: "UPDATE", summary: "Updated a task", recordType: "Task" },
  { method: "DELETE", re: /^\/api\/tasks\/:id$/, module: "Tasks", action: "DELETE", summary: "Deleted a task", recordType: "Task" },
  { method: "POST", re: /^\/api\/tasks\/review\/assign$/, module: "Tasks", action: "CREATE", summary: "Assigned a task" },
  { method: "POST", re: /^\/api\/tasks\/review\/:id\/approve$/, module: "Tasks", action: (b) => verdict(b, "approve", [false], "REJECT", "APPROVE"), summary: (b) => (b?.approve === false ? "Sent a task proposal back" : "Approved a task proposal"), recordType: "Task" },
  { method: "POST", re: /^\/api\/tasks\/review\/:id\/(outcome|rating)$/, module: "Tasks", action: "UPDATE", summary: "Rated a task", recordType: "Task" },
  { method: "POST", re: /^\/api\/tasks\/review\/:id\/revert$/, module: "Tasks", action: "UPDATE", summary: "Reopened a completed task", recordType: "Task" },

  { method: "POST", re: /^\/api\/admin\/employees\/(parse|preview|update\/preview)$/, module: "Employees", action: "OTHER", summary: "Previewed an employee file", skip: true },
  { method: "POST", re: /^\/api\/admin\/employees\/update\/commit$/, module: "Employees", action: "UPDATE", summary: "Bulk employee update" },
  { method: "POST", re: /^\/api\/admin\/employees\/commit$/, module: "Employees", action: "CREATE", summary: "Imported employees" },
  { method: "POST", re: /^\/api\/admin\/users$/, module: "Employees", action: "CREATE", summary: "Created an employee account" },
  { method: "PATCH", re: /^\/api\/admin\/users\/:id$/, module: "Employees", action: "UPDATE", summary: "Updated an employee", recordType: "User", targetIsId: true },
  { method: "PUT", re: /^\/api\/photos\/:userId$/, module: "Employees", action: "UPDATE", summary: "Set a profile photo", recordType: "User", targetIsId: true },
  { method: "POST", re: /^\/api\/photos\/:userId$/, module: "Employees", action: "UPDATE", summary: "Set a profile photo", recordType: "User", targetIsId: true },
  { method: "DELETE", re: /^\/api\/photos\/:userId$/, module: "Employees", action: "UPDATE", summary: "Removed a profile photo", recordType: "User", targetIsId: true },
  { method: "POST", re: /^\/api\/queries$/, module: "Queries", action: "CREATE", summary: "Raised a query", recordType: "Ticket" },
  { method: "POST", re: /^\/api\/queries\/:id\/messages$/, module: "Queries", action: "UPDATE", summary: "Replied to a query", recordType: "Ticket" },
  { method: "POST", re: /^\/api\/queries\/:id\/request-info$/, module: "Queries", action: "UPDATE", summary: "Asked for more information on a query", recordType: "Ticket" },
  { method: "POST", re: /^\/api\/queries\/:id\/status$/, module: "Queries", action: "UPDATE", summary: "Changed the status of a query", recordType: "Ticket" },
  { method: "POST", re: /^\/api\/queries\/:id\/assign$/, module: "Queries", action: "UPDATE", summary: "Assigned a query", recordType: "Ticket" },
  { method: "POST", re: /^\/api\/admin\/designations$/, module: "Employees", action: "CREATE", summary: "Added a designation", recordType: "Designation" },
  { method: "PATCH", re: /^\/api\/admin\/designations\/:id$/, module: "Employees", action: "UPDATE", summary: "Changed a designation", recordType: "Designation" },
  { method: "POST", re: /^\/api\/admin\/company-access\/:userId$/, module: "Employees", action: "PERMISSION", summary: "Changed which companies a person can act on", recordType: "User", targetIsId: true },
  { method: "PUT", re: /^\/api\/admin\/company-access\/:userId$/, module: "Employees", action: "PERMISSION", summary: "Changed which companies a person can act on", recordType: "User", targetIsId: true },
  { method: "POST", re: /^\/api\/admin\/users\/:id\/password$/, module: "Employees", action: "PASSWORD", summary: "Reset an employee's password", recordType: "User", targetIsId: true },
  { method: "POST", re: /^\/api\/admin\/teams$/, module: "Teams & rules", action: "CREATE", summary: "Created a team" },
  { method: "PATCH", re: /^\/api\/admin\/teams\/:id$/, module: "Teams & rules", action: "UPDATE", summary: "Updated a team", recordType: "Team" },
  { method: "POST", re: /^\/api\/admin\/teams\/:id\/members$/, module: "Teams & rules", action: "UPDATE", summary: "Added a team member", recordType: "Team" },
  { method: "DELETE", re: /^\/api\/admin\/teams\/:id\/members\/:id$/, module: "Teams & rules", action: "UPDATE", summary: "Removed a team member", recordType: "Team" },
  { method: "POST", re: /^\/api\/admin\/shifts$/, module: "Teams & rules", action: "CREATE", summary: "Created a shift" },
  { method: "PATCH", re: /^\/api\/admin\/shifts\/:id$/, module: "Teams & rules", action: "UPDATE", summary: "Updated a shift", recordType: "Shift" },
  { method: "PATCH", re: /^\/api\/admin\/config\/:id$/, module: "Teams & rules", action: "UPDATE", summary: "Changed a team's attendance rules", recordType: "TeamConfig" },
  { method: "POST", re: /^\/api\/admin\/leave$/, module: "Leave", action: "CREATE", summary: "Marked leave for someone" },
  { method: "DELETE", re: /^\/api\/admin\/leave$/, module: "Leave", action: "DELETE", summary: "Removed marked leave" },

  { method: "POST", re: /^\/api\/tickets$/, module: "Tickets", action: "CREATE", summary: "Raised a ticket" },
  { method: "POST", re: /^\/api\/tickets\/:id\/messages$/, module: "Tickets", action: "CREATE", summary: "Replied to a ticket", recordType: "Ticket" },
  { method: "PATCH", re: /^\/api\/tickets\/:id$/, module: "Tickets", action: "UPDATE", summary: "Updated a ticket", recordType: "Ticket" },
  { method: "POST", re: /^\/api\/tickets\/:id\/apply$/, module: "Attendance", action: "APPROVE", summary: "Applied an attendance correction ticket", recordType: "Ticket" },

  { method: "POST", re: /^\/api\/onboarding\/me\/documents$/, module: "Documents", action: "UPLOAD", summary: "Uploaded a document" },
  { method: "POST", re: /^\/api\/onboarding\/me\/password$/, module: "Authentication", action: "PASSWORD", summary: "Changed their own password" },
  { method: "POST", re: /^\/api\/onboarding\/hires$/, module: "Employees", action: "CREATE", summary: "Added a joiner" },
  { method: "POST", re: /^\/api\/onboarding\/candidates\/:id\/documents$/, module: "Documents", action: "UPLOAD", summary: "Uploaded a document for a joiner", recordType: "User", targetIsId: true },
  { method: "POST", re: /^\/api\/onboarding\/documents\/:id\/review$/, module: "Documents", action: (b) => verdict(b, "approve", [true], "APPROVE", "REJECT"), summary: (b) => (b?.approve === true ? "Verified a document" : "Rejected a document"), recordType: "EmployeeDocument" },
  { method: "POST", re: /^\/api\/onboarding\/requirements$/, module: "Documents", action: "UPDATE", summary: "Changed a document requirement", recordType: "DocumentRequirement" },

  { method: "POST", re: /^\/api\/payroll\/upload$/, module: "Payroll", action: "UPLOAD", summary: "Uploaded a payslip" },
  { method: "POST", re: /^\/api\/payroll\/publish$/, module: "Payroll", action: "UPDATE", summary: "Published or unpublished payslips" },
  { method: "POST", re: /^\/api\/payroll\/generate$/, module: "Payroll", action: "CREATE", summary: "Generated salary slips" },
  { method: "POST", re: /^\/api\/payroll\/approve$/, module: "Payroll", action: "APPROVE", summary: "Approved salary slips" },
  { method: "POST", re: /^\/api\/payroll\/unrelease$/, module: "Payroll", action: "UPDATE", summary: "Took released salary slips back" },
  { method: "POST", re: /^\/api\/payroll\/release$/, module: "Payroll", action: "APPROVE", summary: "Approved and released salary slips" },
  { method: "POST", re: /^\/api\/payroll\/[^/]+\/deduction$/, module: "Payroll", action: "UPDATE", summary: "Changed a salary slip deduction", recordType: "SalarySlip" },
  { method: "POST", re: /^\/api\/payroll\/publish-month$/, module: "Payroll", action: "UPDATE", summary: "Published a month's payslips" },
  { method: "POST", re: /^\/api\/payroll\/:id\/delete$/, module: "Payroll", action: "DELETE", summary: "Deleted a payslip", recordType: "SalarySlip" },
  { method: "DELETE", re: /^\/api\/payroll\/:id$/, module: "Payroll", action: "DELETE", summary: "Deleted a payslip", recordType: "SalarySlip" },

  { method: "POST", re: /^\/api\/holidays$/, module: "Holidays", action: "CREATE", summary: "Added a holiday" },
  { method: "POST", re: /^\/api\/holidays\/:id\/delete$/, module: "Holidays", action: "DELETE", summary: "Removed a holiday", recordType: "Holiday" },
  { method: "DELETE", re: /^\/api\/holidays\/:id$/, module: "Holidays", action: "DELETE", summary: "Removed a holiday", recordType: "Holiday" },

  { method: "POST", re: /^\/api\/offers\/me\/:id\/respond$/, module: "Offers", action: (b) => verdict(b, "accept", [true], "APPROVE", "REJECT"), summary: (b) => (b?.accept === true ? "Accepted an offer" : "Declined an offer"), recordType: "Offer" },
  { method: "POST", re: /^\/api\/offers\/templates$/, module: "Offers", action: "UPDATE", summary: "Saved an offer template" },
  { method: "POST", re: /^\/api\/offers$/, module: "Offers", action: "CREATE", summary: "Created an offer" },
  { method: "POST", re: /^\/api\/offers\/:id\/send$/, module: "Offers", action: "SUBMIT", summary: "Sent an offer", recordType: "Offer" },

  { method: "POST", re: /^\/api\/projects$/, module: "Projects", action: "UPDATE", summary: "Saved a project" },
  { method: "POST", re: /^\/api\/projects\/:id\/co-managers$/, module: "Projects", action: "UPDATE", summary: "Added a co-manager to a project", recordType: "Team" },
  { method: "POST", re: /^\/api\/projects\/:id\/co-managers\/:id\/remove$/, module: "Projects", action: "UPDATE", summary: "Removed a co-manager from a project", recordType: "Team" },
  { method: "POST", re: /^\/api\/projects\/:id\/members$/, module: "Projects", action: "UPDATE", summary: "Added a project member", recordType: "Team" },
  { method: "POST", re: /^\/api\/projects\/:id\/members\/:id\/primary$/, module: "Projects", action: "UPDATE", summary: "Made a project primary", recordType: "Team" },
  { method: "POST", re: /^\/api\/projects\/:id\/members\/:id\/remove$/, module: "Projects", action: "UPDATE", summary: "Removed a project member", recordType: "Team" },

  { method: "POST", re: /^\/api\/leave\/requests$/, module: "Leave", action: "SUBMIT", summary: "Requested leave" },
  { method: "POST", re: /^\/api\/leave\/requests\/:id\/cancel$/, module: "Leave", action: "CANCEL", summary: "Cancelled a leave request", recordType: "LeaveRequest" },
  { method: "POST", re: /^\/api\/leave\/requests\/:id\/revoke$/, module: "Leave", action: "CANCEL", summary: "Cancelled an approved leave", recordType: "LeaveRequest" },
  { method: "POST", re: /^\/api\/leave\/requests\/:id\/decide$/, module: "Leave", action: (b) => verdict(b, "decision", ["REJECT"], "REJECT", "APPROVE"), summary: (b) => (b?.decision === "REJECT" ? "Rejected a leave request" : "Approved a leave request"), recordType: "LeaveRequest" },

  { method: "POST", re: /^\/api\/policies\/:id\/acknowledge$/, module: "Policies", action: "APPROVE", summary: "Confirmed they read a policy", recordType: "InductionDocument" },
  { method: "POST", re: /^\/api\/policies$/, module: "Policies", action: "CREATE", summary: "Added a policy document" },
  { method: "POST", re: /^\/api\/policies\/:id\/file$/, module: "Policies", action: "UPDATE", summary: "Replaced the file of an unpublished policy version", recordType: "InductionDocument" },
  { method: "PATCH", re: /^\/api\/policies\/:id$/, module: "Policies", action: "UPDATE", summary: "Edited a draft policy", recordType: "InductionDocument" },
  { method: "POST", re: /^\/api\/policies\/:id\/versions$/, module: "Policies", action: "CREATE", summary: "Prepared a new policy version", recordType: "InductionDocument" },
  { method: "POST", re: /^\/api\/policies\/:id\/publish$/, module: "Policies", action: "APPROVE", summary: "Published a policy", recordType: "InductionDocument" },
  { method: "POST", re: /^\/api\/policies\/categories$/, module: "Policies", action: "CREATE", summary: "Added a policy category" },
  { method: "POST", re: /^\/api\/policies\/:id\/notes\/:id$/, module: "Policies", action: "UPDATE", summary: "Updated a policy review note", recordType: "PolicyReviewNote" },
  { method: "POST", re: /^\/api\/policies\/:id\/archive$/, module: "Policies", action: "UPDATE", summary: "Archived a policy document", recordType: "InductionDocument" },
  { method: "POST", re: /^\/api\/policies\/:id\/restore$/, module: "Policies", action: "UPDATE", summary: "Restored a policy document", recordType: "InductionDocument" },

  { method: "POST", re: /^\/api\/attendance-corrections$/, module: "Attendance", action: "SUBMIT", summary: "Requested an attendance correction" },
  { method: "POST", re: /^\/api\/attendance-corrections\/:id\/cancel$/, module: "Attendance", action: "CANCEL", summary: "Cancelled an attendance correction request", recordType: "AttendanceCorrection" },
  { method: "POST", re: /^\/api\/leave\/manager\/requests\/:id\/decide$/, module: "Leave", action: (b) => verdict(b, "decision", ["REJECT"], "REJECT", "APPROVE"), summary: (b) => (b?.decision === "REJECT" ? "Manager rejected a leave request" : "Manager approved a leave request"), recordType: "LeaveRequest" },
  { method: "POST", re: /^\/api\/attendance-corrections\/manager\/requests\/:id\/decide$/, module: "Attendance", action: (b) => verdict(b, "decision", ["REJECT"], "REJECT", "APPROVE"), summary: (b) => (b?.decision === "REJECT" ? "Manager rejected an attendance correction" : "Manager approved an attendance correction"), recordType: "AttendanceCorrection" },
  { method: "POST", re: /^\/api\/attendance-corrections\/:id\/decide$/, module: "Attendance", action: (b) => verdict(b, "decision", ["REJECT"], "REJECT", "APPROVE"), summary: (b) => (b?.decision === "REJECT" ? "Rejected an attendance correction" : "Approved an attendance correction"), recordType: "AttendanceCorrection" },

  { method: "PATCH", re: /^\/api\/preferences$/, module: "Other", action: "UPDATE", summary: "Chose a display theme", recordType: "Preference", skip: true },
  { method: "POST", re: /^\/api\/notifications\/(read-all|:id\/read)$/, module: "Other", action: "OTHER", summary: "Marked notifications read", skip: true },

  { method: "POST", re: /^\/api\/documents\/employees\/:id\/employment-type$/, module: "Employees", action: "UPDATE", summary: "Set an employee's employment type", recordType: "User", targetIsId: true },
  { method: "POST", re: /^\/api\/meetings$/, module: "Meetings", action: "CREATE", summary: "Scheduled a meeting" },
  { method: "PATCH", re: /^\/api\/meetings\/:id$/, module: "Meetings", action: "UPDATE", summary: "Changed a meeting", recordType: "Meeting" },
  { method: "POST", re: /^\/api\/meetings\/:id\/respond$/, module: "Meetings", action: "UPDATE", summary: "Answered a meeting invitation", recordType: "Meeting" },
  { method: "POST", re: /^\/api\/meetings\/:id\/join$/, module: "Meetings", action: "UPDATE", summary: "Declared joining an in-person meeting", recordType: "Meeting" },
  { method: "POST", re: /^\/api\/meetings\/:id\/leave$/, module: "Meetings", action: "UPDATE", summary: "Declared leaving an in-person meeting", recordType: "Meeting" },
  { method: "PATCH", re: /^\/api\/meetings\/:id\/participation\/:userId$/, module: "Meetings", action: "UPDATE", summary: "Corrected meeting participation", recordType: "Meeting" },
  { method: "POST", re: /^\/api\/meetings\/:id\/end$/, module: "Meetings", action: "UPDATE", summary: "Ended a meeting early", recordType: "Meeting" },
  { method: "POST", re: /^\/api\/meetings\/:id\/cancel$/, module: "Meetings", action: "CANCEL", summary: "Cancelled a meeting", recordType: "Meeting" },
  { method: "POST", re: /^\/api\/team-attendance\/targets$/, module: "Teams & rules", action: "UPDATE", summary: "Changed a daily task target", recordType: "DailyTaskTarget" },
  { method: "POST", re: /^\/api\/companies$/, module: "Companies", action: "CREATE", summary: "Added a company" },
  { method: "POST", re: /^\/api\/companies\/:id$/, module: "Companies", action: "UPDATE", summary: "Edited a company", recordType: "Platform" },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function classify(method: string, rawPath: string, body?: Body): Classified {
  const path = rawPath.split("?")[0].replace(/\/+$/, "") || "/";
  const ids = path.match(UUID) ?? [];
  const norm = path.replace(UUID, ":id");
  const m = method.toUpperCase();
  const rule = RULES.find((r) => r.method === m && r.re.test(norm));

  if (!rule) {
    const verb: AuditAction = m === "DELETE" ? "DELETE" : m === "POST" ? "CREATE" : "UPDATE";
    return { module: "Other", action: verb, summary: `${m} ${norm.replace(/^\/api\//, "")}`, recordType: null, recordId: ids[0] ?? null, targetUserId: null, skip: false };
  }
  const recordId = ids[rule.idIndex ?? 0] ?? null;
  return {
    module: rule.module,
    action: typeof rule.action === "function" ? rule.action(body) : rule.action,
    summary: typeof rule.summary === "function" ? rule.summary(body) : rule.summary,
    recordType: rule.recordType ?? null,
    recordId,
    targetUserId: rule.targetIsId ? recordId : null,
    skip: rule.skip === true,
  };
}
