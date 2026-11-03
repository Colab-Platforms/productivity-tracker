"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";
import { Modal } from "../../_employees/Modal";
import { opensPhrase } from "../when";

// ---------------------------------------------------------------------------
// IN-PERSON MEETING PARTICIPATION (screens)
// Employee: "Join Huddle" -> live timer -> "End Huddle" -> a completed record.
// Organizing manager: the live list (who joined, who has not, who is still in), corrections, history.
// HR / Admin never see this panel: the server gives them counts only.
// Everything here is SELF-REPORTED: the times are what people declared (the server stamps them); they do not prove
// physical presence, and they are separate from attendance, working hours and productivity.
// ---------------------------------------------------------------------------

export type MeInfo = {
  state: "NOT_JOINED" | "IN_MEETING" | "ENDED";
  joinedAt?: string;
  leftAt?: string | null;
  durationSeconds?: number | null;
  late?: boolean;
  source?: string;
  stillActivePastEnd?: boolean;
};
export type InviteStatus = "INVITED" | "ACCEPTED" | "DECLINED" | "JOINED" | "COMPLETED" | "NOT_JOINED";
export const INVITE_CHIP: Record<InviteStatus, { label: string; cls: string }> = {
  INVITED: { label: "Invited", cls: "bg-amber-50 text-amber-700" },
  ACCEPTED: { label: "Accepted", cls: "bg-sky-50 text-sky-700" },
  DECLINED: { label: "Declined", cls: "bg-rose-50 text-rose-700" },
  JOINED: { label: "Joined", cls: "bg-emerald-50 text-emerald-700" },
  COMPLETED: { label: "Completed", cls: "bg-indigo-50 text-indigo-700" },
  NOT_JOINED: { label: "Not joined", cls: "bg-slate-100 text-slate-600" },
};
export type TrackedFields = {
  // The invited person's answer and status (every meeting you are invited to, tracked or not).
  myResponse?: "ACCEPTED" | "DECLINED" | null;
  myStatus?: InviteStatus;
  canRespond?: boolean;
  mustAccept?: boolean;
  tracked?: boolean;
  lateAfterMinutes?: number;
  joinWindow?: { open: boolean; reason: "TOO_EARLY" | "CLOSED" | null; opensAt: string; closesAt: string };
  me?: MeInfo | null;
  canJoin?: boolean;
  joinedCount?: number;
};

const timeFmt = (s: string | null | undefined, tz: string) =>
  s ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(s)) : "—";
const dayFmt = (s: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", day: "2-digit", month: "short" }).format(new Date(s));
const hhmm = (s: string, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(s));

export function dur(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
}
const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

const SELF_REPORTED = "Self-reported: these are the times people declared. They don't prove anyone was physically there, and they are separate from attendance and working hours.";

// ===========================================================================
// EMPLOYEE: accept or decline the invitation, and where it stands
// ===========================================================================

export function InviteResponse({ meetingId, f, onChanged, compact = false }: { meetingId: string; f: TrackedFields; onChanged: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!f.myStatus) return null; // not invited to this one (you organize it)
  const chip = INVITE_CHIP[f.myStatus];

  async function answer(response: "ACCEPTED" | "DECLINED") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiPost(`/meetings/${meetingId}/respond`, { response });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "mt-3" : ""}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">Your invitation:</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${chip.cls}`}>{chip.label}</span>
        {f.canRespond && f.myResponse !== "ACCEPTED" && (
          <button onClick={() => answer("ACCEPTED")} disabled={busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">
            {busy ? "Saving…" : f.myResponse === "DECLINED" ? "Accept instead" : "Accept invitation"}
          </button>
        )}
        {f.canRespond && f.myResponse !== "DECLINED" && (
          <button onClick={() => answer("DECLINED")} disabled={busy} className="rounded-xl border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60">
            {f.myResponse === "ACCEPTED" ? "Change to decline" : "Decline"}
          </button>
        )}
      </div>
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-700">{error}</p>}
    </div>
  );
}

// ===========================================================================
// EMPLOYEE: the join / end control
// ===========================================================================

