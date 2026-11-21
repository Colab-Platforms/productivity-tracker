import { redirect } from "next/navigation";

// Old address kept: Company Management is now a tab of Organization Management.
export default function OldCompaniesRoute() {
  redirect("/dashboard/organization/company");
}
