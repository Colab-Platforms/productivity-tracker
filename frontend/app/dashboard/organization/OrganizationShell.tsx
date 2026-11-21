"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useMe } from "../layout";
import { useRoleGate } from "../_routing/useRoleGate";
import { ViewTabs } from "../_assigned/ViewTabs";

// ONE section for three existing modules. The tab strip is the same component Daily Tasks uses. Each tab is its own address
// (/dashboard/organization/<tab>), so refresh, direct links and Back / Forward work, and switching tabs is a client-side navigation (no full reload).
// The tabs are filtered by role here only to avoid showing a tab nobody could open: every module still checks the role on the server.
export const ORG_TABS = [
  { key: "company", label: "Company Management", roles: ["ADMIN"] },
  { key: "hierarchy", label: "Organization Hierarchy", roles: ["ADMIN"] },
  { key: "projects", label: "Project Management", roles: ["ADMIN"] },
] as const;
export type OrgTab = (typeof ORG_TABS)[number]["key"];

export default function OrganizationShell({ tab, children }: { tab: OrgTab; children: React.ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const { allowed } = useRoleGate(["ADMIN"]); // anyone else is sent to their own home, never to another role's
  const strip = useRef<HTMLDivElement>(null);
  // on a phone the strip scrolls: keep the active tab in view (after a switch, a refresh or a direct link)
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [tab, allowed]);
  const tabs = ORG_TABS.filter((t) => (t.roles as readonly string[]).includes(me?.role ?? ""));
  if (!allowed) return null;
  return (
    <div className="space-y-5">
      <div ref={strip} className="max-w-full overflow-x-auto pb-1" data-testid="org-tabs">
        <ViewTabs tabs={tabs.map((t) => ({ key: t.key, label: t.label }))} value={tab} onChange={(k) => router.push(`/dashboard/organization/${k}`)} label="Organization Management sections" scroll />
      </div>
      {children}
    </div>
  );
}
