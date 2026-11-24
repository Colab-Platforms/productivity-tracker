"use client";

// OVERALL PERFORMANCE SCORE, as the SERVER works it out (backend/src/modules/tasks/tasks.weighted.ts). Nothing here calculates a score: every screen
// gets the same figure from the backend and only words it, so two screens can never disagree. (The API field is still called `weighted`.)
//   Overall = Completion % x 60% + Manager rating % x 40%. Task priority plays no part.

export type PerformanceStatus = "NO_TASKS" | "AWAITING_EVALUATION" | "PROVISIONAL" | "FINAL";
export type Weighted = {
  /** the Overall Performance Score; null = N/A (no tasks) or awaiting evaluation (see status) */
  percent: number | null;
  status: PerformanceStatus;
  provisional: boolean;
  /** eligible tasks (the sample size) */
  tasks: number;
  completed: number;
  notCompleted: number;
  partial: number;
  completedAfterCutoff: number;
  completionPercent: number | null;
  completionContribution: number | null;
  ratedTasks: number;
  awaitingRating: number;
  ratingSum: number;
  averageRating: number | null;
  ratingPercent: number | null;
  ratingContribution: number | null;
  notScored: { waitingForApproval: number; rejected: number };
};

export const STATUS_LABEL: Record<PerformanceStatus, string> = { NO_TASKS: "No tasks", AWAITING_EVALUATION: "Awaiting evaluation", PROVISIONAL: "Provisional", FINAL: "Final" };
export const STATUS_CHIP: Record<PerformanceStatus, string> = {
  NO_TASKS: "bg-slate-100 text-slate-600",
  AWAITING_EVALUATION: "bg-amber-50 text-amber-700",
  PROVISIONAL: "bg-violet-50 text-violet-700",
  FINAL: "bg-emerald-50 text-emerald-700",
};

/** "84%", "Awaiting evaluation" (completed work nobody has rated yet) or "N/A" (nothing to score is never shown as 0% or 100%). */
export function pctText(w: Pick<Weighted, "percent" | "status"> | null | undefined): string {
  if (!w) return "N/A";
  return w.percent !== null ? `${w.percent}%` : w.status === "AWAITING_EVALUATION" ? "Awaiting evaluation" : "N/A";
}
/** The sample size written beside a score: "(1 task)" / "(12 tasks)". */
export const sampleText = (w: Pick<Weighted, "tasks"> | null | undefined): string => (!w ? "" : `(${w.tasks} ${w.tasks === 1 ? "task" : "tasks"})`);
/** "84% (12 tasks)", with "provisional" when some ratings are still outstanding. */
export function scoreText(w: Weighted | null | undefined): string {
  if (!w) return "N/A";
  if (w.status === "NO_TASKS") return "N/A";
  return `${pctText(w)} ${sampleText(w)}${w.provisional ? " · provisional" : ""}`;
}
/** "8 of 12 tasks completed" (used in tooltips and exports). */
export const completedText = (w: Pick<Weighted, "completed" | "tasks"> | null | undefined): string => (!w ? "" : `${w.completed} of ${w.tasks} tasks completed`);
/** Kept for older callers: the completed / eligible figures the score is built from. */
export const pointsText = completedText;

/** One line under a score: what it is built from, and what is not part of it. */
export function WeightedNote({ w }: { w: Weighted | null | undefined }) {
  if (!w) return null;
  const waiting = w.notScored.waitingForApproval;
  const rejected = w.notScored.rejected;
  return (
    <p className="text-xs text-slate-500">
      {w.status === "NO_TASKS" ? "No approved tasks to score yet" : `${completedText(w)}${w.completionPercent !== null ? ` · completion ${w.completionPercent}%` : ""}${w.averageRating !== null ? ` · average rating ${w.averageRating}/5 (${w.ratedTasks} rated)` : ""}`}
      {w.awaitingRating > 0 ? ` · ${w.awaitingRating} awaiting evaluation` : ""}
      {w.partial ? ` · ${w.partial} partly done (not completed)` : ""}
      {w.completedAfterCutoff ? ` · ${w.completedAfterCutoff} finished after this period` : ""}
      {waiting ? ` · ${waiting} waiting for approval (not scored)` : ""}
      {rejected ? ` · ${rejected} rejected (not scored)` : ""}
    </p>
  );
}

/** The formula with the real numbers filled in (the same layout in the card and in the employee breakdown). */
export function FormulaLines({ w }: { w: Weighted }) {
  if (w.status === "NO_TASKS") return <p className="text-sm text-slate-500">No approved tasks in this period, so there is nothing to score (N/A).</p>;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      <div className="sm:col-span-2 mt-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Task completion (60%)</div>
      <div className="flex justify-between gap-3"><dt className="text-slate-500">Eligible tasks</dt><dd className="tabular-nums text-slate-900">{w.tasks}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-slate-500">Completed tasks</dt><dd className="tabular-nums text-slate-900">{w.completed}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-slate-500">Completion %</dt><dd className="tabular-nums text-slate-900">{w.completionPercent}%</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-slate-500">Contribution (× 0.60)</dt><dd className="tabular-nums font-medium text-slate-900">{w.completionContribution}</dd></div>
      <div className="sm:col-span-2 mt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Manager evaluation (40%)</div>
      <div className="flex justify-between gap-3"><dt className="text-slate-500">Rated tasks</dt><dd className="tabular-nums text-slate-900">{w.ratedTasks}{w.awaitingRating > 0 ? ` (${w.awaitingRating} pending evaluation)` : ""}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-slate-500">Average rating</dt><dd className="tabular-nums text-slate-900">{w.averageRating === null ? "Awaiting evaluation" : `${w.averageRating} / 5`}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-slate-500">Rating %</dt><dd className="tabular-nums text-slate-900">{w.ratingPercent === null ? "—" : `${w.ratingPercent}%`}</dd></div>
      <div className="flex justify-between gap-3"><dt className="text-slate-500">Contribution (× 0.40)</dt><dd className="tabular-nums font-medium text-slate-900">{w.ratingContribution === null ? "—" : w.ratingContribution}</dd></div>
      <div className="sm:col-span-2 mt-2 flex justify-between gap-3 border-t border-indigo-100 pt-2"><dt className="font-medium text-slate-700">Overall Performance Score</dt><dd className="font-semibold tabular-nums text-indigo-700">{scoreText(w)}</dd></div>
    </dl>
  );
}

/** A card: the big percentage, the status, the one-line note and the formula with the real numbers. */
export function WeightedCard({ w, title = "Overall Performance Score", showBreakdown = true }: { w: Weighted | null | undefined; title?: string; showBreakdown?: boolean }) {
  if (!w) return null;
  return (
    <section className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <span className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold text-indigo-700" data-testid="weighted-percent">{pctText(w)}</span>
          <span className="text-xs text-slate-500">{sampleText(w)}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[w.status]}`}>{STATUS_LABEL[w.status]}</span>
        </span>
      </div>
      <WeightedNote w={w} />
      {showBreakdown ? <div className="mt-3"><FormulaLines w={w} /></div> : null}
      <p className="mt-2 text-xs text-slate-400">Overall = completion % × 60% + manager rating % × 40%. Task priority is not part of the score. A completed task nobody has rated yet is shown as pending evaluation: it is never counted as 5 stars.</p>
    </section>
  );
}
