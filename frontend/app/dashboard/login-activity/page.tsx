"use client";

import { useRoleGate } from "../_routing/useRoleGate";
import LoginActivity from "../_security/LoginActivity";

// Admin and HR: the login history of the people in the companies they act on (the server limits every row; HR gets no analysis). Read only.
export default function LoginActivityPage() {
  const { me, allowed } = useRoleGate(["ADMIN", "HR"]);
  if (!me || !allowed) return null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Every sign-in attempt: successful, failed and blocked by the network rule. {me.role === "ADMIN" ? "Rows marked with a red label need a closer look." : "You see the people of the companies you act on."} Records cannot be edited and are kept for 6 months.
      </p>
      <LoginActivity mode="org" />
    </div>
  );
}
