"use client";

import HrDashboard from "../HrDashboard";
import { useRoleGate } from "../_routing/useRoleGate";

// HR's home: /dashboard/hr. Anyone else is sent to their own home (an Admin to /dashboard/admin, and so on).
export default function HrHomePage() {
  const { allowed } = useRoleGate(["HR"]);
  return allowed ? <HrDashboard /> : null;
}
