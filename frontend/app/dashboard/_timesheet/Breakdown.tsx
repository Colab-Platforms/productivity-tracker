"use client";

import type { TsDay } from "./types";

// ---------------------------------------------------------------------------
// PRODUCTIVE-TIME BREAKDOWN (employee). The same total productive time the app always showed, split into Regular work,
// Team Huddle and other eligible time (approved live meetings). The split comes from the server's one shared
// calculation; this component only displays it. It never adds time on top: huddle time inside clock-in is already part
// of the total, and a huddle outside clock-in or during a break counts zero.
// ---------------------------------------------------------------------------

const hm = (sec: number) => {
  const m = Math.round(Math.max(0, sec) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};
const clockFmt = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)) : "—");

export default function Breakdown({ totals, days, tz, today, rangeLabel }: { totals: { productiveSeconds: number; breakSeconds?: number; regularSeconds?: number; huddleSeconds?: number; otherEligibleSeconds?: number }; days: TsDay[]; tz: string; today: string; rangeLabel: string }) {
  const regular = totals.regularSeconds ?? totals.productiveSeconds;
  const huddle = totals.huddleSeconds ?? 0;
  const other = totals.otherEligibleSeconds ?? 0;
  const huddleDays = days.filter((d) => (d.session?.breakdown?.huddles.length ?? 0) > 0);

  // The four totals that add up: productive work + Team Huddle + break = time on site. Huddle is never a break and is never extra.
  const productiveWork = regular + other;
  const breakSecs = totals.breakSeconds ?? 0;
  const onSite = totals.productiveSeconds + breakSecs;
  const tiles: [string, number, string][] = [
    ["Productive work", productiveWork, "Your productive time without the Team Huddle part."],
    ["Team Huddle", huddle, "Time in a Team Huddle. It counts as productive time and does not use your break allowance."],
    ["Break", breakSecs, "Tea, lunch, washroom and personal breaks. Team Huddle is never counted here."],
    ["Total time on site", onSite, "Clock-in to clock-out (to now if you are still in): productive work + Team Huddle + break."],
  ];
  const rows: [string, number, string?][] = [
    ["Regular work time", regular],
    ["Team Huddle time", huddle, "Counted from when you press Join Huddle to End Huddle, only inside your clocked-in time and outside breaks."],
    ["Other eligible productive time", other, "Approved meetings that are not a Team Huddle."],
  ];
  return (
    <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5" aria-label="Productive time breakdown">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[15px] font-medium text-slate-900">Productive time breakdown</span>
        <span className="text-xs text-slate-400">{rangeLabel}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map(([label, sec, hint]) => (
          <div key={label} className="rounded-xl bg-slate-50 px-4 py-3" title={hint}>
            <p className="text-xs text-slate-500">{label}</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900">{hm(sec)}</p>
          </div>
        ))}
      </div>
      <dl className="mt-3 divide-y divide-slate-100 text-sm">
        {rows.map(([label, sec, hint]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 py-2" title={hint}>
            <dt className="text-slate-600">{label}</dt>
            <dd className="tabular-nums font-medium text-slate-900">{hm(sec)}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-4 py-2.5">
          <dt className="font-semibold text-slate-900">Total productive time</dt>
          <dd className="tabular-nums text-lg font-semibold text-slate-900">{hm(totals.productiveSeconds)}</dd>
        </div>
      </dl>
      <p className="mt-1 text-xs text-slate-400">Team Huddle time is part of your total, not extra. It is shown separately so you can see how the total is made up.</p>

      {huddleDays.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Your Team Huddles</p>
          <ul className="space-y-2">
            {huddleDays.flatMap((d) =>
              (d.session?.breakdown?.huddles ?? []).map((h) => (
                <li key={h.id} className="rounded-xl bg-slate-50 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-slate-900">{h.title} <span className="font-normal text-slate-400">· {d.date === today ? "Today" : d.date}</span></span>
                    <span className="tabular-nums font-semibold text-slate-900" title="Time that counted towards productive time">{hm(h.countedSeconds)} counted</span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Scheduled {clockFmt(h.scheduledStart, tz)} – {clockFmt(h.scheduledEnd, tz)} · joined {clockFmt(h.joinedAt, tz)} · {h.leftAt ? `left ${clockFmt(h.leftAt, tz)}` : "not ended"}
                    {h.rawSeconds !== h.countedSeconds && <span className="text-amber-700"> · {hm(h.rawSeconds - h.countedSeconds)} not counted (outside your clocked-in time, or on a break)</span>}
                    {h.openPastEnd && <span className="text-amber-700"> · you didn&apos;t press End Huddle; counted only up to the scheduled end</span>}
                    {h.addedByManager && <span> · recorded by your manager</span>}
                  </p>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
