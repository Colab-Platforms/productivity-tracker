"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AdminDashboard from "../_admin/AdminDashboard";
import { useRoleGate } from "../_routing/useRoleGate";
import { legacyAdminTarget } from "@/lib/roleHome";

// The Admin's home: /dashboard/admin (the Admin control centre). This address used to be the Employees page, so an old link that carries a filter
// (?tab=Teams, ?role=MANAGER ...) is sent to /dashboard/employees with the same filter, for whoever opens it (HR included). Anyone else who is not
// an Admin is sent to their own home.
export default function AdminHomePage() {
  const router = useRouter();
  // Decided once, on arrival (the layout only renders pages after sign-in, so the address is known).
  const [legacy] = useState<string | null>(() => (typeof window === "undefined" ? null : legacyAdminTarget(window.location.search)));
  const { allowed } = useRoleGate(["ADMIN"], legacy === null);
  useEffect(() => {
    if (legacy) router.replace(legacy);
  }, [legacy, router]);
  return legacy === null && allowed ? <AdminDashboard /> : null;
}
