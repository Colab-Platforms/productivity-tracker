// The "Late Submission" label and its details, shared by the employee list and the manager's queue.
// `date` is the ORIGINAL task day; `late.submittedAt` is the real moment it was sent (shown in the company timezone).

import { formatDate, formatDateTime } from "@/lib/time";

export type LateInfo = { lateByDays: number; outsideWindow: boolean; allowedDays: number; reason: string | null; submittedAt: string };

const day = (iso: string) => formatDate(`${iso}T12:00:00Z`, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

export function LateBadge({ late }: { late?: LateInfo | null }) {
  if (!late) return null;
  return (
    <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800" title={`Submitted ${late.lateByDays} day${late.lateByDays === 1 ? "" : "s"} after the task date`}>
      Late submission
    </span>
  );
}

export function LateNote({ date, late, forManager = false }: { date?: string | null; late?: LateInfo | null; forManager?: boolean }) {
  if (!late) return null;
  return (
    <div className="mt-1 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
      <p>
        <span className="font-medium">Late submission</span>
        {date ? <> · Task date {day(date)}</> : null} · Submitted {formatDateTime(late.submittedAt, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })}
        {" "}({late.lateByDays} day{late.lateByDays === 1 ? "" : "s"} late)
        {forManager && late.outsideWindow ? <> · outside the allowed {late.allowedDays} day{late.allowedDays === 1 ? "" : "s"}</> : null}
      </p>
      {late.reason ? <p className="mt-0.5 break-words"><span className="font-medium">Reason:</span> {late.reason}</p> : forManager ? <p className="mt-0.5 text-amber-700">No reason given (inside the allowed window).</p> : null}
    </div>
  );
}
