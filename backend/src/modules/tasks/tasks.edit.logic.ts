// Editing a submitted task, and asking for a correction to an approved or rated one. Pure rules, no database.
//
// Where the history lives (no migration, owner's choice 2026-11-18): every edit and every correction step is ONE row in the existing, append-only
// `task_events` table (kind EDITED, which its CHECK allows). The note holds a small JSON document after the marker below: the old values, the new
// values, the approval status before and after, the manager before and after, and (for corrections) the reason, the decision and the rating that was
// cleared. A correction request is "pending" until a later decision row names its id. A normal reader of task_events sees only unrelated notes.

export const CHANGE_PREFIX = "TASKCHG1:";
export type ChangeType = "EDIT" | "CORRECTION_REQUESTED" | "CORRECTION_APPROVED" | "CORRECTION_REJECTED";

/** The values of a task that can be edited, as plain data. Anything a person never sets stays null. */
export type Snapshot = {
  title: string;
  description: string | null;
  projectId: string | null;
  project: string | null;
  managerId: string | null;
  manager: string | null;
  date: string; // YYYY-MM-DD
  hoursSpent: number | null;
  priority: string; // LOW | MEDIUM | HIGH | CRITICAL
  progress: string; // TODO | IN_PROGRESS | COMPLETED | BLOCKED
  blockedReason: string | null;
};
export type Field = keyof Snapshot;

export type RatingCopy = { rating: number; comment: string | null; ratedBy: string | null; ratedAt: string };

export type ChangePayload = {
  v: 1;
  type: ChangeType;
  requestId?: string; // on a decision: the id of the request row it answers
  changed: string[]; // fields that differ (the keys of before/after)
  before: Partial<Snapshot>;
  after: Partial<Snapshot>;
  approvalBefore: string;
  approvalAfter: string;
  reason?: string | null; // why a correction was asked for
  decisionNote?: string | null; // the manager's note when deciding
  previousRejection?: string | null; // the sent-back reason an edit replaced (kept here, never lost)
  rating?: RatingCopy | null; // the rating a correction approval removed
  ratingCleared?: boolean;
};

export type ChangeEventRow = { id: string; actorId: string; createdAt: Date; payload: ChangePayload };

export const FIELD_LABEL: Record<Field, string> = {
  title: "Task",
  description: "Details",
  projectId: "Project",
  project: "Project",
  managerId: "Reporting manager",
  manager: "Reporting manager",
  date: "Task date",
  hoursSpent: "Hours spent",
  priority: "Priority",
  progress: "Progress",
  blockedReason: "Blocked reason",
};

/** The fields an employee may change while the task is pending or sent back. */
export const DIRECT_FIELDS: Field[] = ["title", "description", "projectId", "managerId", "date", "hoursSpent", "priority", "progress", "blockedReason"];
/** The fields a correction request may change on an approved or rated task (never the date or the approving manager: owner's choice). */
export const CORRECTION_FIELDS: Field[] = ["title", "description", "projectId", "hoursSpent", "priority", "progress", "blockedReason"];

/** Pending or sent back (and not rated) = the employee edits it directly. Approved or rated = only through a correction request. */
export function editRoute(approvalStatus: string, rated: boolean): "DIRECT" | "CORRECTION" {
  if (rated) return "CORRECTION";
  return approvalStatus === "PENDING" || approvalStatus === "REJECTED" ? "DIRECT" : "CORRECTION";
}

const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/** The editable fields whose value differs, in a stable order. `projectId` and `managerId` carry the readable names with them. */
export function diffSnapshots(before: Snapshot, after: Snapshot, allowed: Field[] = DIRECT_FIELDS): Field[] {
  return allowed.filter((k) => !same(before[k], after[k]));
}

/** Only the changed keys (plus the names that belong to a changed project or manager) of a snapshot. */
export function pickChanged(s: Snapshot, changed: Field[]): Partial<Snapshot> {
  const out: Partial<Snapshot> = {};
  for (const k of changed) (out as Record<string, unknown>)[k] = s[k];
  if (changed.includes("projectId")) out.project = s.project;
  if (changed.includes("managerId")) out.manager = s.manager;
  return out;
}

