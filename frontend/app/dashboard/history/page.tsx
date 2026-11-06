"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPatch } from "@/lib/api";
import { formatTime, getPlatformTimezone, isoDaysAgo } from "@/lib/time";
import { NO_REMARK, lateRemarkText } from "../reports/_team/lateRemark";
import { Modal } from "../_employees/Modal";
import { Stars } from "../_ratings/Stars";

type DayTask = {
  id: string; title: string; description: string | null; weight: string; status: string; approvalStatus: string; rating: number | null; ratingComment: string | null;
  completionNote: string | null; reviewNote: string | null; rejectionNote: string | null; project: string | null; assigned: boolean; completedAt?: string | null;
};
type DayData = { date: string; score: { percent: number | null; earned?: number; total?: number } & Record<string, unknown>; tasks: DayTask[] };

// Calendar day of a timestamp in the company timezone (YYYY-MM-DD).
function dayOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: getPlatformTimezone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
// Finished on a later day than the task's own day.
function markedLate(t: DayTask, taskDay: string): boolean {
  return t.status === "COMPLETED" && !!t.completedAt && dayOf(t.completedAt) > taskDay;
}
// Approved, not finished, not graded. The server also enforces the 30-day limit.
function canMarkDone(t: DayTask): boolean {
  return t.approvalStatus === "APPROVED" && (t.status === "PENDING" || t.status === "IN_PROGRESS") && t.rating == null;
}

const WEIGHT_LABEL:Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Urgent" };

// What happened to this task, in plain words.
function taskState(t: DayTask): { label: string; tone: string } {
  if (t.approvalStatus === "REJECTED") return { label: "Not approved", tone: "bg-red-50 text-red-700" };
  if (t.approvalStatus === "PENDING") return { label: "Waiting for approval", tone: "bg-amber-50 text-amber-700" };
  if (t.status === "COMPLETED") {
    if (t.rating != null) return { label: `Rated ${t.rating}/5`, tone: t.rating >= 4 ? "bg-emerald-50 text-emerald-700" : t.rating === 3 ? "bg-sky-50 text-sky-700" : "bg-red-50 text-red-700" };
    return { label: "Done, waiting for rating", tone: "bg-amber-50 text-amber-700" };
  }
  if (t.status === "CANCELLED") return { label: "Cancelled", tone: "bg-slate-100 text-slate-600" };
  return { label: t.status === "IN_PROGRESS" ? "In progress" : "To do", tone: "bg-indigo-50 text-indigo-700" };
}

