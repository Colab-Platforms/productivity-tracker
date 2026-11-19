// Where each role lands. One list, used by the sign-in redirect, the dashboard address, the sidebar and every role page's guard, so a role can
// never be sent to another role's home.
//
//   Admin    -> /dashboard/admin      (the Admin control centre)
//   HR       -> /dashboard/hr         (the HR dashboard)
//   Manager  -> /dashboard/manager    (the manager's Today page)
//   Employee -> /dashboard/employee   (the employee's Today page)
//
// The shared Employees management page is /dashboard/employees (HR and Admin both use it, each with their own tabs).

export const ROLE_HOME: Record<string, string> = {
  ADMIN: "/dashboard/admin",
  HR: "/dashboard/hr",
  MANAGER: "/dashboard/manager",
  EMPLOYEE: "/dashboard/employee",
};

/** A Productivity Supervisor is an EMPLOYEE account with a read-only monitoring view on top; their own home is the supervisor dashboard. */
export const SUPERVISOR_HOME = "/dashboard/supervisor";

/** The home address for a stored role. An unknown or missing role gets the least-privileged home (the employee page), never Admin.
 *  `supervisor` (sent by the server for the two Productivity Supervisor accounts) only changes an EMPLOYEE's home; every other role keeps its own. */
export function homeFor(role: string | null | undefined, supervisor?: boolean): string {
  if (supervisor && role === "EMPLOYEE") return SUPERVISOR_HOME;
  return (role && ROLE_HOME[role]) || ROLE_HOME.EMPLOYEE;
}

/** Old links to /dashboard/admin that carried a filter (?tab=, ?role=, ?q=, ?status=) meant the Employees page; they are sent there. */
export function legacyAdminTarget(search: string): string | null {
  const qs = new URLSearchParams(search);
  const keys = ["tab", "role", "q", "status"];
  return keys.some((k) => qs.has(k)) ? `/dashboard/employees${search.startsWith("?") ? search : search ? `?${search}` : ""}` : null;
}
