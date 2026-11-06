// ===========================================================================
// /dashboard has no screen of its own any more: it sends each person to THEIR home (see lib/roleHome.ts).
//   Admin -> /dashboard/admin · HR -> /dashboard/hr · Manager -> /dashboard/manager · Employee -> /dashboard/employee
// The role comes from the live /auth/me (the layout), and the server enforces every number and action regardless of which address is open.
// ===========================================================================

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMe } from "./layout";
import { homeFor } from "@/lib/roleHome";

export default function DashboardPage() {
  const me = useMe();
  const router = useRouter();
  useEffect(() => {
    if (me) router.replace(homeFor(me.role));
  }, [me, router]);
  return null;
}
