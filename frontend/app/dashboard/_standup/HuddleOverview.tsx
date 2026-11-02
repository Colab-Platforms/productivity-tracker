"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";

// ---------------------------------------------------------------------------
// TEAM HUDDLE OVERVIEW (manager). Today's huddles the manager runs, limited to the people who report to them, with live
// participation, and each person's productive-time split (regular / Team Huddle / other). Numbers come from the server's
// one shared calculation, so they match the employee's own screen. Self-reported: times are what people declared.
// ---------------------------------------------------------------------------

type Row = { userId: string; name: string; employeeCode: string | null; state: "NOT_JOINED" | "IN_MEETING" | "ENDED"; joinedAt: string | null; leftAt: string | null; durationSeconds: number | null; late: boolean; countedSeconds: number; openPastEnd: boolean };
type Overview = {
  date: string; timezone: string;
  meetings: { id: string; title: string; startsAt: string; endsAt: string; lateAfterMinutes: number; summary: { invited: number; joined: number; notJoined: number; inMeeting: number; late: number }; rows: Row[] }[];
  people: { userId: string; name: string; employeeCode: string | null; clockedIn: boolean; regularSeconds: number; huddleSeconds: number; otherEligibleSeconds: number; totalSeconds: number; breakSeconds?: number; washroomSeconds?: number; onSiteSeconds?: number }[];
};

const hm = (sec: number) => {
  const m = Math.round(Math.max(0, sec) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};
const t = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)) : "—");
const CHIP = { NOT_JOINED: ["Not joined", "bg-slate-100 text-slate-600"], IN_MEETING: ["In the huddle", "bg-emerald-50 text-emerald-700"], ENDED: ["Ended", "bg-indigo-50 text-indigo-700"] } as const;

export default function HuddleOverview({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Overview>("/meetings/huddles/overview"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const poll = setInterval(() => void load(), 30_000);
    return () => { clearTimeout(first); clearInterval(poll); };
  }, [load]);
  useRealtime(["meetings:changed"], load); // somebody joined or ended: refresh by itself

  // Quiet on the dashboard: nothing to show (or the feature isn't available yet) means no section at all.
  if (compact && (error || !data || data.meetings.length === 0)) return null;
  if (error) return <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>;
  if (!data) return <div className="skeleton h-40" aria-busy="true" />;
  const tz = data.timezone;

  return (
    <section className={compact ? "mt-5 rounded-2xl border border-slate-200 bg-white p-5" : "space-y-5"} aria-label="Team Huddle">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-medium text-slate-900">Team Huddle · today</h2>
        {compact && <Link href="/dashboard/huddles" className="text-xs font-medium text-indigo-600 hover:underline">Open Team Huddle</Link>}
      </div>

      {data.meetings.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">No Team Huddle scheduled for today. Schedule one from Meetings with “In-person stand-up” ticked.</p>
      ) : (
        <div className="mt-3 space-y-4">
          {data.meetings.map((m) => (
            <div key={m.id} className="rounded-2xl border border-indigo-100 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium text-slate-900">{m.title} <span className="font-normal text-slate-400">· {t(m.startsAt, tz)} – {t(m.endsAt, tz)}</span></p>
                <p className="text-xs text-slate-500">
                  Invited <b className="text-slate-900">{m.summary.invited}</b> · Joined <b className="text-slate-900">{m.summary.joined}</b> · In the huddle <b className="text-slate-900">{m.summary.inMeeting}</b> ·{" "}
                  <span className={m.summary.notJoined ? "text-amber-700" : ""}>Not joined <b>{m.summary.notJoined}</b></span> · <span className={m.summary.late ? "text-amber-700" : ""}>Late <b>{m.summary.late}</b></span>
                </p>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="text-xs text-slate-400"><tr><th className="py-1.5 pr-3 font-medium">Employee</th><th className="py-1.5 pr-3 font-medium">Status</th><th className="py-1.5 pr-3 font-medium">Joined</th><th className="py-1.5 pr-3 font-medium">Left</th><th className="py-1.5 pr-3 text-right font-medium">Duration</th><th className="py-1.5 text-right font-medium" title="The part that counts towards productive time">Counted</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {m.rows.map((r) => (
                      <tr key={r.userId}>
                        <td className="py-2 pr-3"><span className="font-medium text-slate-900">{r.name}</span><span className="ml-1.5 text-xs text-slate-400">{r.employeeCode}</span></td>
                        <td className="py-2 pr-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CHIP[r.state][1]}`}>{CHIP[r.state][0]}</span>
                          {r.late && <span className="ml-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">late</span>}
                          {r.openPastEnd && <span className="ml-1.5 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">not ended</span>}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-slate-700">{t(r.joinedAt, tz)}</td>
                        <td className="py-2 pr-3 tabular-nums text-slate-700">{r.state === "ENDED" ? t(r.leftAt, tz) : "—"}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-slate-700">{r.durationSeconds !== null ? hm(r.durationSeconds) : "—"}</td>
                        <td className="py-2 text-right tabular-nums text-slate-900">{r.state === "NOT_JOINED" ? "0m" : hm(r.countedSeconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Productive time today, by employee</p>
            <div className="overflow-x-auto rounded-2xl border border-indigo-100">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-[#F6F7FE] text-xs text-slate-500"><tr><th className="px-3 py-2 font-medium">Employee</th><th className="px-3 py-2 text-right font-medium">Regular work</th><th className="px-3 py-2 text-right font-medium">Team Huddle</th><th className="px-3 py-2 text-right font-medium">Other eligible</th><th className="px-3 py-2 text-right font-medium">Total productive</th><th className="px-3 py-2 text-right font-medium">Break</th><th className="px-3 py-2 text-right font-medium">Washroom</th><th className="px-3 py-2 text-right font-medium">Time on site</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.people.map((p) => (
                    <tr key={p.userId}>
                      <td className="px-3 py-2 font-medium text-slate-900">{p.name}{!p.clockedIn && <span className="ml-2 text-xs font-normal text-slate-400">not clocked in</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{hm(p.regularSeconds)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{hm(p.huddleSeconds)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{hm(p.otherEligibleSeconds)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-900">{hm(p.totalSeconds)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{p.clockedIn ? hm(p.breakSeconds ?? 0) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{p.clockedIn ? hm(p.washroomSeconds ?? 0) : "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{p.clockedIn ? hm(p.onSiteSeconds ?? 0) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-400">Team Huddle time is part of each total, not extra. It only counts inside someone&apos;s clocked-in time and outside breaks. Your reporting employees only. Self-reported times.</p>
          </div>
        </div>
      )}
    </section>
  );
}
