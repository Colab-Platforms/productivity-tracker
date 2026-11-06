// Pure rules for "Talk to Management". No database here, so they can be tested alone.
// ONE access rule: a thread belongs to exactly two people, the sender and the Admin it is addressed to. Nobody else.

export type ThreadFacts = { senderId: string; adminId: string; status: string };

export const SUBJECT_MIN = 3;
export const SUBJECT_MAX = 150;
export const BODY_MIN = 1;
export const BODY_MAX = 4000;

/** Sender or the chosen Admin. HR, managers, other Admins and company owners get nothing. */
export const canViewThread = (viewerId: string, t: ThreadFacts) => viewerId === t.senderId || viewerId === t.adminId;

export const isAdminOf = (viewerId: string, t: ThreadFacts) => viewerId === t.adminId;

/** Only the addressed Admin closes a thread. */
export const canClose = (viewerId: string, t: ThreadFacts) => isAdminOf(viewerId, t) && t.status !== "CLOSED";

/** Either side may write while the thread is open. */
export const canWrite = (viewerId: string, t: ThreadFacts) => canViewThread(viewerId, t) && t.status !== "CLOSED";

/** The status after a message: the Admin answering = REPLIED, the sender writing = OPEN (waiting for the Admin). */
export const statusAfterMessage = (viewerId: string, t: ThreadFacts) => (isAdminOf(viewerId, t) ? "REPLIED" : "OPEN");

/** A person cannot write to themselves, and the target must be an active Admin (checked by the caller against the database). */
export const canTarget = (senderId: string, adminId: string) => senderId !== adminId;

export const STATUS_LABEL: Record<string, string> = { OPEN: "Waiting for Admin", REPLIED: "Admin replied", CLOSED: "Closed" };

export function cleanSubject(raw: unknown) {
  return String(raw ?? "").trim().replace(/\s+/g, " ");
}
