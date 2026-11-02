"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import Link from "next/link";
import { clock, clockTime } from "../reports/_team/format";

// ATTENDANCE (live): the ONE screen for who is working right now. It replaces the two earlier screens "Your team
// today" and "Team Attendance", and keeps everything from both: the live board, the alerts panel and meeting invites.
// History, shift breakdowns and productivity live under Reports & Analytics.
//
// Data: GET /team-attendance/live (the board), GET /tracker/alerts, POST /tracker/meetings/invite. Nothing is guessed
// here: a dash means "no session today", a clock-out time is the real recorded one. The seconds tick in the browser
// between refreshes, using the server's own timestamp so the clocks agree.

type LiveStatus = "WORKING" | "TEA" | "LUNCH" | "BIO" | "OTHER_BREAK" | "MEETING" | "CLOCKED_OUT" | "NOT_CLOCKED_IN" | "ON_LEAVE";

type LiveRow = {
  userId: string; name: string; employeeCode: string | null; designation: string | null; teamName: string | null;
  company?: string | null; shiftName?: string | null; shiftStart?: string | null; shiftEnd?: string | null;
  status: LiveStatus; statusStartedAt: string | null; loginAt: string | null; logoutAt?: string | null; pendingInvite?: boolean;
  wasLateLogin: boolean; lateByMinutes: number; lateRemark?: string | null;
  shiftSeconds: number | null; productiveSeconds: number | null; breakSeconds: number | null; meetingSeconds: number | null;
  productiveTargetSeconds: number; breakBudgetSeconds: number;
};
type Live = {
  generatedAt: string; timezone: string; date: string;
  summary: { online: number; clockedOut: number; notClockedIn: number; onLeave: number; present: number; total: number };
  rows: LiveRow[];
};
type Alert = { id: string; userId: string; name: string; alertType: string; severity: "INFO" | "WARNING" | "CRITICAL"; message: string };

const SEVERITY: Record<Alert["severity"], string> = {
  CRITICAL: "border-red-200 bg-red-50 text-red-800",
  WARNING: "border-amber-200 bg-amber-50 text-amber-800",
  INFO: "border-sky-200 bg-sky-50 text-sky-800",
};

const STATUS: Record<LiveStatus, { label: string; dot: string; row: string }> = {
  WORKING: { label: "Working", dot: "bg-emerald-500", row: "bg-emerald-50/60" },
  TEA: { label: "Tea break", dot: "bg-amber-500", row: "bg-amber-50" },
  LUNCH: { label: "Lunch break", dot: "bg-amber-500", row: "bg-amber-50" },
  BIO: { label: "Bio break", dot: "bg-amber-500", row: "bg-amber-50" },
  OTHER_BREAK: { label: "Other break", dot: "bg-amber-500", row: "bg-amber-50" },
  MEETING: { label: "In meeting", dot: "bg-indigo-500", row: "bg-indigo-50/70" },
  CLOCKED_OUT: { label: "Clocked out", dot: "bg-slate-400", row: "" },
  NOT_CLOCKED_IN: { label: "Not clocked in", dot: "bg-red-500", row: "bg-red-50/60" },
  ON_LEAVE: { label: "On leave", dot: "bg-sky-500", row: "" },
};

const MEETING_TYPES = [
  { value: "TEAM", label: "Team meeting" },
  { value: "ONE_ON_ONE", label: "One on one" },
  { value: "CLIENT", label: "Client call" },
  { value: "TRAINING", label: "Training" },
  { value: "INTERVIEW", label: "Interview" },
  { value: "OTHER", label: "Other" },
];

const IS_BREAK = (s: LiveStatus) => s === "TEA" || s === "LUNCH" || s === "BIO" || s === "OTHER_BREAK";
// A live meeting attaches to a running work session, so only people who are clocked in (working or on a break) can be invited.
const INVITABLE = (r: LiveRow) => (r.status === "WORKING" || IS_BREAK(r.status)) && !r.pendingInvite;

const card = "rounded-2xl bg-white shadow-[var(--shadow-card)]";
const th = "px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500";

