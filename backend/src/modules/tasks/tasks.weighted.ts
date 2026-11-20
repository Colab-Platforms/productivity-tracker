// ---------------------------------------------------------------------------
// WEIGHTED PERFORMANCE: the ONE place that decides what a task is worth and what it has earned. Pure rules, no database. Every dashboard, report and
// Excel export gets its figure from here (through the backend), so the same tasks can never score differently on two screens.
//
//   Priority weights      Critical 5 · High 5 · Medium 4 · Low 1   (these values exist here and nowhere else)
//   What a task earns     Completed                                   100% of its weight
//                         Partially completed (manager's mark)        50%
//                         Not started, in progress, blocked           0
//   Weighted performance  earned points / possible points x 100, to two decimals; N/A (null) when there is nothing to score
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

/** The share of a task's weight it has earned: 1, 0.5 or 0. */
export function creditFor(t: WTask): 0 | 0.5 | 1 {
  if (!isScorable(t)) return 0;
  const status = String(t.status);
  if (status === "PENDING") return 0; // not started
  const outcome = String(t.outcome ?? "");
  if (outcome === "PARTIALLY_COMPLETED") return PARTIAL_CREDIT;
  if (outcome === "FAILED") return 0;
  return status === "COMPLETED" ? 1 : 0; // In Progress and Blocked have earned nothing yet
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
  let earned = 0, possible = 0, count = 0, completed = 0, partial = 0, waiting = 0, rejected = 0;
  for (const t of unique) {
    const approval = String(t.approvalStatus);
    if (approval === "PENDING" && String(t.status) !== "CANCELLED") waiting++;
    if (approval === "REJECTED") rejected++;
    if (!isScorable(t)) continue;
    const p = priorityOf(t.weight);
    const w = PRIORITY_WEIGHT[p];
    const c = creditFor(t);
    const line = lines.get(p) as PriorityLine;
    line.tasks++; line.possible += w; line.earned += w * c;
    if (c === 1) { line.completed++; completed++; }
    if (c === PARTIAL_CREDIT) { line.partial++; partial++; }
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
    notScored: { waitingForApproval: waiting, rejected },
    byPriority: PRIORITY_ORDER.map((p) => { const l = lines.get(p) as PriorityLine; return { ...l, earned: r2(l.earned) }; }),
  };
}

/** "56.67%" or "N/A": the one way a figure is written, so the words match everywhere. */
export const percentText = (w: Pick<Weighted, "percent">): string => (w.percent === null ? "N/A" : `${w.percent}%`);
