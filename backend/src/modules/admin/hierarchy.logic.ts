// The reporting rules of the organization, as pure functions (no database), so they can be tested on their own.
//
//   Admin    -> nobody required
//   HR       -> nobody required
//   Manager  -> must report to an Admin (that Admin is the one who approves the manager's leave)
//   Employee -> must report to a Manager
//
// Nothing here knows any names: who is mapped to whom is data on each person ("reports to"), configured by Admin/HR.

export type ReportingCandidate = { id: string; role: string; status: string; platformId: string };

/** The role the person's reporting line must point to, or null when none is required. */
export function requiredBossRole(subjectRole: string): "MANAGER" | "ADMIN" | null {
  if (subjectRole === "EMPLOYEE") return "MANAGER";
  if (subjectRole === "MANAGER") return "ADMIN";
  return null;
}

export type ReportingError = "BAD_MANAGER" | "MANAGER_WRONG_ROLE" | "ADMIN_TOP_LEVEL";

/**
 * May `subject` report to `boss`? Null = yes. The boss must be an active person and never the subject, and by default of the SAME company.
 * `anyCompany` lifts the company condition: only the Admin-run hierarchy editor uses it, because reporting lines legitimately cross companies
 * (a group Admin over several companies, a manager running another company's team). Creating a person keeps the same-company rule.
 * Employee -> Manager only; Manager -> Admin only. HR may have a Manager or Admin boss, as before. An Admin reports to NOBODY: the Admins are the
 * top level of the organization, so no boss is accepted for an Admin (clearing one is always fine and never reaches this function).
 */
export function reportingError(subject: { id: string; role: string; platformId: string }, boss: ReportingCandidate | null, opts: { anyCompany?: boolean } = {}): ReportingError | null {
  if (!boss) return "BAD_MANAGER";
  if (boss.id === subject.id) return "BAD_MANAGER";
  if (subject.role === "ADMIN") return "ADMIN_TOP_LEVEL";
  if (!opts.anyCompany && boss.platformId !== subject.platformId) return "BAD_MANAGER";
  if (boss.status === "EXITED" || boss.status === "SUSPENDED") return "BAD_MANAGER";
  const need = requiredBossRole(subject.role);
  if (need) return boss.role === need ? null : "MANAGER_WRONG_ROLE";
  return boss.role === "MANAGER" || boss.role === "ADMIN" ? null : "MANAGER_WRONG_ROLE";
}

/** A person who needs a reporting line but has none that fits (used to list people HR must configure by hand). */
export function needsManualMapping(subject: { role: string; status: string }, boss: { role: string; status: string } | null): boolean {
  if (subject.status === "EXITED" || subject.status === "SUSPENDED") return false;
  const need = requiredBossRole(subject.role);
  if (!need) return false;
  if (!boss) return true;
  return boss.role !== need || boss.status === "EXITED" || boss.status === "SUSPENDED";
}
