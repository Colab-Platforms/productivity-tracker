// Manager-ASSIGNED tasks: the pure rules. (No database here, so they are easy to test.)
//
// An assigned task is a daily_tasks row with `assignedById` set. It never goes through approval or star rating: the manager hands it over, the employee
// works it (To do -> In progress -> Completed) and the manager CONFIRMS it, or sends it back with a reason.
// Stored with no new column: status PENDING = To do, IN_PROGRESS, COMPLETED; `reviewedAt` set = the manager confirmed it. History, comments and the
// optional due date are rows in the existing append-only task_events, each note starting with ASSIGNED_PREFIX.

export const ASSIGNED_PREFIX = "ASGN1:";

export type AssignedStage = "TODO" | "IN_PROGRESS" | "AWAITING_CONFIRMATION" | "CONFIRMED" | "CANCELLED";

export function stageOf(status: string, reviewedAt: Date | null | undefined): AssignedStage {
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "COMPLETED") return reviewedAt ? "CONFIRMED" : "AWAITING_CONFIRMATION";
  if (status === "IN_PROGRESS") return "IN_PROGRESS";
  return "TODO";
}

/** What the EMPLOYEE may do next. TODO and IN_PROGRESS can move to each other or to Completed; a completed task can be taken back until it is confirmed. */
export type EmployeeMove = "TODO" | "IN_PROGRESS" | "COMPLETED";
export function employeeMoveAllowed(from: AssignedStage, to: EmployeeMove): boolean {
  if (from === "CONFIRMED" || from === "CANCELLED") return false;
  if (from === "AWAITING_CONFIRMATION") return to === "IN_PROGRESS"; // take it back before the manager confirms
  if (from === "TODO") return to === "IN_PROGRESS" || to === "COMPLETED";
  return to === "TODO" || to === "COMPLETED";
}
export const MOVE_STATUS: Record<EmployeeMove, string> = { TODO: "PENDING", IN_PROGRESS: "IN_PROGRESS", COMPLETED: "COMPLETED" };

export type AssignedPayload =
  | { v: 1; t: "created"; due: string | null }
  | { v: 1; t: "edited"; changes: { field: string; from: string | null; to: string | null }[]; due?: string | null }
  | { v: 1; t: "progress"; from: AssignedStage; to: AssignedStage; note: string | null }
  | { v: 1; t: "comment"; text: string }
  | { v: 1; t: "confirmed"; note: string | null }
  | { v: 1; t: "sent_back"; reason: string }
  | { v: 1; t: "cancelled" };

export const encodeAssigned = (p: AssignedPayload) => ASSIGNED_PREFIX + JSON.stringify(p);
export function decodeAssigned(note: string | null | undefined): AssignedPayload | null {
  if (!note || !note.startsWith(ASSIGNED_PREFIX)) return null;
  try {
    const p = JSON.parse(note.slice(ASSIGNED_PREFIX.length));
    return p && p.v === 1 && typeof p.t === "string" ? (p as AssignedPayload) : null;
  } catch {
    return null;
  }
}

/** The task's due day: the newest event that carries one (a later edit can move or clear it). */
export function dueOf(events: { payload: AssignedPayload }[]): string | null {
  let due: string | null = null;
  for (const e of events) {
    const p = e.payload;
    if ((p.t === "created" || p.t === "edited") && p.due !== undefined) due = p.due;
  }
  return due;
}

/** Overdue = the due day has fully passed (in the company's timezone) and the work is not handed in yet. No due date = never overdue. */
export function isOverdue(stage: AssignedStage, due: string | null, todayIso: string): boolean {
  if (!due) return false;
  if (stage !== "TODO" && stage !== "IN_PROGRESS") return false;
  return due < todayIso;
}

export function checkText(label: "comment" | "note" | "reason", v: unknown, min: number, max: number): string {
  const s = String(v ?? "").trim();
  if (s.length < min) throw new Error(label === "reason" ? "REASON_REQUIRED" : "COMMENT_REQUIRED");
  if (s.length > max) throw new Error(label === "reason" ? "REASON_TOO_LONG" : "COMMENT_TOO_LONG");
  return s;
}

/** Strict YYYY-MM-DD, a real calendar day, or null. */
export function parseDue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("BAD_DUE_DATE");
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error("BAD_DUE_DATE");
  return s;
}

export type Counts = { total: number; todo: number; inProgress: number; awaiting: number; confirmed: number; overdue: number };
export function countStages(rows: { stage: AssignedStage; overdue: boolean }[]): Counts {
  const c: Counts = { total: 0, todo: 0, inProgress: 0, awaiting: 0, confirmed: 0, overdue: 0 };
  for (const r of rows) {
    if (r.stage === "CANCELLED") continue;
    c.total++;
    if (r.stage === "TODO") c.todo++;
    else if (r.stage === "IN_PROGRESS") c.inProgress++;
    else if (r.stage === "AWAITING_CONFIRMATION") c.awaiting++;
    else c.confirmed++;
    if (r.overdue) c.overdue++;
  }
  return c;
}
