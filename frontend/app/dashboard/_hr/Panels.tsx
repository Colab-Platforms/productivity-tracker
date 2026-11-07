"use client";

// ===========================================================================
// PANELS
//
// Presentational pieces for the HR dashboard. None of them fetch anything;
// they receive data (or a loading / error / empty flag) and draw it, so the
// three states a real screen needs are handled in one place per panel.
// ===========================================================================

import Link from "next/link";
import { roleLabel } from "@/lib/roles";
import { Fragment, type ReactNode } from "react";
import { fmtDay, hm, initials, parseDay, pct, timeOf, weekOf, weekdayShort } from "./format";
import type { Holiday, Person } from "./types";

export const CARD = "rounded-2xl bg-white shadow-[var(--shadow-card)]";

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return <section className={`${CARD} ${className}`}>{children}</section>;
}

export function SectionTitle({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
        {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-24 items-center justify-center rounded-xl bg-[#F3F7F6] px-4 py-6 text-center text-xs text-slate-500">
      {children}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-xs text-rose-700">
      <span>{message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          className="shrink-0 rounded-lg bg-white px-2.5 py-1 font-medium text-rose-700 ring-1 ring-rose-200 hover:bg-rose-100"
        >
          Retry
        </button>
      )}
    </div>
  );
}

// --- stat tile ---------------------------------------------------------------

const TONES = {
  indigo: "bg-indigo-50 text-indigo-600",
  emerald: "bg-emerald-50 text-emerald-600",
  rose: "bg-rose-50 text-rose-500",
  sky: "bg-sky-50 text-sky-600",
  amber: "bg-amber-50 text-amber-600",
  violet: "bg-violet-50 text-violet-600",
} as const;

export function StatTile({
  label,
  value,
  sub,
  tag,
  tone,
  icon,
  loading,
}: {
  label: string;
  value: string;
  sub?: string;
  tag: string;
  tone: keyof typeof TONES;
  icon: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className={`${CARD} p-4`}>
      <div className="flex items-center justify-between">
        <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${TONES[tone]}`}>
          {icon}
        </span>
        <span className="rounded-full bg-[#E7F6F1] px-2 py-0.5 text-[10px] font-medium text-indigo-600">
          {tag}
        </span>
      </div>
      <p className="mt-3 text-xs font-medium text-slate-500">{label}</p>
      {loading ? (
        <Skeleton className="mt-1.5 h-7 w-16" />
      ) : (
        <p className="mt-0.5 text-[26px] font-bold leading-tight tracking-tight text-slate-900 tabular-nums">
          {value}
        </p>
      )}
      {loading ? (
        <Skeleton className="mt-2 h-3 w-28" />
      ) : (
        sub && <p className="mt-1 truncate text-[11px] text-slate-400">{sub}</p>
      )}
    </div>
  );
}

// --- schedule calendar (week strip) ----------------------------------------------

export function WeekStrip({
  today,
  selected,
  holidays,
  onPick,
}: {
  today: string;
  selected: string | null;
  holidays: Holiday[];
  onPick: (day: string) => void;
}) {
  const days = weekOf(today);
  const byDay = new Map(holidays.map((h) => [h.date, h]));

  return (
    <div className="grid grid-cols-7 gap-1.5">
      {days.map((d) => {
        const isSelected = selected === d;
        const holiday = byDay.get(d);
        const isToday = d === today;
        return (
          <button
            key={d}
            onClick={() => onPick(d)}
            title={holiday ? holiday.name : isToday ? "Today" : undefined}
            className={`flex flex-col items-center rounded-xl px-1 py-2 text-center transition-colors ${
              isSelected
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/25"
                : "bg-[#F3F7F6] text-slate-600 hover:bg-indigo-50"
            }`}
          >
            <span className={`text-[10px] ${isSelected ? "text-indigo-100" : "text-slate-400"}`}>
              {weekdayShort(d)}
            </span>
            <span className="mt-0.5 text-sm font-semibold tabular-nums">
              {parseDay(d).getUTCDate()}
            </span>
            <span className="mt-1 flex h-1.5 items-center gap-0.5">
              {isToday && (
                <span className={`h-1.5 w-1.5 rounded-full ${isSelected ? "bg-white" : "bg-indigo-500"}`} />
              )}
              {holiday && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// --- lists ---------------------------------------------------------------------

export function ApprovalRow({
  href,
  label,
  count,
  detail,
  tone,
}: {
  href: string;
  label: string;
  count: number;
  detail?: string;
  tone: keyof typeof TONES;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-xl bg-[#F3F7F6] px-3 py-2.5 transition-colors hover:bg-indigo-50"
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold tabular-nums ${TONES[tone]}`}>
        {count}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-slate-800">{label}</span>
        {detail && <span className="block truncate text-[11px] text-slate-400">{detail}</span>}
      </span>
      <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-300" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="m8 5 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

export type ActivityItem = {
  id: string;
  userId: string;
  at: string;
  name: string;
  text: string;
  tone: "emerald" | "amber" | "rose" | "indigo";
};

const DOT: Record<ActivityItem["tone"], string> = {
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  rose: "bg-rose-400",
  indigo: "bg-indigo-400",
};

export function ActivityList({ items }: { items: ActivityItem[] }) {
  return (
    <ul className="space-y-3">
      {items.map((it) => (
        <li key={it.id} className="flex items-start gap-3">
          <span className="relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-semibold text-indigo-700">
            {initials(it.name)}
            <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white ${DOT[it.tone]}`} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-slate-800">{it.name}</span>
            <span className="block text-[11px] leading-snug text-slate-500">{it.text}</span>
          </span>
          <span className="shrink-0 text-[10px] text-slate-400 tabular-nums">{timeOf(it.at)}</span>
        </li>
      ))}
    </ul>
  );
}

export function EventsList({ holidays, today }: { holidays: Holiday[]; today: string }) {
  return (
    <ul className="space-y-2">
      {holidays.map((h) => {
        const left = Math.round((parseDay(h.date).getTime() - parseDay(today).getTime()) / 86_400_000);
        return (
          <li key={h.id} className="flex items-center gap-3 rounded-xl bg-[#F3F7F6] px-3 py-2.5">
            <span className="flex h-9 w-9 shrink-0 flex-col items-center justify-center rounded-lg bg-white text-indigo-600 shadow-sm">
              <span className="text-[9px] font-medium uppercase leading-none text-slate-400">
                {parseDay(h.date).toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" })}
              </span>
              <span className="text-sm font-bold leading-tight tabular-nums">{parseDay(h.date).getUTCDate()}</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-slate-800">{h.name}</span>
              <span className="block text-[11px] text-slate-400">
                {left === 0 ? "Today" : left === 1 ? "Tomorrow" : `In ${left} days`} · {fmtDay(h.date)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// --- performance table -------------------------------------------------------------

export function PerformanceTable({ people }: { people: Person[] }) {
  // Grouped by team (people without one go last). Order inside a team is kept as the report sent it.
  const groups = new Map<string, Person[]>();
  for (const p of people) {
    const key = p.teamName?.trim() || "No team";
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const ordered = Array.from(groups.entries()).sort(([a], [b]) => (a === "No team" ? 1 : b === "No team" ? -1 : a.localeCompare(b)));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-[13px]">
        <thead>
          <tr className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
            <th className="px-3 pb-3">Employee</th>
            <th className="px-3 pb-3 text-right">Present</th>
            <th className="px-3 pb-3 text-right" title="Days the company was using the tracker and this person did not clock in">Absent</th>
            <th className="px-3 pb-3 text-right">Productive</th>
            <th className="px-3 pb-3 text-right">Break</th>
            <th className="px-3 pb-3">Productivity</th>
            <th className="px-3 pb-3 text-right">Tasks</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(([team, members]) => (
            <Fragment key={team}>
              <tr>
                <td colSpan={7} className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-indigo-600">
                  {team} <span className="font-normal normal-case text-slate-400">· {members.length} {members.length === 1 ? "person" : "people"}</span>
                </td>
              </tr>
              {members.map((p, i) => {
            const bar = Math.min(100, Math.round((p.attainment || 0) * 100));
            return (
              <tr key={p.userId} className={i % 2 === 0 ? "bg-[#F5F8F7]" : ""}>
                <td className="rounded-l-xl px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-semibold text-indigo-700">
                      {initials(p.name)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-slate-800">{p.name}</span>
                      <span className="block truncate text-[11px] text-slate-400">
                        {p.designation ?? roleLabel(p.role)}
                        {p.employeeCode ? ` · ${p.employeeCode}` : ""}
                        {p.role === "MANAGER" && <span className="ml-1.5 rounded-full bg-[#E7F6F1] px-1.5 py-0.5 text-[10px] font-medium text-indigo-700" title="Attendance is shown, but managers are left out of the team productivity figures">manager</span>}
                      </span>
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                  {p.daysPresent}
                  <span className="text-slate-300"> / {p.daysExpected}</span>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                  {p.daysAbsent}
                  {(p.daysNotTracked ?? 0) > 0 && <span className="block text-[10px] text-slate-400" title="Nobody in the company clocked in on these days, so they are not counted as absent">{p.daysNotTracked} not tracked</span>}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{hm(p.productiveSeconds)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{p.breakSeconds === undefined ? "—" : hm(p.breakSeconds)}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-indigo-100">
                      <span className="block h-full rounded-full bg-indigo-600" style={{ width: `${bar}%` }} />
                    </span>
                    <span className="w-10 text-[12px] font-medium tabular-nums text-slate-700">{pct(p.attainment)}</span>
                  </div>
                </td>
                <td className="rounded-r-xl px-3 py-2.5 text-right tabular-nums text-slate-700">
                  {p.tasksDone}
                  <span className="text-slate-300"> / {p.tasksTotal}</span>
                </td>
              </tr>
            );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
