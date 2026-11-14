"use client";

import OrgHierarchy from "../_hierarchy/OrgHierarchy";
import { useRoleGate } from "../_routing/useRoleGate";

// Organization Hierarchy: the Admin's view of the reporting structure (own address, own page). User Management stays at /dashboard/employees.
// Only an Admin may open it (anyone else is sent to their own home); the server limits the people to the companies the Admin acts on and decides
// every change to a reporting manager.
export default function OrganizationHierarchyPage() {
  const { allowed } = useRoleGate(["ADMIN"]);
  return allowed ? <OrgHierarchy /> : null;
}
