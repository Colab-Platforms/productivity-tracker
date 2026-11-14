"use client";

import EmployeeOverview from "../_overview/EmployeeOverview";
import { useRoleGate } from "../_routing/useRoleGate";

// Employee Overview: the Admin's read-only workforce picture. Its own address and its own page; User Management stays at /dashboard/employees.
// Only an Admin may open it (anyone else is sent to their own home); the server limits the numbers to the companies the Admin acts on.
export default function EmployeeOverviewPage() {
  const { allowed } = useRoleGate(["ADMIN"]);
  return allowed ? <EmployeeOverview /> : null;
}
