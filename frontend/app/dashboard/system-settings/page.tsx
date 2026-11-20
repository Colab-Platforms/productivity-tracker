"use client";

import { AdminScreen } from "../employees/AdminScreen";

// System Settings: Shifts and Thresholds (Admin only). The same tab components User Management uses.
export default function SystemSettingsPage() {
  return <AdminScreen mode="settings" />;
}
