// ONE place that turns a stored role (ADMIN, HR, MANAGER, EMPLOYEE) into the words people read. Every screen that shows a role goes through here, so
// HR can never be shown as "Hr" or as "Admin", and a missing or unknown role is never turned into some other role.

export const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  HR: "HR",
  MANAGER: "Manager",
  EMPLOYEE: "Employee",
};

/** The role as people read it. An unknown value is shown as it is (never replaced by another role); nothing at all gives an empty string. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return "";
  return ROLE_LABEL[role] ?? role;
}

/** "HR Dashboard", "Admin Dashboard" ... for the two roles that have a home dashboard of their own; null for everyone else. */
export function dashboardTitle(role: string | null | undefined): string | null {
  return role === "ADMIN" || role === "HR" ? `${roleLabel(role)} Dashboard` : null;
}
