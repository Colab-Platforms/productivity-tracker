"use client";

// Reusable dashboard building blocks (StaffX-style): compact KPI cards, titled panels, the employee status table, an events list and the
// anniversary / birthday cards. They are display only: every figure and row is handed in by the page from the existing API responses, so
// nothing here fetches data or invents any. Colours come from the design tokens in globals.css (light and dark).
import Link from "next/link";
import type { ReactNode } from "react";
import Avatar from "../_photos/Avatar";
import { upcomingAnniversaries, type Anniversary } from "./anniversaries";

export { upcomingAnniversaries };
export type { Anniversary };

const PANEL = "rounded-2xl bg-[var(--card)] shadow-[var(--shadow-card)]";

// ---- KPI card ------------------------------------------------------------------------------------------------------------------------
const KPI_TONE: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-700",
  rose: "bg-rose-50 text-rose-600",
  sky: "bg-sky-50 text-sky-600",
  amber: "bg-amber-50 text-amber-600",
  violet: "bg-violet-50 text-violet-600",
  slate: "bg-slate-100 text-slate-600",
};

export function KpiCard({ label, value, sub, tone = "green", icon, href, loading }: { label: string; value: string; sub?: string; tone?: keyof typeof KPI_TONE; icon: ReactNode; href?: string; loading?: boolean }) {
  const body = (
    <div className={`${PANEL} flex items-center gap-3 p-3.5 ${href ? "transition hover:shadow-[var(--shadow-lift)]" : ""}`}>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${KPI_TONE[tone]}`}>{icon}</span>
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium text-[var(--text-secondary)]">{label}</p>
        {loading ? (
          <div className="skeleton mt-1 h-6 w-14" />
        ) : (
          <p className="text-[22px] font-bold leading-tight tracking-tight text-slate-900 tabular-nums">{value}</p>
        )}
        {sub && !loading && <p className="truncate text-[11px] text-[var(--text-secondary)]">{sub}</p>}
      </div>
    </div>
  );
  return href ? <Link href={href} className="block focus-visible:outline-2">{body}</Link> : body;
}

// ---- Panel (titled card) -------------------------------------------------------------------------------------------------------------
export function Panel({ title, sub, action, children, className = "", id }: { title: string; sub?: string; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`${PANEL} p-4 ${className}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-[14px] font-semibold text-slate-900">{title}</h2>
          {sub && <p className="mt-0.5 truncate text-[11px] text-[var(--text-secondary)]">{sub}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export const panelLink = "rounded-lg bg-[var(--brand-50)] px-2.5 py-1 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100";

// ---- Employee status table -----------------------------------------------------------------------------------------------------------
export type StatusRow = {
  id: string;
  name: string;
  code: string | null;
  photoAt?: string | null;
  designation: string | null;
  department: string;
  status: string; // employment status as stored: ACTIVE, INVITED, SUSPENDED, EXITED
  attendance: string; // today's attendance, worked out from the report
};

const STATUS_CHIP: Record<string, string> = {
  ACTIVE: "bg-emerald-50 text-emerald-700",
  INVITED: "bg-amber-50 text-amber-700",
  SUSPENDED: "bg-rose-50 text-rose-700",
  EXITED: "bg-slate-100 text-slate-600",
};
const ATT_CHIP: Record<string, string> = {
  Present: "bg-emerald-50 text-emerald-700",
  Absent: "bg-rose-50 text-rose-700",
  "On leave": "bg-sky-50 text-sky-700",
};
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

export function EmployeeStatusTable({ rows }: { rows: StatusRow[] }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-[var(--border)] text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
            <th className="py-2 pr-3 font-medium">Employee</th>
            <th className="px-3 py-2 font-medium">ID</th>
            <th className="px-3 py-2 font-medium">Department</th>
            <th className="px-3 py-2 font-medium">Job role</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Today</th>
            <th className="py-2 pl-3 text-right font-medium">View</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--nav-hover)]">
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2.5">
                  <Avatar userId={r.id} name={r.name} photoAt={r.photoAt} size={28} />
                  <span className="max-w-[11rem] truncate font-medium text-slate-900">{r.name}</span>
                </div>
              </td>
              <td className="px-3 py-2 tabular-nums text-slate-600">{r.code ?? "—"}</td>
              <td className="max-w-[10rem] truncate px-3 py-2 text-slate-600" title={r.department}>{r.department || "—"}</td>
              <td className="max-w-[10rem] truncate px-3 py-2 text-slate-600" title={r.designation ?? ""}>{r.designation || "—"}</td>
              <td className="px-3 py-2"><span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${STATUS_CHIP[r.status] ?? "bg-slate-100 text-slate-600"}`}>{label(r.status)}</span></td>
              <td className="px-3 py-2"><span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${ATT_CHIP[r.attendance] ?? "bg-slate-100 text-slate-500"}`}>{r.attendance}</span></td>
              <td className="py-2 pl-3 text-right">
                <Link href={`/dashboard/employees?q=${encodeURIComponent(r.code ?? r.name)}`} aria-label={`View ${r.name}`} className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-500 hover:bg-[var(--brand-50)] hover:text-indigo-600">
                  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M1.8 10S5 4.5 10 4.5 18.2 10 18.2 10 15 15.5 10 15.5 1.8 10 1.8 10Z" strokeLinejoin="round" /><circle cx="10" cy="10" r="2.3" /></svg>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Events and meetings -------------------------------------------------------------------------------------------------------------
export type EventItem = { id: string; date: string; time?: string; title: string; kind: "Holiday" | "Meeting"; href: string; today: boolean };

const monthShort = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
const dayNum = (iso: string) => String(Number(iso.slice(8, 10)));

export function EventsList({ items }: { items: EventItem[] }) {
  return (
    <ul className="divide-y divide-[var(--border)]">
      {items.map((e) => (
        <li key={e.id}>
          <Link href={e.href} className="flex items-center gap-3 py-2.5 hover:opacity-90">
            <span className={`flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl leading-none ${e.today ? "bg-indigo-600 text-white" : "bg-[var(--brand-50)] text-indigo-700"}`}>
              <span className="text-[9px] font-semibold uppercase">{monthShort(e.date)}</span>
              <span className="mt-0.5 text-[15px] font-bold">{dayNum(e.date)}</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-slate-900">{e.title}</span>
              <span className="block truncate text-[11px] text-[var(--text-secondary)]">{e.kind}{e.time ? ` · ${e.time}` : ""}{e.today ? " · today" : ""}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ---- Anniversaries -------------------------------------------------------------------------------------------------------------------
export function AnniversaryList({ items }: { items: Anniversary[] }) {
  return (
    <ul className="space-y-2.5">
      {items.map((a) => (
        <li key={a.id} className="flex items-center gap-3">
          <Avatar userId={a.id} name={a.name} photoAt={a.photoAt} size={32} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-slate-900">{a.name}</p>
            <p className="truncate text-[11px] text-[var(--text-secondary)]">{a.years} {a.years === 1 ? "year" : "years"}{a.designation ? ` · ${a.designation}` : ""}</p>
          </div>
          <span className="shrink-0 rounded-md bg-[var(--brand-50)] px-2 py-0.5 text-[11px] font-medium text-indigo-700">{a.inDays === 0 ? "Today" : `${monthShort(a.date)} ${dayNum(a.date)}`}</span>
        </li>
      ))}
    </ul>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-[var(--background)] px-3 py-4 text-center text-xs text-[var(--text-secondary)]">{children}</p>;
}
