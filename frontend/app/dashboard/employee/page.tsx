"use client";

import TodayView from "../TodayView";
import { useRoleGate } from "../_routing/useRoleGate";

// An employee's home: /dashboard/employee (the Today page). Anyone else is sent to their own home.
export default function EmployeeHomePage() {
  const { allowed } = useRoleGate(["EMPLOYEE"]);
  return allowed ? <TodayView /> : null;
}
