"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { useMe } from "../layout";
import { clockTime, dayLabel, hm } from "../reports/_team/format";

// ATTENDANCE CALENDAR: one coloured status per person per day, from the person's FIRST check-in of the day (company timezone):
// at or before 9:45 = Present, up to 10:15 = Late, after 10:15 = Half day. Leave, holidays, week-offs, "not tracked" days and Absent
// come from the existing attendance engine, and nobody is Absent while the day is still going.
// Data: GET /attendance-calendar. Working and break time are the stored values (same as Reports); the stamps are shown exactly as recorded.
// This view does not change Reports or payroll, which keep their own late and half-day rules.

type Status = "PRESENT" | "LATE" | "HALF_DAY" | "ABSENT" | "LEAVE" | "HOLIDAY" | "WEEK_OFF" | "NOT_TRACKED" | "NOT_CLOCKED_IN";
type Person = { id: string; name: string; code: string | null; designation: string | null; company: string; timezone: string; teamId: string | null; teamName: string | null };
type Row = {
  userId: string; date: string; status: Status; firstCheckIn: string | null; lastCheckOut: string | null; lateByMinutes: number | null;
  workedSeconds: number | null; breakSeconds: number | null; stillWorking: boolean; payrollStatus: string; leaveType: string | null; holidayName: string | null; note: string | null;
};
type Data = {
  timezone: string; today: string; from: string; to: string; rules: { presentUntil: string; lateUntil: string };
  options: { people: { id: string; name: string; code: string | null }[]; teams: { id: string; name: string }[] };
  people: Person[]; rows: Row[]; counts: Record<string, number>;
};

