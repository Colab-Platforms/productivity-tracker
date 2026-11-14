// The page title shown in the header, the breadcrumb and the browser tab. One rule for all of them, so they can never disagree.
//
//   1. a person's own home      -> the dashboard's name ("Admin Dashboard", "HR Dashboard", "Today")
//   2. My Profile
//   3. a sidebar entry for this page and role. When two entries lead to the same page (Admin's "Reports & Analytics" and its "Productivity" shortcut),
//      the plain one wins: a shortcut with ?tab= is a way IN to the page, not its name.
//   4. pages that are not in the menu (reached from a link, a button or a notification) -> EXTRA_TITLES, so they never say a generic "Dashboard"
//   5. anything else -> "Dashboard"

export type TitleItem = { href: string; label: string; roles?: string[]; notRoles?: string[] };

// Pages without a menu entry for some or all roles. Matched on the address up to a "?" and on the page's sub-addresses.
export const EXTRA_TITLES: [string, string][] = [
  ["/dashboard/approval-centre", "Approval Centre"],
  ["/dashboard/organization-hierarchy", "Organization Hierarchy"],
  ["/dashboard/corrections", "Attendance Corrections"],
  ["/dashboard/holidays", "Holidays"],
  ["/dashboard/office-network", "Office Network"],
  ["/dashboard/queries", "Query Desk"],
  ["/dashboard/tickets", "Query Desk"],
  ["/dashboard/my-performance", "My performance"],
  ["/dashboard/policies", "Policies"],
  ["/dashboard/payroll/approve", "Payroll Approval"],
  ["/dashboard/payroll", "Payroll"],
  ["/dashboard/offers", "Offer Letters"],
  ["/dashboard/candidates", "Recruitment / Joiners"],
  ["/dashboard/documents", "Employee Documents"],
  ["/dashboard/meetings", "Team Huddle"],
  ["/dashboard/huddles", "Team Huddle"],
  ["/dashboard/talk-to-management", "Talk to Management"],
  ["/dashboard/notifications", "Notifications"],
  ["/dashboard/audit-logs", "Audit Logs"],
  ["/dashboard/projects", "Projects"],
  ["/dashboard/companies", "Companies"],
  ["/dashboard/employee-overview", "Employee Overview"],
  ["/dashboard/employees", "Employees"],
  ["/dashboard/attendance-calendar", "Calendar"],
  ["/dashboard/team-attendance", "Attendance"],
  ["/dashboard/team", "Attendance"],
  ["/dashboard/approvals", "Tasks & Performance"],
  ["/dashboard/reports", "Reports & Analytics"],
  ["/dashboard/leave", "Leave"],
  ["/dashboard/history", "My History"],
  ["/dashboard/payslips", "My Payslips"],
  ["/dashboard/tasks", "Daily Tasks"],
  ["/dashboard/chat", "Chat"],
  ["/dashboard/today", "Productivity Tracker"],
  ["/dashboard/profile", "My Profile"],
];

const base = (href: string) => href.split("?")[0];
const allowed = (i: TitleItem, role: string) => (!i.roles || i.roles.includes(role)) && !(i.notRoles ?? []).includes(role);

export function pageTitle(items: TitleItem[], pathname: string, role: string, homeTitle: string | null): string {
  if (homeTitle) return homeTitle;
  if (pathname === "/dashboard/profile") return "My Profile";
  const same = items.filter((i) => base(i.href) === pathname && allowed(i, role));
  const hit = same.find((i) => !i.href.includes("?")) ?? same[0];
  if (hit) return hit.label;
  const extra = EXTRA_TITLES.find(([p]) => pathname === p || pathname.startsWith(p + "/"));
  return extra ? extra[1] : "Dashboard";
}
