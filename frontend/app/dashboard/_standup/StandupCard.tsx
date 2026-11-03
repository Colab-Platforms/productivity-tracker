"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";
import { InviteResponse, JoinControl, type TrackedFields } from "../meetings/_participation/Participation";

// ---------------------------------------------------------------------------
// STAND-UP CARD on the dashboard
// When you are invited to an in-person (tracked) meeting, it shows up right here: the "Join Huddle" button once
// the join window opens, a clear "In a meeting" state with the live timer while you are in it, and your completed
// record afterwards. Nothing appears when there is nothing to do. Self-reported, and separate from clock-in/out.
// Data: the same GET /meetings the Meetings page uses (the server decides what you may see and do).
// ---------------------------------------------------------------------------

export type StandupMeeting = TrackedFields & {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  organizer: string;
  isOrganizer: boolean;
  state: "upcoming" | "ongoing" | "past" | "cancelled";
};

const SOON_MINUTES = 60;

const timeFmt = (s: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(s));

/** Which tracked meetings deserve a card right now, most urgent first. */
export function relevant(meetings: StandupMeeting[], now: number): StandupMeeting[] {
  const rank = (m: StandupMeeting) => (m.me?.state === "IN_MEETING" ? 0 : m.canJoin ? 1 : m.mustAccept ? 1 : m.me?.state === "ENDED" ? 3 : 2);
  return meetings
    .filter((m) => {
      // Meetings you organize count too: the organizer can mark himself in and out like everyone else.
      // A finished meeting is hidden, EXCEPT while you are still marked as in it: you must always be able to press End Huddle.
      if (m.state === "cancelled") return false;
      if (m.state === "past" && m.me?.state !== "IN_MEETING") return false;
      // An invitation waiting for your answer is always shown, tracked or not.
      if (m.canRespond && m.myResponse !== "DECLINED") return true;
      if (!m.tracked || !m.me) return false;
      if (m.me.state === "IN_MEETING" || m.me.state === "ENDED" || m.canJoin) return true;
      // not joined yet: only show it when it is about to open (or has just opened and is waiting for you)
      return m.joinWindow?.reason === "TOO_EARLY" && new Date(m.joinWindow.opensAt).getTime() - now <= SOON_MINUTES * 60_000;
    })
    .sort((a, b) => rank(a) - rank(b) || new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

export function StandupItem({ m, tz, onChanged }: { m: StandupMeeting; tz: string; onChanged: () => void }) {
  const inMeeting = m.me?.state === "IN_MEETING";
  return (
    <section
      aria-label={`Stand-up: ${m.title}`}
      className={`rounded-2xl border p-4 ${inMeeting ? "border-indigo-300 bg-indigo-50/60" : "border-indigo-100 bg-white"}`}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-indigo-600">
            {inMeeting && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />}
            {inMeeting ? (m.tracked ? "Team Huddle in Progress" : "You are in a meeting") : m.tracked ? "Team Huddle invitation" : "Meeting invitation"}
          </p>
          <p className="mt-0.5 truncate text-base font-semibold text-slate-900">{m.title}</p>
          <p className="text-sm text-slate-500">
            {timeFmt(m.startsAt, tz)} – {timeFmt(m.endsAt, tz)} · organised by {m.isOrganizer ? "you" : m.organizer}
          </p>
        </div>
        <Link href={`/dashboard/meetings?id=${m.id}`} className="text-xs font-medium text-indigo-600 hover:underline">Details</Link>
      </div>
      <InviteResponse meetingId={m.id} f={m} onChanged={onChanged} />
      <div className={m.myStatus ? "mt-3" : ""}>
        <JoinControl meetingId={m.id} endsAt={m.endsAt} tz={tz} f={m} onChanged={onChanged} />
      </div>
    </section>
  );
}

export default function StandupCard() {
  const [data, setData] = useState<{ tz: string; meetings: StandupMeeting[] } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ timezone: string; meetings: StandupMeeting[] }>("/meetings?scope=upcoming");
      setData({ tz: r.timezone, meetings: r.meetings });
    } catch {
      // a failed refresh keeps what is on screen; this card is never allowed to get in the way of the dashboard
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const poll = setInterval(() => void load(), 60_000); // a fallback if the live connection is down, and it opens the join window on time
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearTimeout(first); clearInterval(poll); clearInterval(tick); };
  }, [load]);
  useRealtime(["meetings:changed"], load);

  if (!data) return null;
  const items = relevant(data.meetings, now);
  if (items.length === 0) return null;
  return (
    <div className="mt-4 space-y-3">
      {items.map((m) => <StandupItem key={m.id} m={m} tz={data.tz} onChanged={() => void load()} />)}
    </div>
  );
}
