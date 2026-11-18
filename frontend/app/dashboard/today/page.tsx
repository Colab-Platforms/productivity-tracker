"use client";

// "Productivity Tracker" in the HR menu. HR gets the HR dashboard at /dashboard, so their own clock-in screen lives here.
// An Admin's own productivity is not tracked, so Admin has no clock-in screen: an Admin who opens this address is sent to the Admin home.
import TodayView from "../TodayView";
import { useRoleGate } from "../_routing/useRoleGate";

export default function TodayRoute() {
  const { me } = useRoleGate(["HR", "MANAGER", "EMPLOYEE"]);
  if (!me || me.role === "ADMIN") return null;
  return <TodayView />;
}
