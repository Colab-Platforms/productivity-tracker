"use client";

import OrgHierarchy from "../../_hierarchy/OrgHierarchy";
import { useRoleGate } from "../../_routing/useRoleGate";

// Organization Hierarchy, as a tab of Organization Management. The screen itself is unchanged (OrgHierarchy). Only an Admin may open it; the server
// limits the people to the companies the Admin acts on and decides every change to a reporting manager.
export default function HierarchyView() {
  const { allowed } = useRoleGate(["ADMIN"]);
  return allowed ? <OrgHierarchy /> : null;
}
