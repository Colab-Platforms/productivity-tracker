"use client";

import BreakManagement from "../_breaks/BreakManagement";
import { useRoleGate } from "../_routing/useRoleGate";

// Break Management: Admin only (anyone else is sent to their own home; the server refuses everyone but Admins too).
export default function BreakManagementPage() {
  const { allowed } = useRoleGate(["ADMIN"]);
  return allowed ? <BreakManagement /> : null;
}
