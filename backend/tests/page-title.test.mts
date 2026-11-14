// The header / breadcrumb / tab title rule. No database.
import { EXTRA_TITLES, pageTitle, type TitleItem } from "../../frontend/app/dashboard/_shell/pageTitle.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x) : "")); };

const items: TitleItem[] = [
  { href: "/dashboard/employees", label: "User Management", roles: ["ADMIN"] },
  { href: "/dashboard/employees?tab=People", label: "Organization Hierarchy", roles: ["ADMIN"] },
  { href: "/dashboard/employee-overview", label: "Employee Overview", roles: ["ADMIN"] },
  { href: "/dashboard/reports?tab=productivity", label: "Productivity", roles: ["ADMIN"] },
  { href: "/dashboard/reports", label: "Reports & Analytics", roles: ["ADMIN"] },
  { href: "/dashboard/meetings", label: "Team Huddle", roles: ["ADMIN", "HR", "MANAGER", "EMPLOYEE"] },
  { href: "/dashboard/employees", label: "Employees", roles: ["HR"] },
  { href: "/dashboard/reports", label: "My Report", roles: ["EMPLOYEE"] },
];

ok("a person's own home uses the dashboard name", pageTitle(items, "/dashboard/admin", "ADMIN", "Admin Dashboard") === "Admin Dashboard");
ok("My Profile", pageTitle(items, "/dashboard/profile", "HR", null) === "My Profile");
ok("two Admin items on /employees: the plain one (User Management) names the page, not the ?tab= shortcut", pageTitle(items, "/dashboard/employees", "ADMIN", null) === "User Management");
ok("two Admin items on /reports: Reports & Analytics names the page, not the Productivity shortcut", pageTitle(items, "/dashboard/reports", "ADMIN", null) === "Reports & Analytics");
ok("the same address is named per role (HR: Employees, Employee: My Report)", pageTitle(items, "/dashboard/employees", "HR", null) === "Employees" && pageTitle(items, "/dashboard/reports", "EMPLOYEE", null) === "My Report");
ok("Employee Overview and User Management have different titles on different addresses", pageTitle(items, "/dashboard/employee-overview", "ADMIN", null) === "Employee Overview" && pageTitle(items, "/dashboard/employees", "ADMIN", null) !== "Employee Overview");
ok("Admin's Team Huddle entry uses the page's own name", pageTitle(items, "/dashboard/meetings", "ADMIN", null) === "Team Huddle");
ok("a page with no menu entry for this role still gets its own name, not 'Dashboard'", pageTitle(items, "/dashboard/corrections", "EMPLOYEE", null) === "Attendance Corrections" && pageTitle(items, "/dashboard/office-network", "ADMIN", null) === "Office Network" && pageTitle(items, "/dashboard/holidays", "MANAGER", null) === "Holidays" && pageTitle(items, "/dashboard/queries", "ADMIN", null) === "Query Desk");
ok("sub-pages use the parent's name", pageTitle(items, "/dashboard/policies/abc-123", "HR", null) === "Policies" && pageTitle(items, "/dashboard/payroll/approve", "HR", null) === "Payroll Approval");
ok("an unknown address falls back to 'Dashboard'", pageTitle(items, "/dashboard/nothing-here", "HR", null) === "Dashboard");
ok("a similar prefix is not mistaken for the page (/dashboard/teams is not /dashboard/team)", pageTitle(items, "/dashboard/teams", "HR", null) === "Dashboard");
ok("no address is listed twice in the fallback list", new Set(EXTRA_TITLES.map(([p]) => p)).size === EXTRA_TITLES.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