export function encodeChange(p: ChangePayload): string {
  // `v` and `type` come first so a reader can match the start of the note without parsing it.
  const { v, type, ...rest } = p;
  return CHANGE_PREFIX + JSON.stringify({ v, type, ...rest });
}

export function decodeChange(note: string | null | undefined): ChangePayload | null {
  if (typeof note !== "string" || !note.startsWith(CHANGE_PREFIX)) return null;
  try {
    const p = JSON.parse(note.slice(CHANGE_PREFIX.length)) as ChangePayload;
    if (!p || p.v !== 1 || typeof p.type !== "string" || !Array.isArray(p.changed)) return null;
    return p;
  } catch {
    return null;
  }
}

export type RequestView = {
  id: string; // the request row's id
  by: string; // who asked
  at: Date;
  state: "PENDING" | "APPROVED" | "REJECTED";
  payload: ChangePayload;
  decision: ChangeEventRow | null;
};

/** Every correction request on a task, oldest first, with whether it is still waiting. Events must be in time order. */
export function deriveRequests(events: ChangeEventRow[]): RequestView[] {
  const decisions = new Map<string, ChangeEventRow>();
  for (const e of events) if ((e.payload.type === "CORRECTION_APPROVED" || e.payload.type === "CORRECTION_REJECTED") && e.payload.requestId) decisions.set(e.payload.requestId, e);
  return events
    .filter((e) => e.payload.type === "CORRECTION_REQUESTED")
    .map((e) => {
      const d = decisions.get(e.id) ?? null;
      return { id: e.id, by: e.actorId, at: e.createdAt, state: d ? (d.payload.type === "CORRECTION_APPROVED" ? ("APPROVED" as const) : ("REJECTED" as const)) : ("PENDING" as const), payload: e.payload, decision: d };
    });
}

export function pendingRequest(events: ChangeEventRow[]): RequestView | null {
  const p = deriveRequests(events).filter((r) => r.state === "PENDING");
  return p.length ? p[p.length - 1] : null;
}

export type EditInfo = { editedAt: string | null; editCount: number; pendingCorrection: boolean };

/** What the "Edited" label and the correction badge need: the last time the task really changed, how many times, and whether a request waits. */
export function editInfoOf(events: ChangeEventRow[]): EditInfo {
  const changes = events.filter((e) => e.payload.type === "EDIT" || e.payload.type === "CORRECTION_APPROVED");
  const last = changes.length ? changes[changes.length - 1] : null;
  return { editedAt: last ? last.createdAt.toISOString() : null, editCount: changes.length, pendingCorrection: pendingRequest(events) !== null };
}

/** A written reason for a correction or a refusal: 3 to 300 characters once trimmed. */
export function checkReason(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < 3) throw new Error("CORRECTION_REASON_REQUIRED");
  if (s.length > 300) throw new Error("CORRECTION_REASON_TOO_LONG");
  return s;
}

/**
 * The version token the screen sends back with an edit: the later of the task's and its entry details' last change. If either moved since the
 * screen loaded (another edit, a manager decision), the edit is refused instead of overwriting.
 */
export function versionOf(taskUpdatedAt: Date, entryUpdatedAt: Date | null | undefined): number {
  return Math.max(taskUpdatedAt.getTime(), entryUpdatedAt ? entryUpdatedAt.getTime() : 0);
}

/** What a task row carries for the Edit button and the "Edited" label: the version token, which route an edit takes, and the last change. */
export function editView(
  t: { updatedAt: Date; approvalStatus: string; rating?: number | null; assignedById: string | null },
  entryUpdatedAt: Date | null | undefined,
  info: EditInfo | undefined
) {
  return {
    version: versionOf(t.updatedAt, entryUpdatedAt),
    // null = this task cannot be edited by its owner at all (a task a manager assigned)
    editRoute: t.assignedById ? (null as null) : editRoute(String(t.approvalStatus), (t.rating ?? null) !== null),
    edited: info && info.editCount > 0 ? { at: info.editedAt, count: info.editCount } : null,
    pendingCorrection: info?.pendingCorrection === true,
  };
}

export function parseVersion(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? (/^\d+$/.test(v.trim()) ? Number(v.trim()) : Date.parse(v)) : NaN;
  return Number.isFinite(n) ? n : null;
}
