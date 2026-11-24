"use client";

// Priority-weighted performance, as the SERVER works it out (backend/src/modules/tasks/tasks.weighted.ts). Nothing here calculates a score:
// every screen gets the same figure from the backend and only words it, so two screens can never disagree.

export type WeightedLine = { priority: string; label: string; weight: number; tasks: number; completed: number; partial: number; earned: number; possible: number };
export type Weighted = {
  percent: number | null;
  earned: number;
  possible: number;
  tasks: number;
  completed: number;
  partial: number;
  notCompleted: number;
  /** completed tasks the manager has rated / not rated yet, and the points taken off because of stars below 5 */
  rated?: number;
  awaitingRating?: number;
  lostToRatings?: number;
  notScored: { waitingForApproval: number; rejected: number };
  byPriority: WeightedLine[];
};

/** "56.67%" or "N/A" (nothing to score is never shown as 0% or 100%). */
export function pctText(w: Pick<Weighted, "percent"> | null | undefined): string {
  return !w || w.percent === null ? "N/A" : `${w.percent}%`;
}
/** Points written the same way everywhere: "8.5 / 15". */
export function pointsText(w: Pick<Weighted, "earned" | "possible"> | null | undefined): string {
  return !w ? "—" : `${w.earned} / ${w.possible}`;
}

const PRIORITY_DOT: Record<string, string> = { CRITICAL: "bg-red-500", HIGH: "bg-orange-500", MEDIUM: "bg-amber-400", LOW: "bg-slate-400" };

/** One line under a score: points, and what is not part of it. */
export function WeightedNote({ w }: { w: Weighted | null | undefined }) {
  if (!w) return null;
  const waiting = w.notScored.waitingForApproval;
  const rejected = w.notScored.rejected;
  return (
    <p className="text-xs text-slate-500">
      {w.percent === null ? "No approved tasks to score yet" : `${pointsText(w)} points · ${w.completed} completed${w.partial ? ` · ${w.partial} partial` : ""} · ${w.notCompleted} not completed`}
      {w.lostToRatings ? ` · ${w.lostToRatings} pts lost to ratings below 5 stars` : ""}
      {w.awaitingRating ? ` · ${w.awaitingRating} awaiting rating (full credit until rated)` : ""}
      {waiting ? ` · ${waiting} waiting for approval (not scored)` : ""}
      {rejected ? ` · ${rejected} rejected (not scored)` : ""}
    </p>
  );
}

/** Table of points per priority (Critical, High, Medium, Low). */
export function PriorityBreakdown({ w }: { w: Weighted | null | undefined }) {
  if (!w) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[22rem] text-left text-sm">
        <caption className="sr-only">Weighted score by task priority</caption>
        <thead>
          <tr className="text-xs uppercase tracking-wide text-slate-500">
            <th className="py-1.5 pr-3 font-medium">Priority</th>
            <th className="py-1.5 pr-3 font-medium">Tasks</th>
            <th className="py-1.5 pr-3 font-medium">Completed</th>
            <th className="py-1.5 pr-3 font-medium">Partial</th>
            <th className="py-1.5 font-medium">Points</th>
          </tr>
        </thead>
        <tbody>
          {w.byPriority.map((l) => (
            <tr key={l.priority} className="border-t border-indigo-100">
              <td className="py-1.5 pr-3">
                <span className="inline-flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${PRIORITY_DOT[l.priority] ?? "bg-slate-400"}`} aria-hidden />
                  {l.label} <span className="text-slate-400">({l.weight})</span>
                </span>
              </td>
              <td className="py-1.5 pr-3">{l.tasks}</td>
              <td className="py-1.5 pr-3">{l.completed}</td>
              <td className="py-1.5 pr-3">{l.partial}</td>
              <td className="py-1.5">{l.possible ? `${l.earned} / ${l.possible}` : "—"}</td>
            </tr>
          ))}
          <tr className="border-t border-indigo-200 font-medium">
            <td className="py-1.5 pr-3">Total</td>
            <td className="py-1.5 pr-3">{w.tasks}</td>
            <td className="py-1.5 pr-3">{w.completed}</td>
            <td className="py-1.5 pr-3">{w.partial}</td>
            <td className="py-1.5">{pointsText(w)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** A card: the big percentage, the one-line note and (optionally) the priority table. */
export function WeightedCard({ w, title = "Weighted performance", showBreakdown = true }: { w: Weighted | null | undefined; title?: string; showBreakdown?: boolean }) {
  if (!w) return null;
  return (
    <section className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <span className="text-2xl font-semibold text-indigo-700" data-testid="weighted-percent">{pctText(w)}</span>
      </div>
      <WeightedNote w={w} />
      {showBreakdown ? <div className="mt-3"><PriorityBreakdown w={w} /></div> : null}
      <p className="mt-2 text-xs text-slate-400">Critical 5 · High 5 · Medium 4 · Low 1. Completed earns the full weight, a manager-marked partial earns half, anything else earns 0. Approved tasks only.</p>
    </section>
  );
}
