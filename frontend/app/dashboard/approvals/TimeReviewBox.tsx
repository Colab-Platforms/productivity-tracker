"use client";

// The manager's view of how long the employee actually worked on a submitted task, next to the reasonable time the manager confirmed.
// Actual time is READ-ONLY and comes from the same automatic task timer the employee sees and the Work Efficiency Index uses (backend tasks.timer.ts);
// nothing here can change it. The reasonable time is the manager's own assessment (set in the rating box) and is always entered after the work, so it is
// labelled a post-completion estimate, never a pre-approved target.
import { durationShort, useLiveSeconds, type TaskTimerData } from "../_timer/TaskTimer";
import { useMe } from "../layout";

export type TimeReviewData = { expectedSeconds: number; reviewedAt: string; afterCompletion: boolean };

const stamp = (iso: string | null | undefined, tz: string) => (iso ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso)) : "—");
const minutesOf = (s: number) => Math.round(s / 60);

export function TimeReviewBox({ timer, timeReview }: { timer?: TaskTimerData | null; timeReview?: TimeReviewData | null }) {
  const me = useMe();
  const tz = me?.platform?.timezone ?? "Asia/Kolkata";
  const live = useLiveSeconds(timer);
  const tracked = !!timer?.tracked;
  const actualMin = tracked ? minutesOf(live) : null;
  const expectedMin = timeReview ? minutesOf(timeReview.expectedSeconds) : null;
  const diff = actualMin != null && expectedMin != null ? actualMin - expectedMin : null;
  return (
    <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs" data-testid="time-review">
      <p className="text-slate-500">
        Started <span className="text-slate-700">{tracked ? stamp(timer?.firstStartedAt, tz) : "—"}</span> · Submitted <span className="text-slate-700">{tracked ? stamp(timer?.lastSubmittedAt, tz) : "—"}</span>
        {timer?.running ? <span className="ml-2 text-emerald-600">running now</span> : null}
        {timer?.pausedReason ? <span className="ml-2 text-amber-700">paused ({timer.pausedReason === "BREAK" ? "break" : "clock-out"})</span> : null}
      </p>
      <div className="mt-1 grid grid-cols-2 gap-3">
        <div>
          <p className="text-slate-400">Actual time taken (tracked, read-only)</p>
          <p className="text-sm font-semibold text-slate-900" data-testid="actual-time">{tracked ? durationShort(live) : "Not Tracked"}</p>
        </div>
        <div>
          <p className="text-slate-400">Reasonable time for this work (your estimate)</p>
          <p className="text-sm font-semibold text-slate-900" data-testid="reasonable-time">{expectedMin != null ? durationShort(timeReview!.expectedSeconds) : "Not set"}</p>
          {timeReview && <p className="text-[11px] text-slate-400" data-testid="estimate-label">Set after completion{timeReview.reviewedAt ? ` · ${stamp(timeReview.reviewedAt, tz)}` : ""}</p>}
        </div>
      </div>
      {diff != null && (
        <p className="mt-1 text-slate-600" data-testid="time-diff">
          Actual {actualMin} min · Reasonable {expectedMin} min · Difference <span className={diff > 0 ? "font-medium text-amber-700" : "font-medium text-emerald-700"}>{diff > 0 ? "+" : ""}{diff} min</span>
        </p>
      )}
    </div>
  );
}
