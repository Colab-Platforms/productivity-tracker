// ===========================================================================
// TODAY / MY TIMESHEETS
//
// The employee's own workday: a compact Clock-in card, a Planned Hours card, a
// Worked Hours card, and a colour-coded timeline of every day in the chosen
// range.
//
// Where the numbers come from (nothing is mocked or recalculated here):
//   /tracker/session     today's live session: drives the timer and the buttons
//   /tracker/timesheet   the schedule + real clock-in/out, break and meeting
//                        intervals per day, and the planned hours/days, which
//                        come from the same function the Reports page uses
//   /tracker/invites     meeting invites (accept / decline)
//
// BUILT FOR A MINIMISED TAB
// People work with this hidden, so: the tab title carries the live state, a
// meeting invite raises a desktop notification, and the page re-syncs the
// moment it regains focus. Background tabs have their timers throttled, so
// nothing here counts upwards: every figure is the server's number plus the
// seconds since it was fetched, and is correct whenever it next renders.
// ===========================================================================

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useMe } from "./layout";
import Avatar from "./_photos/Avatar";
import DayRow from "./_timesheet/DayRow";
import StandupCard from "./_standup/StandupCard";
import Breakdown from "./_timesheet/Breakdown";
import HuddleOverview from "./_standup/HuddleOverview";
import { LateRemarkModal } from "./_timesheet/LateRemarkModal";
import { EntryLogModal, ScheduleModal } from "./_timesheet/Modals";
import RequestCorrectionModal from "./_corrections/RequestModal";
import { SEG_COLOR, buildDayModel } from "./_timesheet/model";
import {
  PRESETS,
  type Preset,
  fmtClock,
  fmtDateTime,
  fmtDur,
  hms,
  hrsMins,
  longDay,
  presetRange,
  shortDay,
  spanDays,
} from "./_timesheet/time";
import type { Timesheet, TsSession } from "./_timesheet/types";

type Break = {
  id: string;
  breakType: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  autoClosed?: boolean;
  reason?: string | null;
};

type Meeting = {
  id: string;
  meetingType: string;
  title: string | null;
  approvalStatus: string;
  startedAt: string | null;
  endedAt: string | null;
  invitedBy?: { firstName: string; lastName: string; role: string } | null;
};

type Session = {
  id: string;
  status: "ACTIVE" | "COMPLETED";
  loginAt: string;
  logoutAt: string | null;
  productiveSeconds: number;
  breakSeconds: number;
  meetingSeconds: number;
  wasLateLogin: boolean;
  lateByMinutes: number;
  autoClosed?: boolean;
  shiftStartTime?: string | null;
  breaks: Break[];
  meetings: Meeting[];
};

type Config = {
  dailyWorkHours: number;
  productiveHours: number;
  breakBudgetMinutes: number;
};

// The four break types the backend accepts.
const BREAK_TYPES = [
  { value: "TEA", label: "Tea" },
  { value: "WASHROOM", label: "Washroom" },
  { value: "LUNCH", label: "Lunch" },
  { value: "PERSONAL", label: "Personal" },
];

const MEETING_LABELS: Record<string, string> = {
  TEAM: "team meeting",
  ONE_ON_ONE: "one-on-one",
  CLIENT: "client call",
  TRAINING: "training session",
  INTERVIEW: "interview",
  OTHER: "meeting",
};

// One small loader per endpoint. It keeps the last good data while a new range
// is loading, so changing the filter dims the page instead of blanking it.
function useApi<T>(path: string | null, reload: number) {
  const [res, setRes] = useState<{ path: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    apiGet<T>(path)
      .then((data) => live && setRes({ path, data }))
      .catch((e: Error) => live && setRes((prev) => ({ path, data: prev?.data, error: e.message })));
    return () => {
      live = false;
    };
  }, [path, reload]);
  return {
    data: res?.data ?? null,
    error: res && res.path === path ? (res.error ?? "") : "",
    loading: path !== null && res?.path !== path,
  };
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");

