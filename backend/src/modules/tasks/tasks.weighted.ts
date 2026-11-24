// ---------------------------------------------------------------------------
// OVERALL PERFORMANCE SCORE (the field is still called `weighted` in the API so no consumer breaks; every screen words it "Overall Performance
// Score"). The ONE place that decides it. Pure rules, no database. Every dashboard, report and Excel export gets its figure from here (through the
// backend), so the same tasks can never score differently on two screens.
//
//   Overall = Completion % x 0.60  +  Manager rating % x 0.40
//
//   ELIGIBLE tasks        approved and not cancelled, dated inside the period. Waiting-for-approval and rejected tasks are not eligible (they are
//                         shown as their own counts) and are never counted as completed. TASK PRIORITY IS NOT USED ANYWHERE in this score.
//   COMPLETED tasks       eligible, status Completed, not graded FAILED, not a manager-marked "partial" (that is "partly done", i.e. still
//                         incomplete), and finished on or before the report's cutoff (a task finished after the period ended is unfinished as of
//                         that report). A completed task with no completion time (older data) is counted as completed.
//   Completion %          completed / eligible x 100
//   Manager rating %      sum of the manager's stars / (rated tasks x 5) x 100, over COMPLETED tasks the manager has actually rated (1..5). A completed
//                         task with no rating is never given 5 stars and never given 0: it is "pending evaluation" and left out of this average.
//   Status                NO_TASKS            nothing eligible: N/A (never 0% or 100%)
//                         AWAITING_EVALUATION tasks are completed but none is rated yet: the overall score is N/A (the completion % is still shown)
//                         PROVISIONAL         some completed tasks are rated, some are not: the score uses the finalized ratings only and says how
//                                             many evaluations are outstanding; it is computed on read and never stored as final
//                         FINAL               every completed task is rated (or nothing is completed, so there is nothing to rate)
//   Nothing completed     eligible tasks exist but none is completed: Completion 0%, there is nothing to rate, so the overall score is 0% (Final).
//
// A manager's rating is separate from the "partial" mark: stars only describe completed work; a partial task is simply not completed yet.
// ---------------------------------------------------------------------------

export const COMPLETION_WEIGHT = 0.6;
export const RATING_WEIGHT = 0.4;

// Task priority is still a task attribute (forms, scheduling, filters) but it no longer weights ANY score: every task counts once, so choosing a
// higher priority can never raise (or lower) a score. The table stays so the Priority type and the older "Task score" code keep compiling, with
// equal values on purpose.
export const PRIORITY_WEIGHT = { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1 } as const;
export type Priority = keyof typeof PRIORITY_WEIGHT;
export const DEFAULT_PRIORITY: Priority = "MEDIUM";
export const PRIORITY_LABEL: Record<Priority, string> = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low" };
export function priorityOf(weight: unknown): Priority {
  const w = String(weight ?? "").toUpperCase();
  return (w in PRIORITY_WEIGHT ? w : DEFAULT_PRIORITY) as Priority;
}
/** What a task counts for in the older "Task score" screens: always 1 (priority does not weight scores). */
export const weightOf = (weight: unknown): number => PRIORITY_WEIGHT[priorityOf(weight)];

export type WTask = {
  id?: string | null;
  /** The manager's stars (1..5) for this task, or null when it has not been rated. REQUIRED so a caller cannot forget it. */
  rating: number | null;
  status?: unknown; // PENDING (To Do) | IN_PROGRESS | COMPLETED | CANCELLED
  approvalStatus?: unknown;
  outcome?: unknown; // PARTIALLY_COMPLETED = the manager's partial mark; FAILED = an old grade
  completedAt?: Date | string | null;
};
export type ScoreOptions = {
  /** As-of moment of the report: a completion after it does not count (the task is unfinished as of that report). null/undefined = no cutoff (live views). */
  cutoff?: Date | null;
};

export const hasRating = (rating: unknown): boolean => typeof rating === "number" && Number.isInteger(rating) && rating >= 1 && rating <= 5;

/** Eligible for the score: approved and not cancelled. */
export const isEligible = (t: WTask): boolean => String(t.approvalStatus) === "APPROVED" && String(t.status) !== "CANCELLED";

/** Successfully completed as of the cutoff (see the rules above). */
export function isCompletedTask(t: WTask, opts: ScoreOptions = {}): boolean {
  if (!isEligible(t) || String(t.status) !== "COMPLETED") return false;
  const outcome = String(t.outcome ?? "");
  if (outcome === "FAILED" || outcome === "PARTIALLY_COMPLETED") return false;
  if (opts.cutoff && t.completedAt) {
    const at = t.completedAt instanceof Date ? t.completedAt : new Date(String(t.completedAt));
    if (at.getTime() > opts.cutoff.getTime()) return false;
  }
  return true;
}

