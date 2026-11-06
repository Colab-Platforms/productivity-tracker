"use client";

import TodayView from "../TodayView";
import { useRoleGate } from "../_routing/useRoleGate";

// A manager's home: /dashboard/manager (the Today page with the team sections). Anyone else is sent to their own home.
export default function ManagerHomePage() {
  const { allowed } = useRoleGate(["MANAGER"]);
  return allowed ? <TodayView /> : null;
}