const Ico = {
  timer: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="11" r="6" />
      <path d="M10 8v3.2l1.8 1.2M8 2.5h4" strokeLinecap="round" />
    </svg>
  ),
  planned: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="6.5" />
      <circle cx="10" cy="10" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  worked: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 3.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" stroke="none" />
    </svg>
  ),
  sheet: (
    <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 6.5V10l2.3 1.4" strokeLinecap="round" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor">
      <rect x="5" y="4" width="3.6" height="12" rx="1" />
      <rect x="11.4" y="4" width="3.6" height="12" rx="1" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor">
      <rect x="5" y="5" width="10" height="10" rx="2" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor">
      <path d="M6 4.5v11l9-5.5z" />
    </svg>
  ),
  external: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v4.5M10 6.6h.01" strokeLinecap="round" />
    </svg>
  ),
  list: (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M10 4v12M4 10h12" strokeLinecap="round" />
    </svg>
  ),
  cal: (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="4.5" width="14" height="12" rx="2" />
      <path d="M3 8.5h14M7 3v3M13 3v3" strokeLinecap="round" />
    </svg>
  ),
};

const CARD = "rounded-2xl border border-slate-200 bg-white p-5";

// How much of the daily break allowance is left (or by how much it has been exceeded). Everyone sees their own.
function BreakBudget({ used, budget, onBreak }: { used: number; budget: number; onBreak: boolean }) {
  const over = used - budget;
  const pct = Math.min(100, Math.round((used / Math.max(1, budget)) * 100));
  return (
    <div className="mt-3 w-full max-w-[16rem]" aria-live="polite">
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={"h-full rounded-full " + (over > 0 ? "bg-red-500" : pct >= 85 ? "bg-amber-400" : "bg-sky-400")} style={{ width: pct + "%" }} />
      </div>
      {over > 0 ? (
        <p className="mt-1.5 text-xs font-medium text-red-600">Break exceeded by {fmtDur(over)} · used {fmtDur(used)} of {fmtDur(budget)}</p>
      ) : (
        <p className="mt-1.5 text-xs text-slate-500">
          <span className="font-medium text-slate-700">{fmtDur(budget - used)} of break left</span> · used {fmtDur(used)} of {fmtDur(budget)}
          {onBreak && <span className="ml-1 text-sky-600">· on break now</span>}
        </p>
      )}
    </div>
  );
}