const LOOK: Record<Status, { label: string; chip: string; dot: string }> = {
  PRESENT: { label: "Present", chip: "bg-emerald-100 text-emerald-800", dot: "bg-emerald-500" },
  LATE: { label: "Late", chip: "bg-amber-100 text-amber-800", dot: "bg-amber-500" },
  HALF_DAY: { label: "Half day", chip: "bg-orange-100 text-orange-800", dot: "bg-orange-500" },
  ABSENT: { label: "Absent", chip: "bg-red-100 text-red-700", dot: "bg-red-500" },
  LEAVE: { label: "Leave", chip: "bg-sky-100 text-sky-800", dot: "bg-sky-500" },
  HOLIDAY: { label: "Holiday", chip: "bg-indigo-100 text-indigo-700", dot: "bg-indigo-400" },
  WEEK_OFF: { label: "Week-off", chip: "bg-slate-100 text-slate-500", dot: "bg-slate-300" },
  NOT_TRACKED: { label: "Not tracked", chip: "bg-slate-100 text-slate-500", dot: "bg-slate-300" },
  NOT_CLOCKED_IN: { label: "Not in yet", chip: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
};
const LEGEND: Status[] = ["PRESENT", "LATE", "HALF_DAY", "ABSENT", "LEAVE", "HOLIDAY", "WEEK_OFF", "NOT_TRACKED"];

const card = "rounded-2xl bg-white shadow-[var(--shadow-card)]";
const input = "rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none";

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
function monthRange(anchorIso: string, delta: number) {
  const [y, m] = anchorIso.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + delta, 1));
  const last = new Date(Date.UTC(y, m + delta, 0));
  return { from: iso(first.getUTCFullYear(), first.getUTCMonth() + 1, 1), to: iso(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate()) };
}
function monthTitle(fromIso: string, toIso: string) {
  const f = (s: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${s}T00:00:00Z`));
  return f(fromIso) === f(toIso) ? f(fromIso) : `${dayLabel(fromIso)} – ${dayLabel(toIso)}`;
}
const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (s: string) => (new Date(`${s}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0

function datesBetween(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export default function AttendanceCalendarPage() {
  const me = useMe();
  const isStaff = me ? ["MANAGER", "HR", "ADMIN"].includes(me.role) : false;
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [userId, setUserId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<{ userId: string; date: string } | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (range.from) qs.set("from", range.from);
    if (range.to) qs.set("to", range.to);
    if (userId) qs.set("userId", userId);
    if (teamId) qs.set("teamId", teamId);
    try {
      setLoading(true);
      setData(await apiGet<Data>(`/attendance-calendar?${qs.toString()}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range, userId, teamId]);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const byKey = useMemo(() => new Map((data?.rows ?? []).map((r) => [`${r.userId}|${r.date}`, r])), [data]);
  const personById = useMemo(() => new Map((data?.people ?? []).map((p) => [p.id, p])), [data]);
  const dates = useMemo(() => (data ? datesBetween(data.from, data.to) : []), [data]);
  const single = data && data.people.length === 1 ? data.people[0] : null; // one person: a real month calendar
  const pickedRow = picked ? byKey.get(`${picked.userId}|${picked.date}`) ?? null : null;
  const pickedPerson = picked ? personById.get(picked.userId) ?? null : null;

  const go = (delta: number) => setRange(monthRange(data?.from ?? new Date().toISOString().slice(0, 10), delta));

  return (
    <div className="mx-auto page-7xl space-y-5 p-4 sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{isStaff ? "Attendance" : "My attendance"}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Each day is marked from the first check-in: Present up to {data?.rules.presentUntil ?? "09:45"}, Late up to {data?.rules.lateUntil ?? "10:15"}, Half day after that (company time).
          </p>
        </div>
        {isStaff && (
          <div className="flex rounded-xl bg-white p-1 text-sm shadow-[var(--shadow-card)]">
            <Link href="/dashboard/team-attendance" className="rounded-lg px-3 py-1.5 font-medium text-slate-500 hover:text-slate-900">Live board</Link>
            <span className="rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white">Calendar</span>
          </div>
        )}
      </div>

      <div className={`${card} flex flex-wrap items-end gap-3 p-4`}>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => go(-1)} className="rounded-xl border border-indigo-100 px-3 py-2 text-sm hover:bg-indigo-50" aria-label="Previous month">‹</button>
          <span className="min-w-40 px-2 text-center text-sm font-semibold text-slate-900">{data ? monthTitle(data.from, data.to) : "…"}</span>
          <button type="button" onClick={() => go(1)} className="rounded-xl border border-indigo-100 px-3 py-2 text-sm hover:bg-indigo-50" aria-label="Next month">›</button>
        </div>
        <label className="text-xs text-slate-500">From
          <input type="date" className={`${input} mt-1 block`} value={data?.from ?? ""} onChange={(e) => e.target.value && setRange({ from: e.target.value, to: data && e.target.value > data.to ? e.target.value : data?.to })} />
        </label>
        <label className="text-xs text-slate-500">To
          <input type="date" className={`${input} mt-1 block`} value={data?.to ?? ""} onChange={(e) => e.target.value && setRange({ from: data?.from, to: e.target.value })} />
        </label>
        {isStaff && (
          <>
            <label className="text-xs text-slate-500">Employee
              <select className={`${input} mt-1 block min-w-44`} value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">All employees</option>
                {data?.options.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.code ? ` (${p.code})` : ""}</option>)}
              </select>
            </label>
            <label className="text-xs text-slate-500">Department
              <select className={`${input} mt-1 block min-w-40`} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">All departments</option>
                {data?.options.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          </>
        )}
        <button type="button" onClick={() => { setRange({}); setUserId(""); setTeamId(""); }} className="rounded-xl px-3 py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50">Reset</button>
      </div>

      <div className="flex flex-wrap gap-2">
        {LEGEND.map((s) => (
          <span key={s} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${LOOK[s].chip}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${LOOK[s].dot}`} />
            {LOOK[s].label} <span className="tabular-nums">{data?.counts[s] ?? 0}</span>
          </span>
        ))}
      </div>

      {error && <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {data && data.people.length === 0 && !loading && <div className={`${card} p-8 text-center text-sm text-slate-500`}>No employees to show for these filters.</div>}

      {data && single && (
        <div className={`${card} p-4 sm:p-5`}>
          <p className="mb-3 text-sm font-semibold text-slate-900">{single.name}{single.code ? ` · ${single.code}` : ""}{single.teamName ? ` · ${single.teamName}` : ""}</p>
          <div className="grid grid-cols-7 gap-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-slate-400">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d}>{d}</div>)}
          </div>
          <div className="mt-1.5 grid grid-cols-7 gap-1.5">
            {Array.from({ length: weekday(data.from) }).map((_, i) => <div key={`pad${i}`} />)}
            {dates.map((d) => {
              const r = byKey.get(`${single.id}|${d}`);
              const look = r ? LOOK[r.status] : null;
              return (
                <button
                  key={d}
                  type="button"
                  disabled={!r}
                  onClick={() => setPicked({ userId: single.id, date: d })}
                  className={`flex min-h-16 flex-col items-start rounded-xl border p-1.5 text-left transition sm:min-h-20 sm:p-2 ${r ? `${look!.chip} border-transparent hover:ring-2 hover:ring-indigo-300` : "border-dashed border-indigo-100 text-slate-300"} ${d === data.today ? "ring-2 ring-indigo-500" : ""}`}
                >
                  <span className="text-xs font-semibold">{Number(d.slice(8))}</span>
                  {r && <span className="mt-auto text-[11px] font-medium leading-tight">{look!.label}</span>}
                  {r?.firstCheckIn && <span className="hidden text-[10px] opacity-80 sm:block">{clockTime(r.firstCheckIn, single.timezone)}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {data && !single && data.people.length > 1 && (
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full min-w-max border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-white px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500">Employee</th>
                {dates.map((d) => (
                  <th key={d} className={`px-0.5 py-2 text-center font-medium ${d === data.today ? "text-indigo-600" : "text-slate-400"}`}>
                    <div>{Number(d.slice(8))}</div>
                    <div className="text-[9px] uppercase">{["M", "T", "W", "T", "F", "S", "S"][weekday(d)]}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.people.map((p) => (
                <tr key={p.id}>
                  <td className="sticky left-0 z-10 whitespace-nowrap border-t border-indigo-50 bg-white px-4 py-1.5">
                    <button type="button" onClick={() => setUserId(p.id)} className="text-left" title="Show this person's calendar">
                      <span className="block text-sm font-medium text-slate-900">{p.name}</span>
                      <span className="block text-[11px] text-slate-400">{p.code ?? "—"}{p.teamName ? ` · ${p.teamName}` : ""}</span>
                    </button>
                  </td>
                  {dates.map((d) => {
                    const r = byKey.get(`${p.id}|${d}`);
                    return (
                      <td key={d} className="border-t border-indigo-50 px-0.5 py-1.5 text-center">
                        {r ? (
                          <button type="button" onClick={() => setPicked({ userId: p.id, date: d })} title={`${LOOK[r.status].label} · ${dayLabel(d)}`} className={`mx-auto block h-5 w-5 rounded-md ${LOOK[r.status].dot} hover:ring-2 hover:ring-indigo-300`} aria-label={`${p.name} ${dayLabel(d)} ${LOOK[r.status].label}`} />
                        ) : (
                          <span className="mx-auto block h-5 w-5 rounded-md border border-dashed border-indigo-100" />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-3 text-xs text-slate-400">Click a square for the day&apos;s record, or a name to see that person&apos;s monthly calendar.</p>
        </div>
      )}

      {picked && pickedPerson && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setPicked(null)}>
          <div className={`${card} w-full max-w-md p-5`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold text-slate-900">{pickedPerson.name}</p>
                <p className="text-xs text-slate-500">{dayLabel(picked.date)}</p>
              </div>
              <button type="button" onClick={() => setPicked(null)} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-indigo-50" aria-label="Close">✕</button>
            </div>
            {pickedRow ? (
              <>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${LOOK[pickedRow.status].chip}`}>{LOOK[pickedRow.status].label}</span>
                  {pickedRow.firstCheckIn && (pickedRow.lateByMinutes ?? 0) > 0 && (
                    <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">Late arrival · {hm((pickedRow.lateByMinutes ?? 0) * 60)} after {data?.rules.presentUntil}</span>
                  )}
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <Item k="Employee ID" v={pickedPerson.code ?? "—"} />
                  <Item k="Department" v={pickedPerson.teamName ?? "—"} />
                  <Item k="First check-in" v={clockTime(pickedRow.firstCheckIn, pickedPerson.timezone)} />
                  <Item k="Last check-out" v={pickedRow.stillWorking ? "Still working" : clockTime(pickedRow.lastCheckOut, pickedPerson.timezone)} />
                  <Item k={pickedRow.stillWorking ? "Working time so far" : "Working time"} v={pickedRow.workedSeconds === null ? "—" : hm(pickedRow.workedSeconds)} />
                  <Item k="Break time" v={pickedRow.breakSeconds === null ? "—" : hm(pickedRow.breakSeconds)} />
                </dl>
                {pickedRow.leaveType && <p className="mt-3 text-sm text-slate-600">Leave type: {pickedRow.leaveType.toLowerCase()}</p>}
                {pickedRow.holidayName && <p className="mt-3 text-sm text-slate-600">{pickedRow.holidayName}</p>}
                {pickedRow.firstCheckIn && (
                  <p className="mt-4 rounded-xl bg-indigo-50/60 px-3 py-2 text-xs text-slate-500">
                    Reports and payroll call this day “{pickedRow.payrollStatus}” (they go by hours worked). Times are shown in {pickedPerson.timezone.replace("_", " ")}.
                  </p>
                )}
                {pickedRow.note && <p className="mt-2 text-xs text-slate-500">{pickedRow.note}</p>}
              </>
            ) : (
              <p className="mt-4 text-sm text-slate-500">No record for this day.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-400">{k}</dt>
      <dd className="font-medium tabular-nums text-slate-900">{v}</dd>
    </div>
  );
}
