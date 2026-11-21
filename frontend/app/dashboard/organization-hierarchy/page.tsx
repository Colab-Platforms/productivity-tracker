import { redirect } from "next/navigation";

// Old address kept: Organization Hierarchy is now a tab of Organization Management.
export default function OldHierarchyRoute() {
  redirect("/dashboard/organization/hierarchy");
}
