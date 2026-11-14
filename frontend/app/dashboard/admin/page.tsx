"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AdminDashboard from "../_admin/AdminDashboard";
import { useRoleGate } from "../_routing/useRoleGate";
import { legacyAdminTarget } from "@/lib/roleHome";

// The Admin's home: /dashboard/admin (the Owner Dashboard). This address used to be the Employees page, so an old link that carries a filter
// (?tab=Teams, ?role=MANAGER ...) is sent to /dashboard/employees with the same filter, for whoever opens it (HR included). Anyone else who is not
// an Admin is sent to their own home.
//
// The filter is read from the address of THIS page through Next's own search params. It used to be read from window.location when the page
// mounted, which during a click inside the app is still the PREVIOUS page's address: clicking "Owner Dashboard" from User Management
// (?tab=Teams) or from a filtered page (?q=...) was mistaken for an old link and bounced straight back. Never read window.location for this.
function AdminHome() {
  const router = useRouter();
  const params = useSearchParams();
  const search = params.toString() ? `?${params.toString()}` : "";
  const legacy = legacyAdminTarget(search);
  const { allowed } = useRoleGate(["ADMIN"], legacy === null);
  useEffect(() => {
    if (legacy) router.replace(legacy);
  }, [legacy, router]);
  return legacy === null && allowed ? <AdminDashboard /> : null;
}

export default function AdminHomePage() {
  return (
    <Suspense fallback={null}>
      <AdminHome />
    </Suspense>
  );
}