// The tasks the person had on one earlier day (their own only).
function DayTasksModal({ date, onClose }: { date: string; onClose: () => void }) {
  const [res, setRes] = useState<{ date: string; data?: DayData; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    apiGet<DayData>(`/tasks/day?date=${date}`)
      .then((data) => live && setRes({ date, data }))
      .catch((e: Error) => live && setRes({ date, error: e.message }));
    return () => { live = false; };
  }, [date]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  // Forgot to tick it on the day: mark it done now. The server stamps the real time; the manager sees it as done (flagged late).
  async function markDone(id: string) {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await apiPatch(`/tasks/${id}`, { status: "COMPLETED", ...(note.trim() ? { completionNote: note.trim() } : {}) });
      setConfirmId(null);
      setNote("");
      const data = await apiGet<DayData>(`/tasks/day?date=${date}`);
      setRes({ date, data });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not mark the task done");
    } finally {
      setBusy(false);
    }
  }

  const current = res && res.date === date ? res : null;
  const title = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
  return (
    <Modal title={`Tasks on ${title}`} subtitle={current?.data ? `${current.data.tasks.length} task${current.data.tasks.length === 1 ? "" : "s"}${current.data.score.percent !== null ? ` · score ${current.data.score.percent}%` : ""}` : undefined} onClose={onClose} width="max-w-2xl">
      {!current && <div className="skeleton h-32" aria-busy="true" />}
      {current?.error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{current.error}</p>}
      {current?.data && current.data.tasks.length === 0 && <p className="rounded-xl bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">No tasks were recorded on this day.</p>}
      <ul className="space-y-3">
        {current?.data?.tasks.map((t) => {
          const s = taskState(t);
          return (
            <li key={t.id} className="rounded-2xl border border-indigo-100 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-medium text-slate-900">{t.title}</p>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                {WEIGHT_LABEL[t.weight] ?? t.weight} priority{t.project ? ` · ${t.project}` : ""}{t.assigned ? " · assigned by your manager" : ""}
              </p>
              {t.description && <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{t.description}</p>}
              {t.completionNote && <p className="mt-2 text-sm text-slate-600"><span className="font-medium text-slate-700">Your note: </span>{t.completionNote}</p>}
              {t.rating != null && <p className="mt-1"><Stars value={t.rating} size={14} /></p>}
              {(t.ratingComment || t.reviewNote || t.rejectionNote) && <p className="mt-1 text-sm text-slate-600"><span className="font-medium text-slate-700">Manager&apos;s comment: </span>{t.ratingComment || t.reviewNote || t.rejectionNote}</p>}
              {markedLate(t, date) && <p className="mt-2"><span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-700">Ticked later, on {dayOf(t.completedAt!)} · your manager decides</span></p>}
              {canMarkDone(t) && (
                confirmId === t.id ? (
                  <div className="mt-3 space-y-2">
                    <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} placeholder="Note for your manager, e.g. finished on the day, forgot to tick" className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900" />
                    {actionError && <p className="text-sm text-red-700">{actionError}</p>}
                    <div className="flex gap-2">
                      <button onClick={() => markDone(t.id)} disabled={busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? "Saving…" : "Confirm done"}</button>
                      <button onClick={() => { setConfirmId(null); setNote(""); setActionError(""); }} disabled={busy} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-700 hover:bg-indigo-50/60">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setConfirmId(t.id); setNote(""); setActionError(""); }} className="mt-3 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Mark as done</button>
                )
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

type Row = {
  date: string;
  loginAt: string | null;
  logoutAt: string | null;
  status: string;
  productiveSeconds: number;
  breakSeconds: number; // Tea / Lunch / Personal / Other (Washroom is separate)
  washroomSeconds?: number;
  meetingSeconds: number;
  breakCount: number;
  washroomCount?: number;
  meetingCount: number;
  wasLateLogin: boolean;
  lateByMinutes: number;
  lateRemark?: string | null;
  arrival?: string;
  arrivalMinutes?: number | null;
  huddleSeconds?: number;
  autoClosed: boolean;
  onLeave: boolean;
  leaveType: string | null;
  taskTotal: number;
  taskDone: number;
  taskPercent: number | null;
  avgRating: number | null; // average of the manager's star ratings on that day's finished tasks
  ratedCount: number;
};

type Data = {
  from: string;
  to: string;
  target: number;
  breakBudget: number;
  rows: Row[];
  summary: {
    daysWorked: number;
    daysOnLeave: number;
    daysLate: number;
    totalProductive: number;
    avgProductive: number;
    totalBreak: number;
    totalWashroom?: number;
    totalMeeting: number;
    avgTaskScore: number | null;
  };
};

function hm(total: number) {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function HistoryPage() {
  const [data, setData] = useState<Data | null>(null);
  const [from, setFrom] = useState(isoDaysAgo(29));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [error, setError] = useState("");
  const [openDay, setOpenDay] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Data>(`/tracker/history?from=${from}&to=${to}`));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load history");
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  // CSV is built in the browser from data already on screen — no extra
  // endpoint, and what you export is exactly what you can see.
  function exportCsv() {
    if (!data) return;

    const headers = [
      "Date",
      "Clock in",
      "Clock out",
      "Productive",
      "Break",
      "Washroom",
      "Team Huddle",
      "Breaks taken",
      "Late by (min)",
      "Late remark",
      "Auto closed",
      "On leave",
      "Tasks done",
      "Task score %",
      "Avg rating (out of 5)",
    ];

    const lines = data.rows.map((r) =>
      [
        r.date,
        r.loginAt ? formatTime(r.loginAt) : "",
        r.logoutAt ? formatTime(r.logoutAt) : "",
        hm(r.productiveSeconds),
        hm(r.breakSeconds),
        hm(r.washroomSeconds ?? 0),
        hm(r.huddleSeconds ?? 0),
        r.breakCount,
        r.wasLateLogin ? r.lateByMinutes : 0,
        lateRemarkText({ arrival: r.arrival, loginAt: r.loginAt, arrivalMinutes: r.arrivalMinutes, lateReason: r.lateRemark }, getPlatformTimezone()),
        r.autoClosed ? "yes" : "no",
        r.onLeave ? r.leaveType ?? "yes" : "no",
        `${r.taskDone}/${r.taskTotal}`,
        r.taskPercent ?? "",
        r.avgRating ?? "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    );

    const csv = [headers.join(","), ...lines].join("\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8;" })
    );

    const a = document.createElement("a");
    a.href = url;
    a.download = `my-history-${data.from}-to-${data.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-8 page-6xl">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-slate-400">Your record</p>
          <h1 className="text-2xl font-semibold text-slate-900 mt-0.5">
            My history
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900"
          />
          <span className="text-slate-400 text-sm">to</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900"
          />
          <button
            onClick={exportCsv}
            disabled={!data || data.rows.length === 0}
            className="rounded-xl border border-indigo-200 text-slate-700 text-sm font-medium px-4 py-2 hover:bg-indigo-50/60 disabled:opacity-40"
          >
            Export CSV
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-red-50 border border-red-200 px-4 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
            {[
              ["Days worked", String(data.summary.daysWorked)],
              ["Avg productive", hm(data.summary.avgProductive)],
              ["Total productive", hm(data.summary.totalProductive)],
              ["Days late", String(data.summary.daysLate)],
              [
                "Avg task score",
                data.summary.avgTaskScore === null
                  ? "—"
                  : `${data.summary.avgTaskScore}%`,
              ],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-2xl bg-white shadow-[var(--shadow-card)] px-4 py-3"
              >
                <p className="text-xs text-slate-500">{label}</p>
                <p className="text-2xl font-semibold text-slate-900 mt-1 tabular-nums">
                  {value}
                </p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl bg-white shadow-[var(--shadow-card)] overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="border-b border-indigo-50 bg-slate-50/60">
                  <th className="text-left px-5 py-3 font-medium text-slate-500">
                    Date
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-slate-500">
                    In / out
                  </th>
                  <th className="text-right px-4 py-3 font-medium text-slate-500">
                    Productive
                  </th>
                  <th className="text-right px-4 py-3 font-medium text-slate-500">
                    Break
                  </th>
                  <th className="text-right px-4 py-3 font-medium text-slate-500" title="Washroom time is tracked on its own. It is not break time and does not use the break allowance.">
                    Washroom
                  </th>
                  <th className="text-right px-4 py-3 font-medium text-slate-500">
                    Team Huddle
                  </th>
                  <th className="text-right px-5 py-3 font-medium text-slate-500">
                    Tasks
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-indigo-50">
                {data.rows.map((r) => {
                  const hitTarget = r.productiveSeconds >= data.target;
                  const overBreak = r.breakSeconds > data.breakBudget;

                  return (
                    <tr key={r.date} className="hover:bg-indigo-50/60/60">
                      <td className="px-5 py-3">
                        <button
                          onClick={() => setOpenDay(r.date)}
                          title="See the tasks for this day"
                          className="text-left font-medium text-indigo-700 underline-offset-2 hover:underline"
                        >
                          {new Date(`${r.date}T00:00:00Z`).toLocaleDateString(
                            "en-IN",
                            { day: "numeric", month: "short", weekday: "short" }
                          )}
                        </button>
                        <div className="flex gap-1.5 mt-0.5">
                          {r.onLeave && (
                            <span className="text-xs text-sky-600">
                              on leave
                            </span>
                          )}
                          {(r.arrival === "LATE" || r.arrival === "HALF_DAY") && (
                            <span className={`text-xs ${r.lateRemark ? "text-amber-700" : "text-slate-400"}`} title={r.lateRemark ?? NO_REMARK}>
                              {r.arrival === "HALF_DAY" ? "Half Day" : "Late"}: {r.lateRemark ? (r.lateRemark.length > 50 ? r.lateRemark.slice(0, 50) + "…" : r.lateRemark) : NO_REMARK}
                            </span>
                          )}
                          {r.autoClosed && (
                            <span className="text-xs text-slate-400">
                              auto-closed
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600 tabular-nums">
                        {r.loginAt
                          ? formatTime(r.loginAt, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "—"}
                        {" – "}
                        {r.logoutAt
                          ? formatTime(r.logoutAt, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "—"}
                        {r.wasLateLogin && (
                          <span className="ml-1.5 text-xs text-amber-600">
                            +{r.lateByMinutes}m
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-4 py-3 text-right tabular-nums font-medium ${
                          hitTarget ? "text-emerald-700" : "text-slate-900"
                        }`}
                      >
                        {hm(r.productiveSeconds)}
                      </td>
                      <td
                        className={`px-4 py-3 text-right tabular-nums ${
                          overBreak ? "text-red-600 font-medium" : "text-slate-600"
                        }`}
                      >
                        {hm(r.breakSeconds)}
                        <span className="text-xs text-slate-400">
                          {" "}
                          ·{r.breakCount}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{(r.washroomSeconds ?? 0) > 0 ? hm(r.washroomSeconds ?? 0) : <span className="text-slate-300">—</span>}</td>
                      <td className="px-4 py-3 text-right text-slate-600 tabular-nums">
                        {(r.huddleSeconds ?? 0) > 0 ? hm(r.huddleSeconds ?? 0) : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-5 py-3 text-right tabular-nums text-slate-600">
                        {r.taskTotal === 0 ? (
                          "—"
                        ) : (
                          <>
                            {r.taskDone}/{r.taskTotal}
                            <span className="ml-1.5 text-xs text-slate-400">
                              {r.taskPercent}%
                            </span>
                            {r.avgRating != null && (
                              <span className="ml-1.5 text-xs text-amber-600" title={`Average of ${r.ratedCount} star rating${r.ratedCount === 1 ? "" : "s"} from your manager`}>
                                ★ {r.avgRating}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {data.rows.length === 0 && (
              <p className="px-6 py-10 text-center text-sm text-slate-400">
                No days recorded in this range.
              </p>
            )}
          </div>
        </>
      )}
      {openDay && <DayTasksModal date={openDay} onClose={() => setOpenDay(null)} />}
    </div>
  );
}