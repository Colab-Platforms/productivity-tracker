// The pure rules of the manager step (no database), so they can be tested on their own.

export type Candidate = { id: string; role: string; status: string; platformId: string };

/** Who may answer in the manager step: the person they report to and the managers of the teams they are in, but only active people with
 *  the MANAGER role, in the same company, and never the requester. A HR/Admin boss is not a manager step (HR decides anyway).
 *  An empty list means there is no manager step: the request goes straight to HR. */
export function pickApprovers(requester: { id: string; platformId: string }, candidates: Candidate[]): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    if (c.role !== "MANAGER" || c.status !== "ACTIVE") continue;
    if (c.platformId !== requester.platformId || c.id === requester.id) continue;
    if (!out.includes(c.id)) out.push(c.id);
  }
  return out;
}

export type StepState = { status: string } | null;
export type Gate = "OK" | "WAITING" | "SKIP_REASON_REQUIRED" | "SKIP" | "REJECTED_BY_MANAGER";

/** May HR decide now? No step, or the manager already approved or was skipped: yes. The manager rejected: never. Still waiting: only by
 *  explicitly deciding without the manager, which needs a reason of at least 5 characters. */
export function hrGate(step: StepState, skip: { skipManager?: boolean; skipReason?: string } = {}): Gate {
  if (!step) return "OK";
  if (step.status === "APPROVED" || step.status === "SKIPPED") return "OK";
  if (step.status === "REJECTED") return "REJECTED_BY_MANAGER";
  if (skip.skipManager === true) return String(skip.skipReason ?? "").trim().length >= 5 ? "SKIP" : "SKIP_REASON_REQUIRED";
  return "WAITING";
}