export default function TodayView() {
  const me = useMe();

  // ---- the live session (unchanged behaviour) -------------------------------------
  const [session, setSession] = useState<Session | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  // True while a meeting this person called is still running, so the End
  // button appears and disappears on its own, on every device.
  const [hostsMeeting, setHostsMeeting] = useState(false);
  const [invites, setInvites] = useState<Meeting[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [canNotify, setCanNotify] = useState(false);
  const fetchedAt = useRef<number>(Date.now());
  const notified = useRef<Set<string>>(new Set());
  const [, forceTick] = useState(0);
  // false until the first answer arrives, so the page shows skeletons instead
  // of a misleading "Not clocked in" while it is still loading.
  const [loaded, setLoaded] = useState(false);
  const [breakOpen, setBreakOpen] = useState(false);
  const breakRef = useRef<HTMLDivElement>(null);

  // ---- the timesheet (range, schedule, history) -----------------------------------------
  const [reloadTs, setReloadTs] = useState(0);
  // Always opens on Today (a refresh or coming back resets it); "today" is the company-timezone day the server reports.
  const [preset, setPreset] = useState<Preset>("TODAY");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [openLog, setOpenLog] = useState<"all" | string | null>(null);
  const [openSchedule, setOpenSchedule] = useState(false);
  const [correctFor, setCorrectFor] = useState<string | null>(null);
  const [correctionSent, setCorrectionSent] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState("");

  const load = useCallback(async () => {
    try {
      // Session and invites are independent, so they are fetched together.
      const [sessionRes, invitesRes] = await Promise.allSettled([
        apiGet<{ session: Session | null; config: Config; hostsOpenMeeting?: boolean; projects?: { id: string; name: string }[] }>("/tracker/session"),
        apiGet<Meeting[]>("/tracker/invites"),
      ]);
      if (sessionRes.status === "rejected") throw sessionRes.reason;

      const res = sessionRes.value;
      setSession(res.session);
      setConfig(res.config);
      setHostsMeeting(Boolean(res.hostsOpenMeeting));
      setProjects(res.projects ?? []);
      fetchedAt.current = Date.now();
      setError("");

      if (invitesRes.status === "rejected") throw invitesRes.reason;
      setInvites(invitesRes.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your day");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(load, 20000);
    const tick = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  // A hidden tab has its timers throttled, so the poll above may not have run
  // for a minute. Re-sync the instant someone comes back to the window.
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
    };
  }, [load]);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setCanNotify(Notification.permission === "granted");
    }
  }, []);

  async function askToNotify() {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setCanNotify(result === "granted");
  }

  useEffect(() => {
    if (!canNotify) return;
    for (const invite of invites) {
      if (notified.current.has(invite.id)) continue;
      notified.current.add(invite.id);
      const from = invite.invitedBy ? `${invite.invitedBy.firstName} ${invite.invitedBy.lastName}` : "Your manager";
      new Notification("Meeting invite", {
        body: `${from} invited you to a ${MEETING_LABELS[invite.meetingType] ?? "meeting"}. Your clock starts when you accept.`,
        tag: invite.id,
      });
    }
  }, [invites, canNotify]);

  useEffect(() => {
    if (!breakOpen) return;
    const away = (e: MouseEvent) => {
      if (breakRef.current && !breakRef.current.contains(e.target as Node)) setBreakOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [breakOpen]);

  const [lateAsk, setLateAsk] = useState<{ minutes: number; error: string } | null>(null);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      await apiPost(path, body);
      await load();
      setReloadTs((n) => n + 1); // the timeline now has a new interval
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  const openBreak = session?.breaks.find((b) => !b.endedAt) ?? null;
  const openMeeting = session?.meetings.find((m) => m.approvalStatus === "APPROVED" && m.startedAt && !m.endedAt) ?? null;
  const running = session?.status === "ACTIVE";
  const now = Date.now();
  const sinceFetch = running ? (now - fetchedAt.current) / 1000 : 0;

  // The server's numbers plus the seconds since they were fetched. A meeting is
  // working time, so only a break pauses the productive clock.
  const productive = (session?.productiveSeconds ?? 0) + (running && !openBreak ? sinceFetch : 0);
  const breakSecs = (session?.breakSeconds ?? 0) + (openBreak ? sinceFetch : 0);
  const meetingSecs = (session?.meetingSeconds ?? 0) + (openMeeting ? sinceFetch : 0);
  const elapsed = productive + breakSecs; // everything on site, breaks included once

  // The tab strip is the display when this window is minimised.
  useEffect(() => {
    if (!running) {
      document.title = "Avatar HRMS";
      return;
    }
    document.title = openBreak
      ? `☕ ${hms(breakSecs).slice(0, 2).join(":")} break · Avatar HRMS`
      : openMeeting
        ? `👥 ${hms(meetingSecs).slice(0, 2).join(":")} meeting · Avatar HRMS`
        : `⏱ ${hms(productive).slice(0, 2).join(":")} · Avatar HRMS`;
  });

  // ---- the range ---------------------------------------------------------------------------
  // The first load (the server's default window, the last 7 days ending today) tells us what "today"
  // is in the company's timezone, which every range, including the default Today, is built from.
  const base = useApi<Timesheet>("/tracker/timesheet", reloadTs);
  const todayStr = base.data?.today ?? null;
  const range = todayStr ? presetRange(preset, todayStr, custom) : null;
  const rangeError =
    preset === "CUSTOM" && range
      ? !range.from || !range.to
        ? "Pick both dates."
        : range.to < range.from
          ? "The end date can't be before the start date."
          : spanDays(range.from, range.to) > 93
            ? "Pick a range of 93 days or fewer."
            : ""
      : "";
  const otherPath = preset !== "LAST_7" && range && !rangeError ? `/tracker/timesheet?from=${range.from}&to=${range.to}` : null;
  const other = useApi<Timesheet>(otherPath, reloadTs);
  const ts = preset === "LAST_7" ? base : other;

  if (!me) return null;

  // ---- what this person may do right now ------------------------------------------------------
  // Buttons follow the same session state the backend enforces and every handler
  // re-checks it, so a double click or a stale screen cannot start a second
  // session or an invalid transition. The backend still has the final say.
  const isManager = ["MANAGER", "HR", "ADMIN"].includes(String(me.role));
  const canBreak = running && !openBreak && !openMeeting;
  const canClockOut = running && !openBreak && !openMeeting;
  const whyNoBreak = !session
    ? "Clock in to take a break"
    : !running
      ? "Your day is closed"
      : openMeeting
        ? "End your meeting before taking a break"
        : openBreak
          ? "Finish your current break first"
          : "";

  // After the late cut-off the server refuses with LATE_REMARK_REQUIRED and nothing is started; the person types a
  // reason and the same clock-in is sent again with it.
  async function clockIn(remark?: string) {
    if (busy || running) return;
    void askToNotify();
    setBusy(true);
    setError("");
    try {
      await apiPost("/tracker/clock-in", { ...(projectId ? { teamId: projectId } : {}), ...(remark ? { lateRemark: remark } : {}) });
      setLateAsk(null);
      await load();
      setReloadTs((n) => n + 1);
    } catch (err) {
      const e = err as Error & { code?: string; data?: { lateByMinutes?: number } };
      if (e.code === "LATE_REMARK_REQUIRED" && !remark) setLateAsk({ minutes: e.data?.lateByMinutes ?? 0, error: "" });
      else if (remark) setLateAsk((cur) => (cur ? { ...cur, error: e.message } : cur));
      else setError(e.message || "That didn't work");
    } finally {
      setBusy(false);
    }
  }
  function clockOut() {
    if (busy || !canClockOut) return;
    void act("/tracker/clock-out");
  }
  function startBreak(type: string) {
    if (busy || !canBreak) return;
    setBreakOpen(false);
    void act("/tracker/break/start", { breakType: type });
  }
  function resume() {
    if (busy || !openBreak) return;
    void act("/tracker/break/end");
  }

  const breakName = BREAK_TYPES.find((b) => b.value === openBreak?.breakType)?.label.toUpperCase();
  const state = !session
    ? { label: "NOT CLOCKED IN", dot: "bg-slate-300", tone: "text-slate-400" }
    : session.status === "COMPLETED"
      ? { label: "COMPLETED", dot: "bg-slate-400", tone: "text-slate-400" }
      : openBreak
        ? { label: breakName ? `ON ${breakName} BREAK` : "ON A BREAK", dot: "bg-sky-400", tone: "text-sky-500" }
        : openMeeting
          ? { label: "IN A MEETING", dot: "bg-violet-400", tone: "text-violet-500" }
          : { label: "ONGOING", dot: "bg-emerald-400", tone: "text-emerald-500" };

  // ---- the timesheet, with today's row taken from the LIVE session -----------------------------
  const tsData = ts.data;
  const tz = tsData?.timezone ?? "Asia/Kolkata";
  const today = tsData?.today ?? "";
  // Corrections can be requested for the last 30 days (the server enforces it too).
  const correctionFloor = today ? new Date(new Date(today + "T00:00:00Z").getTime() - 30 * 86_400_000).toISOString().slice(0, 10) : "";
  const liveAsTs: TsSession | null = session
    ? {
        id: session.id,
        status: session.status,
        loginAt: session.loginAt,
        logoutAt: session.logoutAt,
        autoClosed: Boolean(session.autoClosed),
        productiveSeconds: session.productiveSeconds,
        breakSeconds: session.breakSeconds,
        meetingSeconds: session.meetingSeconds,
        wasLateLogin: session.wasLateLogin,
        lateByMinutes: session.lateByMinutes,
        shiftStartTime: session.shiftStartTime ?? null,
        breaks: session.breaks.map((b) => ({
          id: b.id,
          breakType: b.breakType,
          startedAt: b.startedAt,
          endedAt: b.endedAt,
          durationSeconds: b.durationSeconds,
          autoClosed: Boolean(b.autoClosed),
          reason: b.reason ?? null,
        })),
        meetings: session.meetings
          .filter((m) => m.approvalStatus === "APPROVED" && m.startedAt)
          .map((m) => ({ id: m.id, meetingType: m.meetingType, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt })),
      }
    : null;
  const days = (tsData?.days ?? []).map((d) => (d.date === today && liveAsTs ? { ...d, session: liveAsTs } : d));
  const models = tsData ? days.filter((d) => !d.isFuture).map((d) => buildDayModel(d, tz, tsData.schedule, now, today)) : [];

  // Period totals: stored values for past days, live values for today.
  const periodProductive = days.reduce((n, d) => n + (d.date === today && session ? productive : (d.session?.productiveSeconds ?? 0)), 0);
  const periodBreak = days.reduce((n, d) => n + (d.date === today && session ? breakSecs : (d.session?.breakSeconds ?? 0)), 0);
  const periodElapsed = periodProductive + periodBreak;
  const planned = tsData ? hrsMins(tsData.totals.plannedSeconds) : { h: 0, m: 0 };
  const worked = hrsMins(periodElapsed);

  const shownRange = tsData?.range;
  const rangeLabel = !shownRange
    ? "…"
    : shownRange.from === shownRange.to
      ? longDay(shownRange.from)
      : `${shortDay(shownRange.from)} - ${longDay(shownRange.to)}`;
  const periodName =
    preset === "TODAY" ? "Today" : preset === "YESTERDAY" ? "Yesterday" : preset === "LAST_7" ? "Last 7 days" : preset === "LAST_30" ? "Last 30 days" : preset === "THIS_MONTH" ? "This month" : "Selected range";
  const weekly = tsData?.schedule.shift ? tsData.schedule.shift.workingDays.length * tsData.schedule.productiveHours : null;

  const [eh, em, es] = hms(elapsed);
  const dim = ts.loading && ts.data ? "opacity-60 transition-opacity" : "transition-opacity";
  const roleLine = me.designation ?? `${String(me.role).charAt(0)}${String(me.role).slice(1).toLowerCase()}`;

  return (
    <div className="mx-auto page-6xl p-3 sm:p-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-4 sm:p-6">
        {/* ===================== header ===================== */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Avatar userId={me.id} name={`${me.firstName} ${me.lastName}`} photoAt={me.photoAt} size={48} fallbackClass="bg-violet-100 text-violet-700" />
            <div>
              <p className="text-[15px] text-slate-500">
                Welcome, <span className="font-semibold text-slate-900">{me.firstName} {me.lastName}</span> <span aria-hidden>👋</span>
              </p>
              <p className="text-xs text-slate-400">{roleLine} · {fmtDateTime(now, tz)}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="ts-preset">Date range</label>
            <select
              id="ts-preset"
              value={preset}
              onChange={(e) => {
                const p = e.target.value as Preset;
                setPreset(p);
                if (p === "CUSTOM" && ts.data) setCustom({ from: ts.data.range.from, to: ts.data.range.to });
              }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-violet-400"
            >
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setPreset("CUSTOM");
                if (ts.data) setCustom({ from: ts.data.range.from, to: ts.data.range.to });
              }}
              title="Pick your own dates"
              className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              <span className="text-slate-400">{Ico.cal}</span>
              {rangeLabel}
            </button>
          </div>
        </header>

        {/* An in-person stand-up you are invited to: the join button, the live "in a meeting" state, your record. */}
        <StandupCard />

        {preset === "CUSTOM" && (
          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-2xl bg-slate-50 px-4 py-3">
            {(["from", "to"] as const).map((k) => (
              <label key={k} className="text-xs text-slate-500">
                <span className="mb-1 block font-medium uppercase tracking-wide">{k === "from" ? "From" : "To"}</span>
                <input
                  type="date"
                  value={custom[k]}
                  max={today || undefined}
                  onChange={(e) => setCustom((c) => ({ ...c, [k]: e.target.value }))}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 outline-none focus:border-violet-400"
                />
              </label>
            ))}
            {rangeError && <p className="pb-2 text-xs text-red-600">{rangeError}</p>}
          </div>
        )}

        {/* ===================== meeting invites ===================== */}
        {invites.map((invite) => (
          <div key={invite.id} className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-violet-200 bg-violet-50 p-4">
            <div>
              <p className="text-sm font-medium text-violet-900">
                {invite.invitedBy ? `${invite.invitedBy.firstName} ${invite.invitedBy.lastName}` : "Your manager"} invited you to a {MEETING_LABELS[invite.meetingType] ?? "meeting"}
              </p>
              <p className="mt-0.5 text-xs text-violet-700">
                {invite.title ? `${invite.title} — ` : ""}your clock starts when you accept
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button disabled={busy} onClick={() => act(`/tracker/invites/${invite.id}/respond`, { accept: true })} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-violet-700 disabled:opacity-50">Accept</button>
              <button disabled={busy} onClick={() => act(`/tracker/invites/${invite.id}/respond`, { accept: false })} className="rounded-xl border border-violet-300 px-4 py-2 text-sm font-medium text-violet-700 transition hover:bg-violet-100 disabled:opacity-50">Decline</button>
            </div>
          </div>
        ))}

        {error && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <span>{error}</span>
            <button onClick={() => void load()} className="shrink-0 rounded-lg bg-white px-3 py-1 text-xs font-medium text-red-700 ring-1 ring-red-200 hover:bg-red-100">Retry</button>
          </div>
        )}

        {/* ===================== three summary cards ===================== */}
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {/* ---- Clock-in ---- */}
          <section className={CARD}>
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3.5 text-[15px] font-medium text-slate-900">
              <span className="text-slate-500">{Ico.timer}</span> Clock-in
            </div>
            {!loaded ? (
              <div className="space-y-3 py-6">
                <div className="skeleton mx-auto h-4 w-20" />
                <div className="skeleton mx-auto h-12 w-48" />
                <div className="skeleton mx-auto h-9 w-44" />
              </div>
            ) : (
              <div className="flex flex-col items-center pt-5 text-center">
                <p className={`flex items-center gap-1.5 text-[11px] font-medium tracking-[0.12em] ${state.tone}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${state.dot} ${running ? "animate-pulse" : ""}`} />
                  {state.label}
                </p>
                <p className="mt-2 text-[44px] font-semibold leading-none tracking-tight tabular-nums text-slate-900" aria-label="Time on site">
                  {eh}:{em}
                  <span className="text-slate-300">:{es}</span>
                </p>
                <p className="mt-2 text-xs text-slate-400">
                  {session ? (
                    <>
                      Clocked in at <span className="font-medium text-slate-600">{fmtClock(Date.parse(session.loginAt), tz)}</span>
                      {session.wasLateLogin && <span className="ml-1.5 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-600">late by {session.lateByMinutes}m</span>}
                      {session.logoutAt && <> · out at <span className="font-medium text-slate-600">{fmtClock(Date.parse(session.logoutAt), tz)}</span></>}
                    </>
                  ) : (
                    "Your day starts when you clock in"
                  )}
                </p>

                {session && config && <BreakBudget used={breakSecs} budget={config.breakBudgetMinutes * 60} onBreak={!!openBreak} />}

                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {!running && projects.length > 0 && (
                    <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700">
                      <option value="">No project</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  )}
                  {!running ? (
                    <button disabled={busy} onClick={() => void clockIn()} className="rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-50">
                      {session?.status === "COMPLETED" ? "Clock back in" : "Clock in"}
                    </button>
                  ) : (
                    <>
                      {openBreak ? (
                        <button disabled={busy} onClick={resume} className="flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3.5 py-2 text-[13px] font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50">
                          {Ico.play} Resume
                        </button>
                      ) : (
                        <div ref={breakRef} className="relative">
                          <button
                            disabled={busy || !canBreak}
                            onClick={() => setBreakOpen((v) => !v)}
                            title={whyNoBreak || "Start a break"}
                            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-[13px] font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {Ico.pause} Break
                          </button>
                          {breakOpen && (
                            <div className="absolute left-1/2 z-20 mt-2 w-44 -translate-x-1/2 overflow-hidden rounded-xl bg-white py-1.5 text-left shadow-lg ring-1 ring-slate-200">
                              <p className="px-4 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">What kind of break?</p>
                              {BREAK_TYPES.map((b) => (
                                <button key={b.value} onClick={() => startBreak(b.value)} className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-violet-50 hover:text-violet-700">
                                  {b.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      <button
                        disabled={busy || !canClockOut}
                        onClick={clockOut}
                        title={canClockOut ? "End your day" : "Resume work or end your meeting before clocking out"}
                        className="flex items-center gap-1.5 rounded-lg bg-red-500 px-3.5 py-2 text-[13px] font-medium text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {Ico.stop} Clock-out
                      </button>
                    </>
                  )}
                </div>

                {running && (hostsMeeting || openMeeting) && isManager && (
                  <button disabled={busy} onClick={() => act("/tracker/meeting/end")} className="mt-3 rounded-lg border border-violet-300 px-3.5 py-1.5 text-xs font-medium text-violet-700 transition hover:bg-violet-50 disabled:opacity-50" title="Ends the meeting for everyone you invited">
                    {openMeeting ? "End meeting" : "End team meeting"}
                  </button>
                )}
                {!canNotify && running && (
                  <button onClick={askToNotify} className="mt-3 text-xs text-slate-400 underline-offset-2 hover:text-violet-600 hover:underline">Alert me about meetings</button>
                )}
                {whyNoBreak && running && <p className="mt-3 text-[11px] text-slate-400">{whyNoBreak}</p>}
              </div>
            )}
          </section>

          {/* ---- Planned hours ---- */}
          <section className={`${CARD} ${dim}`}>
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <span className="flex items-center gap-2 text-[15px] font-medium text-slate-900">
                <span className="text-slate-500">{Ico.planned}</span> Planned hours
              </span>
              <button onClick={() => setOpenSchedule(true)} disabled={!tsData} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40">
                Details {Ico.external}
              </button>
            </div>
            {!tsData ? (
              <div className="space-y-3 py-5"><div className="skeleton h-4 w-32" /><div className="skeleton h-10 w-40" /><div className="skeleton h-4 w-24" /></div>
            ) : (
              <div className="pt-4">
                <p className="text-sm text-slate-500">Total hours <span className="italic text-slate-400">({periodName})</span></p>
                <p className="mt-1 text-[34px] font-semibold leading-tight tabular-nums text-slate-900">
                  {planned.h}<span className="text-base font-normal text-slate-400">hrs </span>{String(planned.m).padStart(2, "0")}<span className="text-base font-normal text-slate-400">mins</span>
                </p>
                <p className="mt-3 text-sm text-slate-500">Total days <span className="italic text-slate-400">(scheduled)</span></p>
                <p className="mt-0.5 text-2xl font-semibold tabular-nums text-slate-900">{tsData.totals.expectedDays}<span className="text-base font-normal text-slate-400"> days</span></p>
                <p className="mt-3 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500">
                  <span className="mt-0.5 text-slate-400">{Ico.info}</span>
                  {weekly !== null
                    ? `Your shift plans ${weekly}h a week. Holidays, weekly offs and approved leave are not counted.`
                    : "Planned hours are your productive target for each scheduled working day. Holidays and approved leave are not counted."}
                </p>
              </div>
            )}
          </section>

          {/* ---- Worked hours ---- */}
          <section className={`${CARD} ${dim}`}>
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3.5 text-[15px] font-medium text-slate-900">
              <span className="text-slate-500">{Ico.worked}</span> Worked hours
            </div>
            {!tsData ? (
              <div className="py-5"><div className="skeleton h-28" /></div>
            ) : (
              <div className="pt-4">
                <div className="rounded-2xl bg-slate-50 px-4 py-5 text-center">
                  <p className="text-sm text-slate-500">Total hours <span className="italic text-slate-400">({periodName})</span></p>
                  <p className="mt-1 text-[34px] font-semibold leading-tight tabular-nums text-slate-900">
                    {worked.h}<span className="text-base font-normal text-slate-400">hrs </span>{String(worked.m).padStart(2, "0")}<span className="text-base font-normal text-slate-400">mins</span>
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[11.5px]">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-slate-600 ring-1 ring-slate-200"><span className="h-2 w-2 rounded-full" style={{ background: SEG_COLOR.work }} />Productive {fmtDur(periodProductive)}</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-slate-600 ring-1 ring-slate-200"><span className="h-2 w-2 rounded-full" style={{ background: SEG_COLOR.break }} />Break {fmtDur(periodBreak)}</span>
                  </div>
                </div>
                <p className="mt-3 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500">
                  <span className="mt-0.5 text-slate-400">{Ico.info}</span>
                  Total time on site = productive + break, so a break is counted once. Meetings you accepted are part of productive time.
                </p>
              </div>
            )}
          </section>
        </div>

        {/* ===================== My Timesheets ===================== */}
        {me.role === "MANAGER" && <HuddleOverview compact />}

        {tsData && (
          <Breakdown totals={tsData.totals} days={days} tz={tz} today={today} rangeLabel={rangeLabel} />
        )}

        <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3.5">
            <span className="flex items-center gap-2 text-[15px] font-medium text-slate-900"><span className="text-slate-500">{Ico.sheet}</span> My timesheets</span>
            <button onClick={() => setOpenLog("all")} disabled={!tsData} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-40">
              {Ico.list} Entry log
            </button>
            <button onClick={() => setCorrectFor(today || "")} disabled={!tsData} className="rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-indigo-700 transition hover:bg-indigo-50 disabled:opacity-40">
              Request correction
            </button>
          </div>

          {correctionSent && <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">Correction request sent. HR has been notified. Track it under Attendance corrections.</p>}
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 py-4 text-xs text-slate-600">
            {([["work", "Working time"], ["break", "Break"], ["overtime", "Overtime"], ["late", "Late"]] as const).map(([k, label]) => (
              <span key={k} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: SEG_COLOR[k] }} />{label}</span>
            ))}
          </div>

          {ts.error && !ts.data ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <span>Couldn&apos;t load your timesheet: {ts.error}</span>
              <button onClick={() => setReloadTs((n) => n + 1)} className="shrink-0 rounded-lg bg-white px-3 py-1 text-xs font-medium text-red-700 ring-1 ring-red-200 hover:bg-red-100">Retry</button>
            </div>
          ) : !tsData ? (
            <div className="space-y-5 py-2">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-16" />)}</div>
          ) : (
            <div className={dim}>
              {ts.error && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Showing the previous range: {ts.error}</p>}
              {models.every((m) => !m.hasSession) && (
                <p className="mb-2 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">No clock-ins in this range.</p>
              )}
              {models.map((m) => (
                <DayRow key={m.date} model={m} tz={tz} onOpen={(d) => setOpenLog(d)} onCorrect={m.day.isFuture || m.date < correctionFloor ? undefined : (d) => setCorrectFor(d)} />
              ))}
            </div>
          )}
        </section>
      </div>

      {lateAsk && <LateRemarkModal minutes={lateAsk.minutes} busy={busy} error={lateAsk.error} onSubmit={(r) => void clockIn(r)} onCancel={() => setLateAsk(null)} />}
      {openLog && tsData && (
        <EntryLogModal models={models} tz={tz} selected={openLog === "all" ? null : openLog} rangeLabel={rangeLabel} onClose={() => setOpenLog(null)} />
      )}
      {correctFor !== null && (
        <RequestCorrectionModal
          date={correctFor}
          onClose={() => setCorrectFor(null)}
          onDone={() => {
            setCorrectFor(null);
            setCorrectionSent(true);
          }}
        />
      )}
      {openSchedule && tsData && <ScheduleModal ts={tsData} rangeLabel={periodName} onClose={() => setOpenSchedule(false)} />}
    </div>
  );
}
