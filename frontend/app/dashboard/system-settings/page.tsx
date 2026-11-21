import { redirect } from "next/navigation";

// Old address kept: System Settings was removed from the menu. Its Shifts and Thresholds tabs live in User Management.
export default function OldSystemSettingsRoute() {
  redirect("/dashboard/employees?tab=Shifts");
}
