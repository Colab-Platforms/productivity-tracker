// ---------------------------------------------------------------------------
// WEIGHTED PERFORMANCE: the ONE place that decides what a task is worth and what it has earned. Pure rules, no database. Every dashboard, report and
// Excel export gets its figure from here (through the backend), so the same tasks can never score differently on two screens.
//
//   Priority weights      Critical 5 · High 5 · Medium 4 · Low 1   (these values exist here and nowhere else)
//   What a task earns     Completed, rated by the manager             its weight x stars / 5   (5 stars = all of it, 3 stars = 60%, 1 star = 20%)
//                         Completed, NOT rated yet                    100% of its weight (it is not treated as 5 stars; it is "awaiting rating",
//                                                                     counted at full credit until the manager rates it, then the score moves)
//                         Partially completed (manager's mark)        50% (that mark IS the manager's quality call, so stars are not applied again)
//                         Not started, in progress, blocked           0
//   Weighted performance  earned points / possible points x 100, to two decimals; N/A (null) when there is nothing to score
//   Possible points are always the full weights, so a low rating lowers the score and 100% needs every counted task completed AND rated 5 stars
//   (or not yet rated).
//
// Which tasks are scored: approved tasks only, not cancelled, each task once. Pending and rejected tasks earn nothing and are not part of the
// possible points (they are shown as their own counts); a manager's rating (stars) is separate and never changes this figure; deleted tasks are
// filtered out by the queries that read tasks (`activeTasks()`), and the same task id is never counted twice.
// "Partially completed" is the manager's decision, stored in the existing `outcome` column (PARTIALLY_COMPLETED); Completed is the employee's
// own status (a task graded FAILED in the old system earns nothing). A task still To Do cannot be partly done: it earns 0 whatever else is stored.
// ---------------------------------------------------------------------------

export const PRIORITY_WEIGHT = { CRITICAL: 5, HIGH: 5, MEDIUM: 4, LOW: 1 } as const;
export type Priority = keyof typeof PRIORITY_WEIGHT;
/** Highest first: the order breakdowns are shown in. */
export const PRIORITY_ORDER: Priority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
/** The priority of a task that has none (or an unknown one): the system's own default, never a high weight. */
export const DEFAULT_PRIORITY: Priority = "MEDIUM";
export const PARTIAL_CREDIT = 0.5;
export const PRIORITY_LABEL: Record<Priority, string> = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low" };

export type WTask = {
  id?: string | null;
  /** The manager's stars (1..5) for this task, or null when it has not been rated. REQUIRED so a caller cannot forget it: leaving it out would silently ignore ratings. */
  rating: number | null;
  weight?: unknown; // the task's priority (daily_tasks.weight)
  status?: unknown; // PENDING (To Do) | IN_PROGRESS | COMPLETED | CANCELLED
  approvalStatus?: unknown;
  outcome?: unknown; // PARTIALLY_COMPLETED = the manager's partial mark; FAILED = an old grade
};

export function priorityOf(weight: unknown): Priority {
  const w = String(weight ?? "").toUpperCase();
  return (w in PRIORITY_WEIGHT ? w : DEFAULT_PRIORITY) as Priority;
}
export const weightOf = (weight: unknown): number => PRIORITY_WEIGHT[priorityOf(weight)];

/** Counted in the score: approved, and not cancelled. */
export const isScorable = (t: WTask): boolean => String(t.approvalStatus) === "APPROVED" && String(t.status) !== "CANCELLED";

/** What the manager's stars do to a completed task's points: stars / 5; no rating (or a value outside 1..5) = 1, i.e. nothing is taken away until it is rated. */
export function ratingFactor(rating: number | null | undefined): number {
  return hasRating(rating) ? (rating as number) / 5 : 1;
}
export const hasRating = (rating: unknown): boolean => typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 5;

