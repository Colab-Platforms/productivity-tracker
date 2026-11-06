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

export type ReportingError = "BAD_MANAGER" | "MANAGER_WRONG_ROLE";

/**
 * May `subject` report to `boss`? Null = yes. The boss must be an active person of the SAME company and never the subject.
 * Employee -> Manager only; Manager -> Admin only. For HR and Admin (no line required) a Manager or Admin boss is still accepted, as before.
 */
export function reportingError(subject: { id: string; role: string; platformId: string }, boss: ReportingCandidate | null): ReportingError | null {
  if (!boss) return "BAD_MANAGER";
  if (boss.id === subject.id) return "BAD_MANAGER";
  if (boss.platformId !== subject.platformId) return "BAD_MANAGER";
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
