"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { homeFor } from "@/lib/roleHome";
import { useMe } from "../layout";

/**
 * The guard for a role's own page. Returns `allowed` only when the signed-in person has one of the roles; anyone else is sent to THEIR own home
 * (never shown the page, never sent to another role's home). The server enforces every number and action on its own; this only keeps people
 * on the right address. `enabled: false` pauses the redirect (used while a page is forwarding an old address somewhere else first).
 */
export function useRoleGate(roles: string[], enabled = true) {
  const me = useMe();
  const router = useRouter();
  const allowed = !!me && roles.includes(me.role);
  useEffect(() => {
    if (enabled && me && !allowed) router.replace(homeFor(me.role));
  }, [enabled, me, allowed, router]);
  return { me, allowed };
}
