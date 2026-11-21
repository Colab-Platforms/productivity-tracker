import { redirect } from "next/navigation";

// Old address kept: Project Management is now a tab of Organization Management.
export default function OldProjectsRoute() {
  redirect("/dashboard/organization/projects");
}