export type PerformanceStatus = "NO_TASKS" | "AWAITING_EVALUATION" | "PROVISIONAL" | "FINAL";
export type Weighted = {
  /** the Overall Performance Score, 0..100 to two decimals; null = N/A (nothing to score) or awaiting evaluation (see `status`) */
  percent: number | null;
  status: PerformanceStatus;
  /** true while some completed tasks are not rated yet (the score then uses finalized ratings only) */
  provisional: boolean;
  /** eligible tasks (the sample size shown beside the score) */
  tasks: number;
  completed: number;
  /** eligible tasks that are not completed (open, blocked, partly done, or finished after the report cutoff) */
  notCompleted: number;
  /** of those, tasks a manager marked partly done */
  partial: number;
  /** completed tasks finished AFTER the cutoff (counted as unfinished in this report) */
  completedAfterCutoff: number;
  completionPercent: number | null;
  completionContribution: number | null; // completion % x 0.60
  ratedTasks: number;
  /** completed tasks with no finalized manager rating yet (pending evaluation) */
  awaitingRating: number;
  ratingSum: number;
  averageRating: number | null; // out of 5
  ratingPercent: number | null;
  ratingContribution: number | null; // rating % x 0.40
  /** submitted tasks that are not eligible, with the reason; shown beside the score so nobody wonders where a task went */
  notScored: { waitingForApproval: number; rejected: number };
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function weightedPerformance(tasks: readonly WTask[], opts: ScoreOptions = {}): Weighted {
  // each task once (the same id may appear in two lists that were joined)
  const seen = new Set<string>();
  let eligible = 0, completed = 0, partial = 0, after = 0, rated = 0, ratingSum = 0, waiting = 0, rejected = 0;
  for (const t of tasks) {
    const id = t.id ? String(t.id) : null;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    const approval = String(t.approvalStatus);
    if (approval === "PENDING" && String(t.status) !== "CANCELLED") waiting++;
    if (approval === "REJECTED") rejected++;
    if (!isEligible(t)) continue;
    eligible++;
    if (isCompletedTask(t, opts)) {
      completed++;
      if (hasRating(t.rating)) { rated++; ratingSum += t.rating as number; }
    } else {
      if (String(t.status) === "COMPLETED" && String(t.outcome ?? "") === "PARTIALLY_COMPLETED") partial++;
      else if (String(t.status) === "COMPLETED" && isCompletedTask(t)) after++; // completed, but only after the cutoff
    }
  }
  const awaiting = completed - rated;
  const completionPercent = eligible > 0 ? (completed / eligible) * 100 : null;
  const ratingPercent = rated > 0 ? (ratingSum / (rated * 5)) * 100 : null;
  const completionContribution = completionPercent === null ? null : completionPercent * COMPLETION_WEIGHT;
  const ratingContribution = ratingPercent === null ? null : ratingPercent * RATING_WEIGHT;

  let status: PerformanceStatus;
  let overall: number | null;
  if (eligible === 0) { status = "NO_TASKS"; overall = null; }
  else if (completed === 0) { status = "FINAL"; overall = 0; } // nothing completed: nothing to rate, the completion part is 0
  else if (rated === 0) { status = "AWAITING_EVALUATION"; overall = null; }
  else {
    status = awaiting > 0 ? "PROVISIONAL" : "FINAL";
    overall = (completionPercent as number) * COMPLETION_WEIGHT + (ratingPercent as number) * RATING_WEIGHT;
  }
  return {
    percent: overall === null ? null : r2(overall),
    status,
    provisional: status === "PROVISIONAL",
    tasks: eligible,
    completed,
    notCompleted: eligible - completed,
    partial,
    completedAfterCutoff: after,
    completionPercent: completionPercent === null ? null : r2(completionPercent),
    completionContribution: completionContribution === null ? null : r2(completionContribution),
    ratedTasks: rated,
    awaitingRating: awaiting,
    ratingSum,
    averageRating: rated > 0 ? r2(ratingSum / rated) : null,
    ratingPercent: ratingPercent === null ? null : r2(ratingPercent),
    ratingContribution: ratingContribution === null ? null : r2(ratingContribution),
    notScored: { waitingForApproval: waiting, rejected },
  };
}

export const STATUS_LABEL: Record<PerformanceStatus, string> = { NO_TASKS: "No tasks", AWAITING_EVALUATION: "Awaiting evaluation", PROVISIONAL: "Provisional", FINAL: "Final" };

/** "84%" or "N/A" / "Awaiting evaluation": the one way a figure is written, so the words match everywhere. */
export const percentText = (w: Pick<Weighted, "percent" | "status">): string => (w.percent !== null ? `${w.percent}%` : w.status === "AWAITING_EVALUATION" ? "Awaiting evaluation" : "N/A");