export default function AttendancePage() {
  const [live, setLive] = useState<Live | null>(null);
  const [liveError, setLiveError] = useState("");
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [selected, setSelected] = useState<string[]>([]);
  const [meetingType, setMeetingType] = useState("TEAM");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");

  const loadLive = useCallback(async () => {
    try {
      const [data, alertList] = await Promise.all([apiGet<Live>("/team-attendance/live"), apiGet<Alert[]>("/tracker/alerts").catch(() => [] as Alert[])]);
      setLive(data);
      setAlerts(Array.isArray(alertList) ? alertList : []);
      setFetchedAt(Date.now());
      setLiveError("");
    } catch (e) {
      setLiveError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(loadLive, 0);
    const poll = setInterval(loadLive, 15000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
    };
  }, [loadLive]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // Seconds that passed since the server computed the numbers: added to whatever is still running.
  const drift = Math.max(0, (now - fetchedAt) / 1000);
  const tz = live?.timezone ?? "Asia/Kolkata";
  const rows = useMemo(() => live?.rows ?? [], [live]);

  // Grouped by team (company shown when the list spans several). People without a team go last.
  const groups = useMemo(() => {
    const multi = new Set(rows.map((r) => r.company ?? "")).size > 1;
    const map = new Map<string, LiveRow[]>();
    for (const r of rows) {
      const key = `${multi && r.company ? `${r.company} · ` : ""}${r.teamName?.trim() || "No team"}`;
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return Array.from(map.entries()).sort(([a], [b]) => (a.endsWith("No team") ? 1 : b.endsWith("No team") ? -1 : a.localeCompare(b)));
  }, [rows]);

  const counts = useMemo(() => {
    const c = { working: 0, onBreak: 0, meeting: 0, notIn: 0, leave: 0, out: 0 };
    for (const r of rows) {
      if (r.status === "WORKING") c.working++;
      else if (IS_BREAK(r.status)) c.onBreak++;
      else if (r.status === "MEETING") c.meeting++;
      else if (r.status === "NOT_CLOCKED_IN") c.notIn++;
      else if (r.status === "ON_LEAVE") c.leave++;
      else if (r.status === "CLOCKED_OUT") c.out++;
    }
    return c;
  }, [rows]);

  // People who stop being invitable (clocked out, an invite arrived) drop out of the selection after a refresh.
  const invitable = selected.filter((id) => {
    const r = rows.find((x) => x.userId === id);
    return r && INVITABLE(r);
  });
  const nobodyCanBeInvited = !rows.some(INVITABLE);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const selectGroup = (list: LiveRow[]) => setSelected((s) => Array.from(new Set([...s, ...list.filter(INVITABLE).map((r) => r.userId)])));

  async function ack(id: string) {
    try {
      setAlerts(await apiPost<Alert[]>(`/tracker/alerts/${id}/ack`));
    } catch (e) {
      setActionError((e as Error).message || "Could not clear that");
    }
  }

  async function sendInvite() {
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const res = await apiPost<{ invited: string[]; skipped: { userId: string; reason: string }[] }>("/tracker/meetings/invite", {
        employeeIds: invitable,
        meetingType,
        title: title.trim() || undefined,
      });
      const parts = [`Invited ${res.invited.length}`];
      if (res.skipped.length) {
        const names = res.skipped.map((s) => `${rows.find((r) => r.userId === s.userId)?.name ?? "Someone"} (${s.reason.toLowerCase()})`).join(", ");
        parts.push(`skipped ${names}`);
      }
      setNotice(parts.join(" - "));
      setSelected([]);
      setTitle("");
      await loadLive();
    } catch (e) {
      setActionError((e as Error).message || "Could not send the invite");
    } finally {
      setBusy(false);
    }
  }

  const tiles: [string, number, string][] = [
    ["Working", counts.working, "bg-emerald-500"],
    ["On break", counts.onBreak, "bg-amber-500"],
    ["In a meeting", counts.meeting, "bg-indigo-500"],
    ["Clocked out", counts.out, "bg-slate-400"],
    ["Not clocked in", counts.notIn, "bg-red-500"],
    ["On leave", counts.leave, "bg-sky-500"],
  ];

  return (
    <div className="mx-auto page-7xl space-y-5 p-4 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Attendance</h1>
          <p className="mt-1 text-sm text-slate-500">
            Who is working right now, grouped by team. For past days, shift breakdowns and productivity, open{" "}
            <Link href="/dashboard/reports" className="font-medium text-indigo-600 hover:underline">Reports &amp; Analytics</Link>.
          </p>
        </div>
        <p className="text-xs text-slate-400">Refreshes every 15 s{live ? ` · last updated ${clockTime(live.generatedAt, tz)}` : ""}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([label, n, dot]) => (
          <div key={label} className={`${card} px-4 py-3`}>
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
              <p className="text-xs text-slate-500">{label}</p>
            </div>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{live ? n : "—"}</p>
          </div>
        ))}
      </div>

      {liveError && (
        <div className="flex items-center justify-between rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>Couldn&apos;t load the live board: {liveError}</span>
          <button onClick={() => void loadLive()} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium hover:bg-red-100">Retry</button>
        </div>
      )}
      {actionError && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{actionError}</p>}
      {notice && <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">{notice}</p>}

      {alerts.length > 0 && (
        <section className={`${card} overflow-hidden`}>
          <div className="flex items-center justify-between border-b border-indigo-50 px-5 py-3">
            <h2 className="text-sm font-medium text-slate-900">Needs attention</h2>
            <span className="text-xs text-slate-400">{alerts.length} today</span>
          </div>
          <ul className="divide-y divide-indigo-50">
            {alerts.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${SEVERITY[a.severity]}`}>{a.alertType.replace(/_/g, " ").toLowerCase()}</span>
                  <p className="truncate text-sm text-slate-700"><span className="font-medium text-slate-900">{a.name}</span>{" - "}{a.message}</p>
                </div>
                <button onClick={() => ack(a.id)} className="shrink-0 text-xs text-slate-400 hover:text-slate-900">Clear</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {selected.length === 0 && live && nobodyCanBeInvited && rows.length > 0 && (
        <p className="rounded-xl bg-[#F6F7FE] px-4 py-3 text-sm text-slate-600">
          Nobody is clocked in right now. You can invite people to a live meeting once they clock in; to meet someone who isn&apos;t clocked in,{" "}
          <Link href="/dashboard/meetings" className="font-medium text-indigo-700 underline underline-offset-2">schedule a meeting</Link>.
        </p>
      )}

      {selected.length > 0 && (
        <div className="sticky top-4 z-10 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
          <p className="mb-3 text-sm font-medium text-indigo-900">
            {selected.length} selected
            {invitable.length !== selected.length && <span className="font-normal text-indigo-600"> - only {invitable.length} are clocked in and can be invited</span>}
          </p>
          {invitable.length === 0 && (
            <p className="mb-3 text-sm text-indigo-800">
              A live meeting counts towards someone&apos;s running work session, so only people who are clocked in can be invited. To meet someone who
              hasn&apos;t clocked in, <Link href="/dashboard/meetings" className="font-medium underline underline-offset-2">schedule a meeting</Link> instead.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <select value={meetingType} onChange={(e) => setMeetingType(e.target.value)} className="rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900">
              {MEETING_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's it about? (optional)" className="min-w-48 flex-1 rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400" />
            <button disabled={busy || invitable.length === 0} onClick={sendInvite} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy ? "Sending..." : "Send invite"}
            </button>
            <button onClick={() => setSelected([])} className="px-2 text-sm text-indigo-700 hover:underline">Clear</button>
          </div>
        </div>
      )}

      <section className={card}>
        <div className="overflow-x-auto">
          {!live && !liveError ? (
            <div className="space-y-2 p-6" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10" />)}</div>
          ) : live && rows.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-slate-500">No one reports to you yet. People appear here once they are in a team you run or report to you.</p>
          ) : live ? (
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="w-10 px-4 py-2.5" />
                  <th className={th}>Employee</th>
                  <th className={th}>Shift</th>
                  <th className={th}>Current activity</th>
                  <th className={`${th} text-right`}>Clock in</th>
                  <th className={`${th} text-right`}>Clock out</th>
                  <th className={`${th} text-right`}>Break used</th>
                  <th className={`${th} text-right`}>Meetings</th>
                  <th className={`${th} text-right`}>Working</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(([group, members]) => (
                  <Fragment key={group}>
                    <tr className="border-t border-indigo-100 bg-[#F6F7FE]">
                      <td colSpan={9} className="px-4 py-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-indigo-700">{group}</span>
                        <span className="ml-2 text-xs text-slate-400">{members.length} {members.length === 1 ? "person" : "people"}</span>
                        {members.some(INVITABLE) && (
                          <button onClick={() => selectGroup(members)} className="ml-3 text-xs font-medium text-indigo-600 hover:underline">Select everyone clocked in</button>
                        )}
                      </td>
                    </tr>
                    {members.map((r) => {
                      const st = STATUS[r.status];
                      const running = r.status === "WORKING" || r.status === "MEETING" || IS_BREAK(r.status);
                      const inStatus = r.statusStartedAt && r.status !== "ON_LEAVE" ? (now - new Date(r.statusStartedAt).getTime()) / 1000 : null;
                      const breakSec = r.breakSeconds === null ? null : r.breakSeconds + (IS_BREAK(r.status) ? drift : 0);
                      const meetSec = r.meetingSeconds === null ? null : r.meetingSeconds + (r.status === "MEETING" ? drift : 0);
                      const prodSec = r.productiveSeconds === null ? null : r.productiveSeconds + (r.status === "WORKING" || r.status === "MEETING" ? drift : 0);
                      const overBudget = breakSec !== null && breakSec > r.breakBudgetSeconds;
                      const canPick = INVITABLE(r);
                      return (
                        <tr key={r.userId} className={`border-t border-indigo-50 ${st.row}`}>
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              checked={selected.includes(r.userId)}
                              onChange={() => toggle(r.userId)}
                              disabled={!canPick}
                              title={canPick ? "Select to invite to a live meeting" : r.pendingInvite ? "Already has a pending invite" : "Not clocked in, so they can't be invited to a live meeting"}
                              aria-label={`Select ${r.name}`}
                              className="rounded border-indigo-200 disabled:cursor-not-allowed disabled:opacity-40"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-medium text-slate-900">{r.name}</p>
                            <p className="text-xs text-slate-400">
                              {r.employeeCode ?? "—"}{r.designation ? ` · ${r.designation}` : ""}
                              {r.wasLateLogin && <span className="ml-2 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600">late {r.lateByMinutes}m</span>}
                            </p>
                            {r.wasLateLogin && r.lateRemark && <p className="mt-0.5 max-w-xs text-xs text-amber-700" title={r.lateRemark}>Late remark: {r.lateRemark}</p>}
                          </td>
                          <td className="px-4 py-3 text-slate-600">
                            {r.shiftName ? (
                              <>
                                <p>{r.shiftName}</p>
                                {r.shiftStart && r.shiftEnd && <p className="text-xs text-slate-400">{r.shiftStart}–{r.shiftEnd}</p>}
                              </>
                            ) : <span className="text-slate-400">Not assigned</span>}
                          </td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-100 bg-white px-2.5 py-1 text-xs font-medium text-slate-700">
                              <span className={`h-2 w-2 rounded-full ${st.dot}`} />{st.label}
                            </span>
                            {inStatus !== null && r.status !== "NOT_CLOCKED_IN" && <span className="ml-2 text-xs tabular-nums text-slate-400" title="Time in this status">{clock(inStatus)}</span>}
                            {r.pendingInvite && <span className="ml-2 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700">invite pending</span>}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-slate-900">{clockTime(r.loginAt, tz)}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-slate-900">
                            {r.status === "CLOCKED_OUT" ? clockTime(r.logoutAt ?? null, tz) : running ? <span className="text-xs text-emerald-600">Working</span> : "—"}
                          </td>
                          <td className={`px-4 py-3 text-right tabular-nums ${overBudget ? "text-red-600" : "text-slate-900"}`}>
                            {breakSec === null ? (
                              <span className="text-slate-400" title="No session today">—</span>
                            ) : breakSec === 0 && !IS_BREAK(r.status) ? (
                              <span className="text-slate-500" title="No break taken yet">None yet</span>
                            ) : (
                              <>
                                {clock(breakSec)}<span className="ml-1 text-xs text-slate-400">/ {clock(r.breakBudgetSeconds)}</span>
                                <p className={`text-[11px] ${overBudget ? "font-medium text-red-600" : "text-slate-400"}`}>
                                  {IS_BREAK(r.status) ? "on break now · " : ""}{overBudget ? `exceeded by ${clock(breakSec - r.breakBudgetSeconds)}` : `${clock(r.breakBudgetSeconds - breakSec)} left`}
                                </p>
                              </>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-slate-900" title="Live meetings plus the time the person actually spent in a Team Huddle (from joining to leaving), counted only while clocked in and outside breaks. 0:00:00 means nothing was recorded.">{clock(meetSec)}</td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">{clock(prodSec)}</td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
        <div className="h-4" />
      </section>
    </div>
  );
}
