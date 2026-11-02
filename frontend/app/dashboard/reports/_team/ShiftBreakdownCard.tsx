"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { clockTime, downloadCsv, hm } from "./format";

// Shift breakdown: how each person spent one day. Used on Reports & Analytics and on Team Attendance.
// Data: GET /team-attendance/shift-breakdown?date=YYYY-MM-DD (the manager's own people only).

type ShiftRow = {
  userId: string; name: string; employeeCode: string | null; teamName: string | null;
  hasSession: boolean; dayState: "WORKING" | "CLOCKED_OUT" | "NOT_CLOCKED_IN" | "ON_LEAVE" | "NO_RECORD";
  loginAt: string | null; logoutAt: string | null; working?: boolean; shiftSeconds: number | null;
  teaSeconds: number | null; lunchSeconds: number | null; bioSeconds: number | null; huddleSeconds: number | null; otherSeconds: number | null;
  breakSeconds: number | null; breakBudgetSeconds: number; productiveSeconds: number | null; productiveTargetSeconds: number;
};
type Shift = { generatedAt: string; timezone: string; date: string; isToday: boolean; rows: ShiftRow[] };

const th = "px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500";
const STATE_TEXT: Record<string, string> = { ON_LEAVE: "On leave", NOT_CLOCKED_IN: "Not clocked in", NO_RECORD: "No record" };

export default function ShiftBreakdownCard() {
  const [date, setDate] = useState("");
  const [maxDate, setMaxDate] = useState("");
  const [shift, setShift] = useState<Shift | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d: string) => {
    try {
      const data = await apiGet<Shift>(`/team-attendance/shift-breakdown${d ? `?date=${d}` : ""}`);
      setShift(data);
      setError("");
      if (!d) {
        setDate(data.date);
        setMaxDate(data.date);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(date), 0);
    const poll = setInterval(() => void load(date), 60000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [date, load]);

  const tz = shift?.timezone ?? "Asia/Kolkata";

  function exportCsv() {
    if (!shift) return;
    downloadCsv(
      `shift-breakdown-${shift.date}.csv`,
      ["Employee", "Employee ID", "Date", "Login", "Logout", "Shift", "Tea", "Lunch", "Washroom (not break)", "Huddle", "Other", "Total break", "Break allowance", "Break over allowance", "Productive", "Target"],
      shift.rows.map((r) =>
        r.hasSession
          ? [r.name, r.employeeCode, shift.date, clockTime(r.loginAt, tz), r.working ? "Working" : clockTime(r.logoutAt, tz), hm(r.shiftSeconds), hm(r.teaSeconds), hm(r.lunchSeconds), hm(r.bioSeconds), hm(r.huddleSeconds), hm(r.otherSeconds), hm(r.breakSeconds), hm(r.breakBudgetSeconds), r.breakSeconds !== null && r.breakSeconds > r.breakBudgetSeconds ? hm(r.breakSeconds - r.breakBudgetSeconds) : "", hm(r.productiveSeconds), hm(r.productiveTargetSeconds)]
          : [r.name, r.employeeCode, shift.date, STATE_TEXT[r.dayState] ?? "—", "", "", "", "", "", "", "", "", "", "", "", ""]
      )
    );
  }

  return (
    <section className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Shift breakdown</h2>
          <p className="mt-0.5 text-sm text-slate-500">How each person spent the day. Pick any past day.</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={date}
            max={maxDate || undefined}
            onChange={(e) => {
              if (!e.target.value) return;
              setLoading(true);
              setDate(e.target.value);
            }}
            className="rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-700"
            aria-label="Day"
          />
          <button onClick={exportCsv} disabled={!shift || shift.rows.length === 0} className="rounded-xl border border-indigo-100 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 flex items-center justify-between rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>Couldn&apos;t load the shift breakdown: {error}</span>
          <button onClick={() => void load(date)} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium hover:bg-red-100">Retry</button>
        </div>
      )}

      <div className="mt-4 overflow-x-auto">
        {loading && !shift ? (
          <div className="space-y-2 p-6" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10" />)}</div>
        ) : shift && shift.rows.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-slate-500">No one reports to you yet.</p>
        ) : shift ? (
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className={th}>Employee</th>
                <th className={th}>Login</th>
                <th className={th}>Logout</th>
                <th className={`${th} text-right`}>Shift</th>
                <th className={`${th} text-right`}>Tea</th>
                <th className={`${th} text-right`}>Lunch</th>
                <th className={`${th} text-right`} title="Washroom time. Not a break: it is not in the break total and does not use the allowance.">Washroom</th>
                <th className={`${th} text-right`}>Huddle</th>
                <th className={`${th} text-right`}>Other</th>
                <th className={`${th} text-right`}>Break total</th>
                <th className={`${th} text-right`}>Productive</th>
              </tr>
            </thead>
            <tbody className={loading ? "opacity-60" : ""}>
              {shift.rows.map((r) => {
                const reached = r.productiveSeconds !== null && r.productiveSeconds >= r.productiveTargetSeconds;
                return (
                  <tr key={r.userId} className="border-t border-indigo-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{r.name}</p>
                      <p className="text-xs text-slate-400">{r.employeeCode ?? "—"}</p>
                    </td>
                    {r.hasSession ? (
                      <>
                        <td className="px-4 py-3 tabular-nums text-slate-900">{clockTime(r.loginAt, tz)}</td>
                        <td className="px-4 py-3 tabular-nums text-slate-900">{r.working ? <span className="text-emerald-600">Working</span> : clockTime(r.logoutAt, tz)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-900">{hm(r.shiftSeconds)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{hm(r.teaSeconds)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{hm(r.lunchSeconds)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{hm(r.bioSeconds)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{hm(r.huddleSeconds)}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-600">{hm(r.otherSeconds)}</td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {r.breakSeconds !== null && r.breakSeconds > r.breakBudgetSeconds ? (
                            <span className="font-medium text-red-600">{hm(r.breakSeconds)}<span className="block text-[11px]">over by {hm(r.breakSeconds - r.breakBudgetSeconds)}</span></span>
                          ) : (
                            <span className="text-slate-900">{hm(r.breakSeconds)}<span className="block text-[11px] text-slate-400">of {hm(r.breakBudgetSeconds)}</span></span>
                          )}
                        </td>
                        <td className={`px-4 py-3 text-right tabular-nums font-semibold ${reached ? "text-emerald-600" : "text-amber-600"}`}>
                          {hm(r.productiveSeconds)} <span className="font-normal text-slate-400">/ {hm(r.productiveTargetSeconds)}</span>
                        </td>
                      </>
                    ) : (
                      <td colSpan={10} className="px-4 py-3 text-slate-400">{STATE_TEXT[r.dayState] ?? "—"}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
      <p className="px-6 pb-5 pt-3 text-xs text-slate-400">
        Times are in the company timezone ({tz}). &ldquo;Other&rdquo; includes personal and other approved breaks. A dash means nothing was recorded, not zero.
      </p>
    </section>
  );
}