export function JoinControl({ meetingId, endsAt, tz, f, onChanged, compact = false }: { meetingId: string; endsAt: string; tz: string; f: TrackedFields; onChanged: () => void; compact?: boolean }) {
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const me = f.me;
  if (!f.tracked || !me) return null;

  async function act(path: "join" | "leave") {
    if (busy) return; // a double click must not send two
    setBusy(true);
    setError("");
    try {
      await apiPost(`/meetings/${meetingId}/${path}`);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      onChanged(); // the screen may simply be out of date (already joined on another tab)
    } finally {
      setBusy(false);
    }
  }

  const box = compact ? "mt-3 rounded-xl p-3" : "rounded-2xl p-4";

  if (me.state === "ENDED") {
    return (
      <div className={`${box} bg-emerald-50 text-sm text-emerald-900`}>
        <p className="font-medium">Your participation is recorded</p>
        <p className="mt-0.5">
          Joined {timeFmt(me.joinedAt, tz)} · Left {timeFmt(me.leftAt, tz)} · <b>{dur(me.durationSeconds)}</b>
          {me.late && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">joined late</span>}
          {me.source === "MANAGER_ADDED" && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">recorded by the organizer</span>}
        </p>
        <p className="mt-1 text-xs text-emerald-800/80">Self-reported. You can&apos;t change these times; ask the organizer if something is wrong.</p>
      </div>
    );
  }

  if (me.state === "IN_MEETING") {
    const elapsed = me.joinedAt ? (now - new Date(me.joinedAt).getTime()) / 1000 : 0;
    const pastEnd = now > new Date(endsAt).getTime();
    return (
      <div className={`${box} bg-indigo-600 text-white`}>
        <p className="text-sm text-indigo-100">You joined at {timeFmt(me.joinedAt, tz)}{me.late ? " (late)" : ""}</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums" aria-live="off" aria-label="Time in the meeting">{clock(elapsed)}</p>
        {pastEnd && <p className="mt-1 text-xs text-amber-200">The expected end ({timeFmt(endsAt, tz)}) has passed. Press the button when you leave.</p>}
        <button onClick={() => act("leave")} disabled={busy} className="mt-3 w-full rounded-xl bg-white px-5 py-3 text-base font-semibold text-indigo-700 shadow-sm transition hover:bg-indigo-50 disabled:opacity-60 sm:w-auto">
          {busy ? "Saving…" : "End Huddle"}
        </button>
        {error && <p className="mt-2 rounded-lg bg-white/10 px-3 py-1.5 text-sm text-rose-100">{error}</p>}
        <p className="mt-2 text-xs text-indigo-200">Press it when you leave the room. The time is recorded by the server.</p>
      </div>
    );
  }

  // not joined yet
  const w = f.joinWindow;
  if (f.mustAccept && w?.reason !== "CLOSED") {
    return <p className={`${box} bg-slate-50 text-sm text-slate-600`}>Accept the invitation first. The “Join Huddle” button appears here once you have accepted and the meeting is about to start.</p>;
  }
  if (f.canJoin) {
    return (
      <div className={`${box} bg-indigo-50`}>
        <button onClick={() => act("join")} disabled={busy} className="w-full rounded-xl bg-indigo-600 px-6 py-3.5 text-base font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-60 sm:w-auto">
          {busy ? "Saving…" : "Join Huddle"}
        </button>
        {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-700">{error}</p>}
        <p className="mt-2 text-xs text-slate-500">
          Press it when you are in the room. Joining more than {f.lateAfterMinutes ?? 5} minutes after the start counts as late. Self-reported.
        </p>
      </div>
    );
  }
  if (w?.reason === "TOO_EARLY") {
    return <p className={`${box} bg-slate-50 text-sm text-slate-600`}>You can press “Join Huddle” {opensPhrase(w.opensAt, tz)} (15 minutes before it starts).</p>;
  }
  if (w?.reason === "CLOSED") {
    return <p className={`${box} bg-slate-50 text-sm text-slate-600`}>Joining has closed because the expected end has passed. If you were there, ask the organizer to record it.</p>;
  }
  return null;
}

/** A one-line record for a past meeting, shown to the invitee. */
export function PastRecord({ f, tz }: { f: TrackedFields; tz: string }) {
  if (!f.tracked || !f.me) return null;
  const me = f.me;
  if (me.state === "NOT_JOINED") return <p className="mt-1 text-xs text-slate-500">You did not join this meeting.</p>;
  return (
    <p className="mt-1 text-xs text-slate-500">
      You joined {timeFmt(me.joinedAt, tz)}{me.leftAt ? `, left ${timeFmt(me.leftAt, tz)} (${dur(me.durationSeconds)})` : ", and have not ended it"}{me.late ? " · late" : ""}
    </p>
  );
}

// ===========================================================================
// ORGANIZING MANAGER: live list
// ===========================================================================

type Row = {
  userId: string; name: string; employeeCode: string | null; designation: string | null;
  response?: "ACCEPTED" | "DECLINED" | null; status?: InviteStatus;
  state: "NOT_JOINED" | "IN_MEETING" | "ENDED"; joinedAt: string | null; leftAt: string | null; durationSeconds: number | null;
  late: boolean; minutesAfterStart: number | null; stillActivePastEnd: boolean; source: string | null; corrected: boolean;
};
type OrganizerRow = Pick<Row, "userId" | "name" | "state" | "joinedAt" | "leftAt" | "durationSeconds" | "late" | "minutesAfterStart" | "stillActivePastEnd">;
type Panel = {
  organizer?: OrganizerRow;
  meeting: { id: string; title: string; startsAt: string; endsAt: string; status: string };
  timezone: string; now: string; lateAfterMinutes: number;
  summary: { invited: number; accepted?: number; declined?: number; awaitingAnswer?: number; joined: number; notJoined: number; inMeeting: number; ended: number; late: number; stillActivePastEnd: number; actualDurationSeconds: number | null; actualDurationOngoing: boolean; averageParticipationSeconds: number | null };
  rows: Row[];
};

const CHIP: Record<Row["state"], { label: string; cls: string }> = {
  NOT_JOINED: { label: "Not joined", cls: "bg-slate-100 text-slate-600" },
  IN_MEETING: { label: "In the meeting", cls: "bg-emerald-50 text-emerald-700" },
  ENDED: { label: "Ended", cls: "bg-indigo-50 text-indigo-700" },
};

export function ParticipationPanel({ meetingId }: { meetingId: string }) {
  const [data, setData] = useState<Panel | null>(null);
  const [error, setError] = useState("");
  const [fixing, setFixing] = useState<Row | null>(null);
  const [historyOf, setHistoryOf] = useState<Row | null>(null);
  const [offset, setOffset] = useState(0); // server clock minus this browser's clock, so the live timers agree with the server
  const now = useNow(1000) + offset;

  const load = useCallback(async () => {
    try {
      const d = await apiGet<Panel>(`/meetings/${meetingId}/participation`);
      setData(d);
      setOffset(new Date(d.now).getTime() - Date.now());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [meetingId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    const poll = setInterval(() => void load(), 20000); // a fallback if the live connection is down
    return () => { clearTimeout(t); clearInterval(poll); };
  }, [load]);
  useRealtime(["meetings:changed"], load); // somebody joined or ended: the list updates by itself

  if (error && !data) return <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>;
  if (!data) return <div className="skeleton h-40" aria-busy="true" />;
  const tz = data.timezone;
  const s = data.summary;
  const tiles: [string, string, string?][] = [
    ["Invited", String(s.invited)],
    ["Accepted", String(s.accepted ?? 0)],
    ["Declined", String(s.declined ?? 0), (s.declined ?? 0) > 0 ? "text-rose-700" : undefined],
    ["Joined", String(s.joined)],
    ["Not joined", String(s.notJoined), s.notJoined > 0 ? "text-amber-700" : undefined],
    ["Late", String(s.late), s.late > 0 ? "text-amber-700" : undefined],
    ["Meeting length", s.actualDurationSeconds === null ? "—" : `${dur(s.actualDurationSeconds)}${s.actualDurationOngoing ? " (so far)" : ""}`],
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {tiles.map(([label, value, cls]) => (
          <div key={label} className="rounded-xl bg-[#F6F7FE] px-3 py-2">
            <p className="text-[11px] text-slate-500">{label}</p>
            <p className={`text-lg font-semibold tabular-nums ${cls ?? "text-slate-900"}`}>{value}</p>
          </div>
        ))}
      </div>

      {s.stillActivePastEnd > 0 && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {s.stillActivePastEnd} {s.stillActivePastEnd === 1 ? "person is" : "people are"} still marked as in the meeting after the expected end ({timeFmt(data.meeting.endsAt, tz)}). They haven&apos;t pressed “End Huddle”. Nothing is closed automatically; you can correct the record.
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl border border-indigo-100">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-[#F6F7FE] text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Employee</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Joined</th>
              <th className="px-3 py-2 font-medium">Left</th>
              <th className="px-3 py-2 font-medium">Duration</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-indigo-50">
            {data.organizer && (
              <tr className="bg-[#F6F7FE]/70">
                <td className="px-3 py-2.5">
                  <p className="font-medium text-slate-900">{data.organizer.name} <span className="ml-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-700">you · organizer</span></p>
                  <p className="text-xs text-slate-400">Not counted among the invited people</p>
                </td>
                <td className="px-3 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CHIP[data.organizer.state].cls}`}>{CHIP[data.organizer.state].label}</span>
                  {data.organizer.late && <span className="ml-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">late +{data.organizer.minutesAfterStart}m</span>}
                  {data.organizer.stillActivePastEnd && <span className="ml-1.5 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">still active past end</span>}
                </td>
                <td className="px-3 py-2.5 tabular-nums text-slate-700">{timeFmt(data.organizer.joinedAt, tz)}</td>
                <td className="px-3 py-2.5 tabular-nums text-slate-700">{data.organizer.state === "ENDED" ? timeFmt(data.organizer.leftAt, tz) : "—"}</td>
                <td className="px-3 py-2.5 tabular-nums text-slate-700">
                  {data.organizer.state === "IN_MEETING" && data.organizer.joinedAt ? <span className="text-emerald-700">{clock((now - new Date(data.organizer.joinedAt).getTime()) / 1000)}</span> : dur(data.organizer.durationSeconds)}
                </td>
                <td className="px-3 py-2.5" />
              </tr>
            )}
            {data.rows.map((r) => {
              const live = r.state === "IN_MEETING" && r.joinedAt ? (now - new Date(r.joinedAt).getTime()) / 1000 : null;
              return (
                <tr key={r.userId}>
                  <td className="px-3 py-2.5">
                    <button onClick={() => setHistoryOf(r)} className="text-left font-medium text-slate-900 hover:text-indigo-700 hover:underline" title="See this person's participation history">{r.name}</button>
                    <p className="text-xs text-slate-400">{r.employeeCode ?? "—"}{r.designation ? ` · ${r.designation}` : ""}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.status ? INVITE_CHIP[r.status].cls : CHIP[r.state].cls}`}>{r.status ? INVITE_CHIP[r.status].label : CHIP[r.state].label}</span>
                    {r.late && <span className="ml-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700" title={`Joined ${r.minutesAfterStart} min after the start`}>late +{r.minutesAfterStart}m</span>}
                    {r.stillActivePastEnd && <span className="ml-1.5 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">still active past end</span>}
                    {r.source === "MANAGER_ADDED" && <span className="ml-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">added by you</span>}
                    {r.corrected && <span className="ml-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600" title="A manager correction is on record">corrected</span>}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-slate-700">{timeFmt(r.joinedAt, tz)}</td>
                  <td className="px-3 py-2.5 tabular-nums text-slate-700">{r.state === "ENDED" ? timeFmt(r.leftAt, tz) : "—"}</td>
                  <td className="px-3 py-2.5 tabular-nums text-slate-700">{live !== null ? <span className="text-emerald-700">{clock(live)}</span> : dur(r.durationSeconds)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <button onClick={() => setFixing(r)} className="rounded-lg border border-indigo-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                      {r.state === "NOT_JOINED" ? "Record joined" : "Correct"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400">{SELF_REPORTED} Late means more than {data.lateAfterMinutes} minutes after the start.</p>

      {fixing && <CorrectDialog meetingId={meetingId} tz={tz} row={fixing} onClose={() => setFixing(null)} onDone={() => { setFixing(null); void load(); }} />}
      {historyOf && <HistoryModal personId={historyOf.userId} name={historyOf.name} onClose={() => setHistoryOf(null)} />}
    </div>
  );
}

// ===========================================================================
// corrections (reason required, kept as history, the person is told)
// ===========================================================================

function CorrectDialog({ meetingId, tz, row, onClose, onDone }: { meetingId: string; tz: string; row: Row; onClose: () => void; onDone: () => void }) {
  const adding = row.state === "NOT_JOINED";
  const [joined, setJoined] = useState(row.joinedAt ? hhmm(row.joinedAt, tz) : "");
  const [left, setLeft] = useState(row.leftAt ? hhmm(row.leftAt, tz) : "");
  const [clearLeft, setClearLeft] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const why = adding && !joined ? "Enter the time they joined." : reason.trim().length < 5 ? `Add a reason (at least 5 characters, you have ${reason.trim().length}).` : "";
  const input = "mt-1 w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800";

  async function save() {
    if (busy || why) return;
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = { reason: reason.trim() };
      if (joined && joined !== (row.joinedAt ? hhmm(row.joinedAt, tz) : "")) body.joinedAt = joined;
      if (adding && joined) body.joinedAt = joined;
      if (clearLeft) body.clearLeft = true;
      else if (left && left !== (row.leftAt ? hhmm(row.leftAt, tz) : "")) body.leftAt = left;
      await apiPatch(`/meetings/${meetingId}/participation/${row.userId}`, body);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={adding ? `Record ${row.name} as joined` : `Correct ${row.name}`}
      subtitle="Saved as a correction with your name and reason. The person is notified, and the original times stay in the history."
      onClose={onClose}
      width="max-w-md"
      footer={
        <div className="flex items-center justify-end gap-2">
          {why && !busy && <p className="mr-auto text-xs text-amber-700" role="status">{why}</p>}
          <button onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Close</button>
          <button onClick={save} disabled={busy || !!why} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? "Saving…" : "Save correction"}</button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-slate-600">Joined{adding ? " *" : ""}<input type="time" value={joined} onChange={(e) => setJoined(e.target.value)} className={input} /></label>
          <label className="block text-sm text-slate-600">Left<input type="time" value={left} disabled={clearLeft} onChange={(e) => setLeft(e.target.value)} className={`${input} disabled:bg-slate-50`} /></label>
        </div>
        {row.state === "ENDED" && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={clearLeft} onChange={(e) => setClearLeft(e.target.checked)} /> They are still in the meeting (remove the leave time)
          </label>
        )}
        <p className="-mt-2 text-xs text-slate-400">Times are in your company&apos;s timezone ({tz}), on the meeting&apos;s day.</p>
        <label className="block text-sm text-slate-600">
          Reason
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} className={input} placeholder="For example: was in the room but did not press the button" />
          <span className={`mt-1 block text-xs ${reason.trim().length < 5 ? "text-amber-700" : "text-slate-400"}`}>{reason.trim().length}/300 · at least 5 characters</span>
        </label>
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

// ===========================================================================
// history: your own, or (for the organizer) one person's in the meetings you ran
// ===========================================================================

type History = {
  timezone: string; personId: string;
  summary: { meetings: number; joined: number; notJoined: number; late: number; averageSeconds: number | null };
  rows: { meetingId: string; title: string; startsAt: string; endsAt: string; state: Row["state"]; joinedAt: string | null; leftAt: string | null; durationSeconds: number | null; late: boolean; corrected: boolean; source: string | null }[];
};

export function HistoryModal({ personId, name, onClose }: { personId?: string; name?: string; onClose: () => void }) {
  const [res, setRes] = useState<{ key: string; data?: History; error?: string } | null>(null);
  const key = personId ?? "me";
  useEffect(() => {
    let live = true;
    apiGet<History>(`/meetings/participation/history${personId ? `?userId=${personId}` : ""}`)
      .then((data) => live && setRes({ key, data }))
      .catch((e: Error) => live && setRes({ key, error: e.message }));
    return () => { live = false; };
  }, [personId, key]);
  const cur = res && res.key === key ? res : null;
  const tz = cur?.data?.timezone ?? "Asia/Kolkata";
  return (
    <Modal title={name ? `${name}: participation history` : "My participation history"} subtitle="In-person meetings with participation tracking." onClose={onClose} width="max-w-2xl">
      {!cur && <div className="skeleton h-32" aria-busy="true" />}
      {cur?.error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{cur.error}</p>}
      {cur?.data && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {cur.data.summary.meetings} meeting{cur.data.summary.meetings === 1 ? "" : "s"} · joined {cur.data.summary.joined} · not joined {cur.data.summary.notJoined} · late {cur.data.summary.late}
            {cur.data.summary.averageSeconds !== null && <> · average {dur(cur.data.summary.averageSeconds)}</>}
          </p>
          {cur.data.rows.length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">No finished in-person meetings yet.</p>
          ) : (
            <ul className="divide-y divide-indigo-50 rounded-2xl border border-indigo-100">
              {cur.data.rows.map((r) => (
                <li key={r.meetingId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                  <div>
                    <p className="font-medium text-slate-900">{r.title}</p>
                    <p className="text-xs text-slate-400">{dayFmt(r.startsAt, tz)} · {timeFmt(r.startsAt, tz)}–{timeFmt(r.endsAt, tz)}</p>
                  </div>
                  <div className="text-right text-xs text-slate-600">
                    <span className={`rounded-full px-2 py-0.5 font-medium ${CHIP[r.state].cls}`}>{CHIP[r.state].label}</span>
                    {r.state !== "NOT_JOINED" && <p className="mt-1 tabular-nums">{timeFmt(r.joinedAt, tz)} – {r.state === "ENDED" ? timeFmt(r.leftAt, tz) : "…"} · {dur(r.durationSeconds)}</p>}
                    {(r.late || r.corrected) && <p className="mt-0.5 text-amber-700">{r.late ? "late" : ""}{r.late && r.corrected ? " · " : ""}{r.corrected ? "corrected" : ""}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-400">{SELF_REPORTED}</p>
        </div>
      )}
    </Modal>
  );
}
