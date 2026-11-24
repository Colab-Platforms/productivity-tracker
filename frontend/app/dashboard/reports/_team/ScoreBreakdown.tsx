"use client";

// The Overall Performance Score of ONE person, opened by clicking the score: the formula with the real numbers, the individual ratings and how
// every task takes part (task date, completion date, whether it is inside the period). Read from the same server figure the table shows plus the
// task list behind the report; nothing is calculated here.
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { Modal } from "../../_employees/Modal";
import { FormulaLines, STATUS_CHIP, STATUS_LABEL, WeightedNote, sampleText, pctText, type Weighted } from "../../_weighted/Weighted";
import { PROGRESS_LABEL } from "../../_progress/progress";
import { dayLabel } from "./format";

type Row = { id: string; title: string; date: string; progress: string; approvalStatus: string; completedAt: string | null; rating: number | null; inScore?: boolean; scoreCompleted?: boolean; ratingStatus?: string };

const dateOnly = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: tz }).format(new Date(iso)) : "—");

export default function ScoreBreakdown({ userId, name, from, to, w, base, hrQuery, timezone, onClose }: { userId: string; name: string; from: string; to: string; w: Weighted; base: string; hrQuery: string; timezone: string; onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    apiGet<{ tasks: Row[] }>(`${base}/productivity/tasks?from=${from}&to=${to}&userId=${userId}${hrQuery ? `&${hrQuery}` : ""}`)
      .then((r) => live && setRows(r.tasks.filter((t) => t.inScore !== false || t.completedAt)))
      .catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [base, from, to, userId, hrQuery]);

  const period = from === to ? dayLabel(from) : `${dayLabel(from)} to ${dayLabel(to)}`;
  const inScore = (rows ?? []).filter((t) => t.inScore);
  const outside = (rows ?? []).filter((t) => !t.inScore);

  return (
    <Modal title="Overall Performance Score" subtitle={`${name} · ${period}`} onClose={onClose} width="max-w-3xl">
      <div className="space-y-4" data-testid="score-breakdown">
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-3xl font-semibold text-indigo-700" data-testid="breakdown-percent">{pctText(w)}</span>
          <span className="text-sm text-slate-500">{sampleText(w)}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[w.status]}`} data-testid="breakdown-status">{STATUS_LABEL[w.status]}</span>
        </div>
        {w.provisional && <p className="rounded-xl bg-violet-50 px-3 py-2 text-sm text-violet-800">Provisional: {w.awaitingRating} completed {w.awaitingRating === 1 ? "task is" : "tasks are"} still waiting for a manager rating. The rating part uses the {w.ratedTasks} finalized {w.ratedTasks === 1 ? "rating" : "ratings"} only and will change when the rest are rated.</p>}
        {w.status === "AWAITING_EVALUATION" && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">The work is completed but no manager has rated it yet, so the overall score cannot be calculated. Completion is {w.completionPercent}%.</p>}
        <WeightedNote w={w} />
        <FormulaLines w={w} />
        <p className="text-xs text-slate-500">Overall Performance Score = (Completion % × 0.60) + (Manager rating % × 0.40). Completion % = completed ÷ eligible tasks. Rating % = sum of the manager&apos;s stars ÷ (rated tasks × 5). Task priority is not used.</p>

        <div>
          <h3 className="mb-1 text-sm font-semibold text-slate-900">Tasks in this score</h3>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {!rows && !error && <div className="skeleton h-16" />}
          {rows && inScore.length === 0 && <p className="text-sm text-slate-500">No approved tasks dated inside this period.</p>}
          {inScore.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-xs">
                <thead><tr className="text-slate-400">
                  <th className="py-1 pr-2 font-medium">Task</th><th className="py-1 pr-2 font-medium">Original date</th><th className="py-1 pr-2 font-medium">Completed on</th>
                  <th className="py-1 pr-2 font-medium">Status</th><th className="py-1 pr-2 font-medium">Counted as</th><th className="py-1 text-right font-medium">Manager rating</th>
                </tr></thead>
                <tbody>
                  {inScore.map((t) => (
                    <tr key={t.id} className="border-t border-indigo-50 align-top">
                      <td className="max-w-[16rem] py-1.5 pr-2 text-slate-800"><span className="line-clamp-2 break-words">{t.title}</span></td>
                      <td className="py-1.5 pr-2 whitespace-nowrap text-slate-600">{dateOnly(`${t.date}T12:00:00Z`, "UTC")}</td>
                      <td className="py-1.5 pr-2 whitespace-nowrap text-slate-600">{dateOnly(t.completedAt, timezone)}</td>
                      <td className="py-1.5 pr-2 text-slate-600">{PROGRESS_LABEL[t.progress] ?? t.progress}</td>
                      <td className="py-1.5 pr-2 text-slate-600">{t.scoreCompleted ? "Completed" : t.progress === "COMPLETED" && t.completedAt ? "Unfinished (finished after this period)" : "Not completed"}</td>
                      <td className="py-1.5 text-right tabular-nums text-slate-800">
                        {t.ratingStatus === "RATED" ? `${t.rating} / 5` : t.ratingStatus === "PENDING_EVALUATION" ? <span className="text-violet-700">Pending evaluation</span> : <span className="text-slate-400">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {outside.length > 0 && (
            <p className="mt-2 text-xs text-slate-500">{outside.length} other {outside.length === 1 ? "task was" : "tasks were"} finished inside this period but dated earlier or are not approved, so {outside.length === 1 ? "it is" : "they are"} not part of this score (each task belongs to the period of its own date; nothing is counted twice).</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