/** How a scored task is judged before ratings: COMPLETED (full), PARTIAL (the manager's half-credit mark) or NONE (earns nothing yet). */
export function kindOf(t: WTask): "COMPLETED" | "PARTIAL" | "NONE" {
  if (!isScorable(t)) return "NONE";
  const status = String(t.status);
  if (status === "PENDING") return "NONE"; // not started
  const outcome = String(t.outcome ?? "");
  if (outcome === "PARTIALLY_COMPLETED") return "PARTIAL";
  if (outcome === "FAILED") return "NONE";
  return status === "COMPLETED" ? "COMPLETED" : "NONE"; // In Progress and Blocked have earned nothing yet
}

/** The share of a task's weight it has earned: a completed task earns stars/5 of it (all of it while unrated), a partial one 0.5, anything else 0. */
export function creditFor(t: WTask): number {
  const k = kindOf(t);
  if (k === "PARTIAL") return PARTIAL_CREDIT;
  if (k === "COMPLETED") return ratingFactor(t.rating);
  return 0;
}

export type PriorityLine = { priority: Priority; label: string; weight: number; tasks: number; completed: number; partial: number; earned: number; possible: number };
export type Weighted = {
  /** earned / possible x 100 to two decimals; null = nothing to score (show N/A, never 0% or 100%) */
  percent: number | null;
  earned: number;
  possible: number;
  /** scored tasks (approved, not cancelled) */
  tasks: number;
  completed: number;
  partial: number;
  /** scored tasks that have earned nothing yet */
  notCompleted: number;
  /** completed tasks the manager has rated / not rated yet (the unrated ones count at full credit until they are rated) */
  rated: number;
  awaitingRating: number;
  /** points taken off completed tasks because of their stars (possible - earned among completed tasks) */
  lostToRatings: number;
  /** submitted tasks that are not scored, with the reason; shown beside the score so nobody wonders where a task went */
  notScored: { waitingForApproval: number; rejected: number };
  byPriority: PriorityLine[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function weightedPerformance(tasks: readonly WTask[]): Weighted {
  // each task once (the same id may appear in two lists that were joined)
  const seen = new Set<string>();
  const unique: WTask[] = [];
  for (const t of tasks) {
    const id = t.id ? String(t.id) : null;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    unique.push(t);
  }

  const lines = new Map<Priority, PriorityLine>(PRIORITY_ORDER.map((p) => [p, { priority: p, label: PRIORITY_LABEL[p], weight: PRIORITY_WEIGHT[p], tasks: 0, completed: 0, partial: 0, earned: 0, possible: 0 }]));
  let earned = 0, possible = 0, count = 0, completed = 0, partial = 0, waiting = 0, rejected = 0, rated = 0, awaitingRating = 0, lost = 0;
  for (const t of unique) {
    const approval = String(t.approvalStatus);
    if (approval === "PENDING" && String(t.status) !== "CANCELLED") waiting++;
    if (approval === "REJECTED") rejected++;
    if (!isScorable(t)) continue;
    const p = priorityOf(t.weight);
    const w = PRIORITY_WEIGHT[p];
    const kind = kindOf(t);
    const c = creditFor(t);
    const line = lines.get(p) as PriorityLine;
    line.tasks++; line.possible += w; line.earned += w * c;
    if (kind === "COMPLETED") {
      line.completed++; completed++;
      if (hasRating(t.rating)) rated++; else awaitingRating++;
      lost += w * (1 - c);
    }
    if (kind === "PARTIAL") { line.partial++; partial++; }
    count++; possible += w; earned += w * c;
  }
  return {
    percent: possible > 0 ? r2((earned / possible) * 100) : null,
    earned: r2(earned),
    possible,
    tasks: count,
    completed,
    partial,
    notCompleted: count - completed - partial,
    rated,
    awaitingRating,
    lostToRatings: r2(lost),
    notScored: { waitingForApproval: waiting, rejected },
    byPriority: PRIORITY_ORDER.map((p) => { const l = lines.get(p) as PriorityLine; return { ...l, earned: r2(l.earned) }; }),
  };
}

/** "56.67%" or "N/A": the one way a figure is written, so the words match everywhere. */
export const percentText = (w: Pick<Weighted, "percent">): string => (w.percent === null ? "N/A" : `${w.percent}%`);
