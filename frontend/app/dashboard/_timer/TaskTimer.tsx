"use client";

// THE AUTOMATIC TASK TIMER, as the server worked it out (backend tasks.timer.ts). Nothing here decides what counts: a task's time follows its STATUS (In Progress
// runs, To Do / Blocked / Completed stop it) and breaks and clock-out are already taken out by the server. This only shows the figures and ticks every second
// while the clock is really running, from the server's own clock reading. There is no Start button.
import { useEffect, useRef, useState } from "react";
import { useMe } from "../layout";

export type TaskTimerData = {
  tracked: boolean;
  running: boolean;
  pausedReason: "BREAK" | "CLOCKED_OUT" | null;
  firstStartedAt: string | null;
  lastSubmittedAt: string | null;
  activeSeconds: number;
  elapsedSeconds: number;
  pausedSeconds: number;
  sessionCount: number;
  serverNow: string;
};

/** "02h 14m 35s" */
export function durationText(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}h ${p(Math.floor((s % 3600) / 60))}m ${p(s % 60)}s`;
}
/** A short "4h 12m" for tables and exports-on-screen. */
export function durationShort(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function clock(iso: string | null, tz: string): string {
  return iso ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso)) : "";
}
function dayClock(iso: string | null, tz: string): string {
  return iso ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso)) : "";
}

/** Seconds of work so far: the server's figure plus the seconds that passed on this screen since it was received, while the clock really runs. */
export function useLiveSeconds(timer: TaskTimerData | undefined | null): number {
  const received = useRef({ at: Date.now(), key: "" });
  const key = timer ? `${timer.serverNow}|${timer.activeSeconds}|${timer.running}` : "";
  if (received.current.key !== key) received.current = { at: Date.now(), key };
  const [, tick] = useState(0);
  const running = !!timer?.running;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  if (!timer) return 0;
  return timer.activeSeconds + (timer.running ? Math.max(0, (Date.now() - received.current.at) / 1000) : 0);
}

/**
 * The timer line of a task card: "Time spent 02h 14m 35s" (live), when it started, when it was submitted, and "Paused due to break / clock-out" when the task is
 * In Progress but the person is away. Older work reads "Not tracked". `onStale` is called once a minute while the clock runs, so a page can refresh the figures
 * (a break or a clock-out that happened elsewhere then shows up without a manual reload).
 */
export function TaskTimer({ timer, status, onStale, compact = false }: { timer?: TaskTimerData | null; status?: string; onStale?: () => void; compact?: boolean }) {
  const me = useMe();
  const tz = me?.platform?.timezone ?? "Asia/Kolkata";
  const live = useLiveSeconds(timer);
  const open = !!timer?.running || !!timer?.pausedReason;
  useEffect(() => {
    if (!onStale || !open) return;
    const id = setInterval(onStale, 60_000);
    return () => clearInterval(id);
  }, [onStale, open]);

  if (!timer || !timer.tracked) {
    return <p className="mt-1 text-xs text-slate-400" data-testid="task-timer">Time spent: Not tracked</p>;
  }
  const done = status === "COMPLETED" || !!timer.lastSubmittedAt;
  return (
    <div className={compact ? "mt-1 text-xs" : "mt-1.5 text-xs"} data-testid="task-timer">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-slate-500">{done && !timer.running ? "Total time spent" : "Time spent"}</span>
        <span className={`font-mono text-[13px] font-semibold tabular-nums ${timer.running ? "text-emerald-600" : "text-slate-700"}`} data-testid="task-timer-value" data-running={timer.running ? "1" : "0"}>{durationText(live)}</span>
        {timer.running && <span className="inline-flex items-center gap-1 text-emerald-600"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />running</span>}
        {timer.pausedReason === "BREAK" && <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700" data-testid="task-timer-paused">Paused due to break</span>}
        {timer.pausedReason === "CLOCKED_OUT" && <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700" data-testid="task-timer-paused">Paused due to clock-out</span>}
      </p>
      <p className="mt-0.5 text-slate-400">
        {timer.firstStartedAt ? `Started ${dayClock(timer.firstStartedAt, tz)}` : ""}
        {timer.lastSubmittedAt && done ? ` · ${status === "COMPLETED" ? "Submitted" : "Completed"} ${clock(timer.lastSubmittedAt, tz)}` : ""}
        {timer.elapsedSeconds > 0 && !compact ? ` · Elapsed ${durationShort(timer.elapsedSeconds)}` : ""}
        {timer.pausedSeconds > 0 && !compact ? ` · Paused ${durationShort(timer.pausedSeconds)}` : ""}
      </p>
    </div>
  );
}
