// Tasks & Performance: the counting rules, in one place (pure, no browser, no network).
// It works on the SAME rows the Daily Tasks queue shows (GET /tasks/review/queue), so the two pages can never disagree. Employee-SUBMITTED tasks only:
// manager-assigned tasks are not in those rows, so nothing is counted twice.
//
// Definitions (kept visible on the page too):
//   Submitted   every task the employee sent, except ones they withdrew (cancelled).
//   Approved / Pending / Rejected   the manager's decision on the task. Progress is a separate thing.
//   To Do / In Progress / Completed / Blocked   the work itself, counted for tasks that were not rejected.
//   Average rating   the mean of the saved star ratings of RATED tasks only. A task with no rating is never a 0 or a 5; nobody rated = no average.
//   Open   not rejected and not completed (work still to do).
//   Overdue (old unfinished)   open, and its task day is more than `overdueDays` days before today.

export type Row = {
  id: string;
  userId: string;
  who: string;
  employeeCode: string | null;
  project?: string | null;
  approvalStatus?: string | null;
  status?: string | null;
  progress?: string | null;
  rating?: number | null;
  date: string; // YYYY-MM-DD, the task's own day
  title?: string;
};

export type Counts = {
  submitted: number; approved: number; pending: number; rejected: number;
  todo: number; inProgress: number; completed: number; blocked: number;
  open: number; overdue: number; rated: number; ratingSum: number; avgRating: number | null;
};

export const NO_PROJECT = "No project";

const cancelled = (r: Row) => String(r.status ?? "") === "CANCELLED";
const rejected = (r: Row) => String(r.approvalStatus ?? "") === "REJECTED";

/** The four progress values the page shows. Anything else (old data) reads as To Do, like the rest of the app. */
export function progressOf(r: Row): "TODO" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED" {
  const p = String(r.progress ?? "");
  if (p === "IN_PROGRESS" || p === "COMPLETED" || p === "BLOCKED") return p;
  if (p === "TODO" || p === "NOT_STARTED") return "TODO";
  const s = String(r.status ?? "");
  return s === "IN_PROGRESS" ? "IN_PROGRESS" : s === "COMPLETED" ? "COMPLETED" : "TODO";
}

const dayNumber = (iso: string) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
export const ageDays = (taskDay: string, today: string) => dayNumber(today) - dayNumber(taskDay);

export const isOpen = (r: Row) => !cancelled(r) && !rejected(r) && progressOf(r) !== "COMPLETED";
export const isOverdue = (r: Row, today: string, overdueDays: number) => isOpen(r) && ageDays(r.date, today) > overdueDays;

export function emptyCounts(): Counts {
  return { submitted: 0, approved: 0, pending: 0, rejected: 0, todo: 0, inProgress: 0, completed: 0, blocked: 0, open: 0, overdue: 0, rated: 0, ratingSum: 0, avgRating: null };
}

export function countRows(rows: Row[], today: string, overdueDays: number): Counts {
  const c = emptyCounts();
  for (const r of rows) {
    if (cancelled(r)) continue; // withdrawn: not a submission
    c.submitted++;
    const a = String(r.approvalStatus ?? "");
    if (a === "APPROVED") c.approved++;
    else if (a === "PENDING") c.pending++;
    else if (a === "REJECTED") { c.rejected++; continue; } // a rejected task has no progress or rating of its own
    const p = progressOf(r);
    if (p === "TODO") c.todo++;
    else if (p === "IN_PROGRESS") c.inProgress++;
    else if (p === "COMPLETED") c.completed++;
    else c.blocked++;
    if (p !== "COMPLETED") c.open++;
    if (isOverdue(r, today, overdueDays)) c.overdue++;
    if (r.rating != null) { c.rated++; c.ratingSum += r.rating; }
  }
  c.avgRating = c.rated > 0 ? Math.round((c.ratingSum / c.rated) * 10) / 10 : null;
  return c;
}

export type Group = { key: string; label: string; code: string | null; counts: Counts };

function groupBy(rows: Row[], key: (r: Row) => string, label: (r: Row) => string, code: (r: Row) => string | null, today: string, overdueDays: number): Group[] {
  const buckets = new Map<string, Row[]>();
  const meta = new Map<string, { label: string; code: string | null }>();
  for (const r of rows) {
    const k = key(r);
    buckets.set(k, [...(buckets.get(k) ?? []), r]);
    if (!meta.has(k)) meta.set(k, { label: label(r), code: code(r) });
  }
  return [...buckets.entries()]
    .map(([k, rs]) => ({ key: k, label: meta.get(k)!.label, code: meta.get(k)!.code, counts: countRows(rs, today, overdueDays) }))
    .sort((a, b) => b.counts.submitted - a.counts.submitted || a.label.localeCompare(b.label));
}

export const byEmployee = (rows: Row[], today: string, overdueDays: number) => groupBy(rows, (r) => r.userId, (r) => r.who || "Unknown", (r) => r.employeeCode, today, overdueDays);
export const byProject = (rows: Row[], today: string, overdueDays: number) => groupBy(rows, (r) => r.project || NO_PROJECT, (r) => r.project || NO_PROJECT, () => null, today, overdueDays);

/** Task completion history of a set of rows: per task day, how many were submitted and how many of those are completed. Oldest first. */
export function byDay(rows: Row[]): { day: string; submitted: number; completed: number }[] {
  const m = new Map<string, { day: string; submitted: number; completed: number }>();
  for (const r of rows) {
    if (cancelled(r) || rejected(r)) continue;
    const cur = m.get(r.date) ?? { day: r.date, submitted: 0, completed: 0 };
    cur.submitted++;
    if (progressOf(r) === "COMPLETED") cur.completed++;
    m.set(r.date, cur);
  }
  return [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** The old unfinished tasks, oldest first. */
export function overdueList(rows: Row[], today: string, overdueDays: number): (Row & { age: number })[] {
  return rows.filter((r) => isOverdue(r, today, overdueDays)).map((r) => ({ ...r, age: ageDays(r.date, today) })).sort((a, b) => b.age - a.age || a.who.localeCompare(b.who));
}

/** Narrow by employee (an id, never a name) and project (by name). Empty string = everyone / every project. */
export function narrow(rows: Row[], employeeId: string, project: string): Row[] {
  return rows.filter((r) => (!employeeId || r.userId === employeeId) && (!project || (r.project || NO_PROJECT) === project));
}

export const OVERDUE_CHOICES = [2, 3, 5, 7, 14] as const;
export const DEFAULT_OVERDUE_DAYS = 3;
