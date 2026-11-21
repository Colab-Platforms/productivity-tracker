import { redirect } from "next/navigation";

// /dashboard/organization opens the default tab.
export default function OrganizationIndex() {
  redirect("/dashboard/organization/company");
}
