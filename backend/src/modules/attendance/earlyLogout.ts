// Early Logout Policy: reading and saving the one organisation-wide setting.
// If the table does not exist yet (migration not applied) the policy is simply OFF and attendance behaves exactly as before.

import { prisma } from "../../lib/prisma.js";
import { auditNote } from "../../lib/auditContext.js";
import { checkPolicyInput, earlyLogoutLabel, EARLY_LOGOUT_SATURDAYS, POLICY_OFF, type EarlyLogoutPolicy } from "./earlyLogout.logic.js";

let missingUntil = 0; // after a failed read, do not hammer a missing table for 30 s

export async function loadEarlyLogoutPolicy(): Promise<EarlyLogoutPolicy> {
  return (await readPolicy()).policy;
}

async function readPolicy(): Promise<{ ready: boolean; policy: EarlyLogoutPolicy; updatedAt: string | null }> {
  if (Date.now() < missingUntil) return { ready: false, policy: POLICY_OFF, updatedAt: null };
  try {
    const row = await prisma.earlyLogoutPolicy.findUnique({ where: { id: "global" } });
    if (!row) return { ready: true, policy: POLICY_OFF, updatedAt: null };
    return {
      ready: true,
      policy: { enabled: row.enabled, logoutTime: row.logoutTime, startDate: row.startDate ? row.startDate.toISOString().slice(0, 10) : null, targetHours: row.targetHours ?? null },
      updatedAt: row.updatedAt.toISOString(),
    };
  } catch {
    missingUntil = Date.now() + 30_000;
    return { ready: false, policy: POLICY_OFF, updatedAt: null };
  }
}

/** What the settings screen shows. */
export async function policyView() {
  const { ready, policy, updatedAt } = await readPolicy();
  return {
    ready,
    enabled: policy.enabled,
    logoutTime: policy.logoutTime,
    startDate: policy.startDate,
    targetHours: policy.targetHours,
    saturdays: [...EARLY_LOGOUT_SATURDAYS], // fixed: the 2nd and 4th Saturday
    label: earlyLogoutLabel(policy.logoutTime),
    updatedAt,
  };
}

/** Admin only (the route checks the role). Validates, saves, audits. */
export async function savePolicy(adminId: string, input: { enabled?: unknown; logoutTime?: unknown; startDate?: unknown; targetHours?: unknown }) {
  const checked = checkPolicyInput(input);
  if (!checked.ok) throw new Error(checked.error);
  const before = await readPolicy();
  if (!before.ready) throw new Error("FEATURES_NOT_READY");
  const start = checked.startDate ? new Date(`${checked.startDate}T00:00:00.000Z`) : null;
  await prisma.earlyLogoutPolicy.upsert({
    where: { id: "global" },
    create: { id: "global", enabled: checked.enabled, logoutTime: checked.logoutTime, startDate: start, targetHours: checked.targetHours, updatedById: adminId },
    update: { enabled: checked.enabled, logoutTime: checked.logoutTime, startDate: start, targetHours: checked.targetHours, updatedById: adminId },
  });
  const was = before.policy;
  auditNote({
    summary: `${checked.enabled ? "Switched on" : "Switched off"} the 2nd/4th Saturday early logout policy (${checked.logoutTime}${checked.startDate ? `, from ${checked.startDate}` : ""})`,
    before: { enabled: was.enabled, logoutTime: was.logoutTime, startDate: was.startDate, targetHours: was.targetHours },
    after: { enabled: checked.enabled, logoutTime: checked.logoutTime, startDate: checked.startDate, targetHours: checked.targetHours },
  });
  missingUntil = 0;
  return policyView();
}
