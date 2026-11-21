"use client";

// ---------------------------------------------------------------------------
// BREAK MANAGEMENT (Admin only). Reads GET /break-monitor (one read-only answer; rules on the server in break-monitor/breakMonitor.logic.ts):
// every break with its exact start / end, its duration, the daily Break Time and the excess; who is on a break now; weekly and monthly defaulters.
// Monitoring only: nothing here changes a break, attendance, productive time or pay. Cards are whole-card buttons whose number is the length of
// the list they show. Exports are built from the same answer, so a download holds exactly what the filters show.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import FilterBar from "../_filters/FilterBar";
import { filterQuery, useFilterOptions, useHrFilters } from "../_filters/useHrFilters";
import { KpiCard, Panel } from "../_dashboard/widgets";
import { Modal } from "../_employees/Modal";
import { addDays, rangeFor, type Preset } from "../reports/_team/ranges";
import { downloadCsv } from "../reports/_team/format";
import { downloadReportXlsx, type Col } from "../reports/_team/reportXlsx";

type Person = { name: string; employeeCode: string | null; company: string; department: string | null; designation: string | null; manager: string | null; allowanceMinutes: number | null; allowanceSource: "TEAM" | "COMPANY" | null };
type Brk = { id: string; userId: string; day: string; breakType: string; startedAt: string; endedAt: string | null; seconds: number; open: boolean; allowanceSeconds: number | null; excessSeconds: number | null; status: "ACTIVE" | "COMPLETED" | "EXCEEDED"; correctedDurationSeconds?: number | null };
type Day = { userId: string; day: string; breaks: number; seconds: number; allowanceSeconds: number | null; excessSeconds: number | null; exceeded: boolean; open: boolean };
type Agg = { userId: string; breaks: number; seconds: number; daysPresent: number; daysWithBreaks: number; permittedSeconds: number | null; excessSeconds: number | null; daysExceeded: number; incidents: number; avgDailySeconds: number | null; configured: boolean; defaulter: boolean; violations: Violation[] };
type Violation = { day: string; allowanceSeconds: number; actualSeconds: number; excessSeconds: number };
const violationText = (v: Violation) => `${dayLabel(v.day)}: ${dur(v.actualSeconds)} of ${dur(v.allowanceSeconds)} (+${dur(v.excessSeconds)})`;
type Summary = { employeesWithBreaks: string[]; currentlyOnBreak: string[]; breaksToday: number; breaksTodayIds: string[]; avgBreakSeconds: number | null; completedBreaks: number; exceeding: string[]; weeklyDefaulters: string[]; monthlyDefaulters: string[] };
type Res = { generatedAt: string; timezone: string; today: string; from: string; to: string; week: { from: string; to: string }; month: { from: string; to: string }; scope: { orgTotal: number; filteredTotal: number }; people: Record<string, Person>; breaks: Brk[]; days: Day[]; range: Agg[]; weekly: Agg[]; monthly: Agg[]; summary: Summary; capped: boolean };

const PRESET_LIST: [Preset, string][] = [["today", "Today"], ["yesterday", "Yesterday"], ["thisweek", "This week"], ["lastweek", "Last week"], ["thismonth", "This month"], ["lastmonth", "Last month"], ["custom", "Custom range"]];
const TYPE_LABEL: Record<string, string> = { LUNCH: "Lunch", PERSONAL: "Personal", OTHER: "Other", TEA: "Tea (older records)" };
const STATUS_LABEL: Record<string, string> = { ACTIVE: "Currently on break", COMPLETED: "Completed", EXCEEDED: "Exceeded" };
const STATUS_CHIP: Record<string, string> = { ACTIVE: "bg-sky-50 text-sky-700", COMPLETED: "bg-emerald-50 text-emerald-700", EXCEEDED: "bg-rose-50 text-rose-700" };
const PAGE = 50;

/** "1h 05m", "12m 30s". Never negative. */
export function dur(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(sec).padStart(2, "0")}s`;
}
const clock = (isoTs: string | null, tz: string) => (isoTs ? new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(isoTs)) : "");
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

type CardKey = "people" | "onbreak" | "today" | "avg" | "exceeding" | "weekly" | "monthly";
type Tab = "activity" | "weekly" | "monthly";

export default function BreakManagement() {
  const { filters, update, clear, ready } = useHrFilters();
  const { options } = useFilterOptions(filters, update, ready, true);
  const [preset, setPreset] = useState<Preset>("today");
  const [cFrom, setCFrom] = useState("");
  const [cTo, setCTo] = useState("");
  const [breakType, setBreakType] = useState("");
  const [status, setStatus] = useState("");
  const [defaulter, setDefaulter] = useState("");
  const [tab, setTab] = useState<Tab>("activity");
  const [card, setCard] = useState<CardKey | null>(null);
  const [page, setPage] = useState(1);
  const [res, setRes] = useState<Res | null>(null);
  const [error, setError] = useState("");
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const today = res?.today ?? new Date().toISOString().slice(0, 10);
  const range = preset === "custom" ? (cFrom && cTo && cFrom <= cTo ? { from: cFrom, to: cTo } : null) : rangeFor(preset, today);
  const qs = useMemo(() => {
    if (!range) return null;
    const p = new URLSearchParams(filterQuery(filters));
    p.set("from", range.from);
    p.set("to", range.to);
    if (breakType) p.set("breakType", breakType);
    if (status) p.set("status", status);
    if (defaulter) p.set("defaulter", defaulter);
    return p.toString();
  }, [filters, range?.from, range?.to, breakType, status, defaulter]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!ready || !qs) return;
    try {
      setRes(await apiGet<Res>(`/break-monitor?${qs}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [qs, ready]);
  useEffect(() => { void load(); setPage(1); }, [load]);
  // While today is in view, refresh every 30 s and tick the running breaks every second (no end time is invented: the elapsed time grows).
  const live = !!range && range.to >= today;
  useEffect(() => { if (!live) return; const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, [live, load]);
  useEffect(() => { if (!live) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [live]);
  const drift = res ? Math.max(0, (now - Date.parse(res.generatedAt)) / 1000) : 0;
  const secsOf = (b: Brk) => (b.open ? b.seconds + drift : b.seconds);

  const s = res?.summary;
  const tz = res?.timezone ?? "Asia/Kolkata";
  const P = (id: string) => res?.people[id];
  const cardRows = useMemo(() => {
    if (!res) return [];
    const ids = (list: string[]) => new Set(list);
    if (card === "onbreak") return res.breaks.filter((b) => b.open && b.day === res.today);
    if (card === "today") return res.breaks.filter((b) => b.day === res.today);
    if (card === "avg") return res.breaks.filter((b) => !b.open);
    if (card === "people") { const k = ids(res.summary.employeesWithBreaks); return res.breaks.filter((b) => k.has(b.userId)); }
    if (card === "exceeding") { const k = ids(res.summary.exceeding); return res.breaks.filter((b) => k.has(b.userId)); }
    return res.breaks;
  }, [res, card]);
  const peopleOfCard = useMemo(() => {
    if (!res || !card) return null;
    const map: Partial<Record<CardKey, string[]>> = { people: res.summary.employeesWithBreaks, onbreak: res.summary.currentlyOnBreak, exceeding: res.summary.exceeding };
    return map[card] ?? null;
  }, [res, card]);
  const pages = Math.max(1, Math.ceil(cardRows.length / PAGE));
  const shown = cardRows.slice((Math.min(page, pages) - 1) * PAGE, Math.min(page, pages) * PAGE);

  const pick = (k: CardKey) => {
    if (card === k) { setCard(null); return; }
    setCard(k);
    setPage(1);
    setTab(k === "weekly" ? "weekly" : k === "monthly" ? "monthly" : "activity");
  };
  const clearAll = () => { clear(); setBreakType(""); setStatus(""); setDefaulter(""); setCard(null); setPage(1); };

  // ---- exports (same data as the screen) ----
  const periodText = res ? (res.from === res.to ? dayLabel(res.from) : `${dayLabel(res.from)} to ${dayLabel(res.to)}`) : "";
  const breakCsvRows = (list: Brk[]) => list.map((b) => { const p = P(b.userId); return [p?.name, p?.employeeCode, p?.company, p?.department, p?.manager, b.day, TYPE_LABEL[b.breakType] ?? b.breakType, clock(b.startedAt, tz), b.open ? "" : clock(b.endedAt, tz), dur(secsOf(b)), dur(b.allowanceSeconds), b.excessSeconds === null ? "Not configured" : dur(b.excessSeconds), STATUS_LABEL[b.status]]; });
  const BREAK_HEADER = ["Employee", "Employee ID", "Company", "Department", "Reporting manager", "Break date", "Break type", "Start", "End", "Duration", "Daily Break Time", "Excess (beyond Break Time)", "Status"];
  const aggRows = (list: Agg[]) => list.map((a) => { const p = P(a.userId); return [p?.name ?? "", p?.employeeCode ?? "", p?.company ?? "", p?.department ?? "", p?.manager ?? "", a.breaks, Math.round(a.seconds), a.permittedSeconds, a.excessSeconds, a.daysPresent, a.daysExceeded, a.incidents, a.avgDailySeconds, a.configured ? (a.defaulter ? "Defaulter" : "Within Break Time") : "Not configured", a.violations.map(violationText).join("; ") || ""]; });
  const AGG_COLS: Col[] = [{ header: "Employee", width: 24 }, { header: "Employee ID", width: 13 }, { header: "Company", width: 22 }, { header: "Department", width: 20 }, { header: "Reporting manager", width: 22 }, { header: "Breaks", kind: "int" }, { header: "Total break", kind: "duration" }, { header: "Permitted (Break Time x days present)", kind: "duration", width: 16 }, { header: "Total excess", kind: "duration" }, { header: "Days present", kind: "int" }, { header: "Days over Break Time", kind: "int" }, { header: "Excess incidents", kind: "int" }, { header: "Average daily break", kind: "duration" }, { header: "Result", width: 18 }, { header: "Days over Break Time (date: actual of allowed, +excess)", width: 60, wrap: true }];
  async function exportXlsx() {
    if (!res) return;
    const cols: Col[] = [{ header: "Employee", width: 24 }, { header: "Employee ID", width: 13 }, { header: "Company", width: 22 }, { header: "Department", width: 20 }, { header: "Reporting manager", width: 22 }, { header: "Break date", kind: "date" }, { header: "Break type" }, { header: "Start", kind: "time" }, { header: "End", kind: "time" }, { header: "Duration", kind: "duration" }, { header: "Daily Break Time", kind: "duration" }, { header: "Excess", kind: "duration" }, { header: "Status", width: 18 }];
    const secOfDay = (isoTs: string | null) => { if (!isoTs) return null; const [h, m, sec] = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(isoTs)).split(":").map(Number); return (h % 24) * 3600 + m * 60 + sec; };
    const rows = cardRows.map((b) => { const p = P(b.userId); return [p?.name ?? "", p?.employeeCode ?? "", p?.company ?? "", p?.department ?? "", p?.manager ?? "", b.day, TYPE_LABEL[b.breakType] ?? b.breakType, secOfDay(b.startedAt), b.open ? null : secOfDay(b.endedAt), Math.round(secsOf(b)), b.allowanceSeconds, b.excessSeconds === null ? "Not configured" : b.excessSeconds, STATUS_LABEL[b.status]]; });
    const dayCols: Col[] = [{ header: "Employee", width: 24 }, { header: "Employee ID", width: 13 }, { header: "Date", kind: "date" }, { header: "Breaks", kind: "int" }, { header: "Total break", kind: "duration" }, { header: "Daily Break Time", kind: "duration" }, { header: "Excess", kind: "duration" }, { header: "Over Break Time", width: 14 }];
    const dayRows = res.days.map((d) => [P(d.userId)?.name ?? "", P(d.userId)?.employeeCode ?? "", d.day, d.breaks, Math.round(d.seconds), d.allowanceSeconds, d.excessSeconds === null ? "Not configured" : d.excessSeconds, d.allowanceSeconds === null ? "Not configured" : d.exceeded ? "Yes" : "No"]);
    await downloadReportXlsx(`break-management-${res.from}_to_${res.to}.xlsx`, [
      { name: "Break activity", cols, rows },
      { name: "Daily totals", cols: dayCols, rows: dayRows },
      { name: "Period summary", cols: AGG_COLS, rows: aggRows(res.range) },
      { name: `Week ${res.week.from}`, cols: AGG_COLS, rows: aggRows(res.weekly) },
      { name: `Month ${res.month.from.slice(0, 7)}`, cols: AGG_COLS, rows: aggRows(res.monthly) },
      { name: "Defaulters", cols: AGG_COLS, rows: aggRows(res.monthly.filter((a) => a.defaulter)) },
      // one row per violation day of the month: the exact date, the allowance, the actual break total and the excess
      { name: "Violation days", cols: [{ header: "Employee", width: 24 }, { header: "Employee ID", width: 13 }, { header: "Company", width: 22 }, { header: "Reporting manager", width: 22 }, { header: "Date", kind: "date" }, { header: "Break Time (allowed)", kind: "duration" }, { header: "Actual break", kind: "duration" }, { header: "Excess", kind: "duration" }], rows: res.monthly.flatMap((a) => a.violations.map((v) => [P(a.userId)?.name ?? "", P(a.userId)?.employeeCode ?? "", P(a.userId)?.company ?? "", P(a.userId)?.manager ?? "", v.day, v.allowanceSeconds, v.actualSeconds, v.excessSeconds])) },
    ], {
      report: "Break Management",
      period: periodText,
      filters: [["Break type", breakType ? TYPE_LABEL[breakType] : "All"], ["Status", status ? STATUS_LABEL[status] : "All"], ["Defaulters", defaulter === "yes" ? "Defaulters only" : defaulter === "no" ? "Non-defaulters only" : "All"], ["Card", card ?? "None"]],
      exportedAt: new Date(), exportedBy: null, timezone: tz,
      totals: [["Breaks", rows.length], ["Employees with breaks", s?.employeesWithBreaks.length ?? 0], ["Weekly defaulters", s?.weeklyDefaulters.length ?? 0], ["Monthly defaulters", s?.monthlyDefaulters.length ?? 0]],
    });
  }

  const tabAgg = tab === "weekly" ? res?.weekly ?? [] : tab === "monthly" ? res?.monthly ?? [] : [];
  const tabRows = (card === "weekly" || card === "monthly" || defaulter === "yes" ? tabAgg.filter((a) => a.defaulter) : tabAgg).sort((a, b) => (b.excessSeconds ?? -1) - (a.excessSeconds ?? -1) || b.seconds - a.seconds);
  const moveWeek = (n: number) => { if (!res) return; const f = addDays(res.week.from, 7 * n); setPreset("custom"); setCFrom(f); setCTo(addDays(f, 6)); };
  const moveMonth = (n: number) => { if (!res) return; const [y, m] = res.month.from.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); const f = d.toISOString().slice(0, 10); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); setPreset("custom"); setCFrom(f); setCTo(t); };

  const control = "h-9 rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-800";
  return (
    <div className="space-y-5" data-testid="break-management">
      <p className="text-sm text-slate-500">Every break with its exact start and end, against each person&apos;s daily Break Time. Monitoring only: nothing here changes attendance, productive time or pay.</p>

      <div className="flex flex-wrap items-end gap-2">
        <div role="group" aria-label="Period" className="flex flex-wrap gap-1.5">
          {PRESET_LIST.map(([k, label]) => (
            <button key={k} type="button" data-testid={`preset-${k}`} aria-pressed={preset === k} onClick={() => { setPreset(k); setCard(null); }} className={`h-9 rounded-xl border px-3 text-sm font-medium ${preset === k ? "border-indigo-600 bg-indigo-600 text-white" : "border-indigo-100 bg-white text-slate-600 hover:bg-[var(--brand-50)]"}`}>{label}</button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" aria-label="From" value={cFrom} max={today} onChange={(e) => setCFrom(e.target.value)} className={control} />
            <span className="text-slate-400">to</span>
            <input type="date" aria-label="To" value={cTo} max={today} onChange={(e) => setCTo(e.target.value)} className={control} />
          </div>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" disabled={!res} onClick={() => res && downloadCsv(`break-activity-${res.from}_to_${res.to}.csv`, BREAK_HEADER, breakCsvRows(cardRows))} className="h-9 rounded-xl border border-indigo-200 bg-white px-3 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-40">Export CSV</button>
          <button type="button" disabled={!res} data-testid="export-xlsx" onClick={() => void exportXlsx()} className="h-9 rounded-xl bg-indigo-600 px-3 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Export Excel</button>
        </div>
      </div>

      <FilterBar
        filters={filters}
        update={update}
        clear={clearAll}
        options={options}
        show={{ search: true, company: true, project: true, manager: true, department: true }}
        counts={res?.scope ? { filtered: res.scope.filteredTotal, total: res.scope.orgTotal } : null}
        extraActive={(breakType ? 1 : 0) + (status ? 1 : 0) + (defaulter ? 1 : 0)}
        extra={
          <>
            <div className="w-40"><label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400" htmlFor="bm-type">Break type</label>
              <select id="bm-type" value={breakType} onChange={(e) => setBreakType(e.target.value)} className={`${control} w-full`}><option value="">All</option>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="w-44"><label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400" htmlFor="bm-status">Break status</label>
              <select id="bm-status" value={status} onChange={(e) => setStatus(e.target.value)} className={`${control} w-full`}><option value="">All</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="w-44"><label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400" htmlFor="bm-dflt">Defaulter status</label>
              <select id="bm-dflt" value={defaulter} onChange={(e) => setDefaulter(e.target.value)} className={`${control} w-full`}><option value="">All</option><option value="yes">Defaulters</option><option value="no">Within Break Time</option></select></div>
          </>
        }
      />

      {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
      {!range && <p className="text-sm text-amber-700">Choose both dates (the end not before the start).</p>}

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-4 min-[1800px]:grid-cols-7">
        {([
          ["people", "Employees with break activity", s?.employeesWithBreaks.length, "in the period", "green"],
          ["onbreak", "Currently on break", s?.currentlyOnBreak.length, "right now", "sky"],
          ["today", "Total breaks today", s?.breaksToday, "breaks started today", "violet"],
          ["avg", "Average break duration", s ? dur(s.avgBreakSeconds) : undefined, s ? `of ${s.completedBreaks} completed breaks` : "", "slate"],
          ["exceeding", "Employees exceeding Break Time", s?.exceeding.length, "at least one day over", "rose"],
          ["weekly", "Weekly defaulters", s?.weeklyDefaulters.length, res ? `week of ${dayLabel(res.week.from)}` : "", "amber"],
          ["monthly", "Monthly defaulters", s?.monthlyDefaulters.length, res ? new Date(`${res.month.from}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) : "", "amber"],
        ] as [CardKey, string, number | string | undefined, string, "green" | "sky" | "violet" | "slate" | "rose" | "amber"][]).map(([k, label, v, sub, tone]) => (
          <div key={k} data-testid={`bm-card-${k}`}>
            <KpiCard label={label} value={v === undefined ? "…" : String(v)} sub={sub} tone={tone} loading={!res && !error} icon={<span className="text-sm font-bold">{label.charAt(0)}</span>} onClick={() => pick(k)} selected={card === k} />
          </div>
        ))}
      </section>

      <div role="tablist" aria-label="View" className="flex flex-wrap gap-1.5">
        {([["activity", "Break activity"], ["weekly", "Weekly defaulters"], ["monthly", "Monthly defaulters"]] as [Tab, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" data-testid={`tab-${k}`} onClick={() => setTab(k)} className={`h-9 rounded-xl px-4 text-sm font-medium ${tab === k ? "bg-indigo-600 text-white" : "bg-white text-slate-600 shadow-[var(--shadow-card)] hover:bg-[var(--brand-50)]"}`}>{label}</button>
        ))}
      </div>

      {card && (
        <p className="text-xs text-slate-500" data-testid="card-note">
          Showing what <span className="font-medium text-slate-700">{card === "people" ? "Employees with break activity" : card === "onbreak" ? "Currently on break" : card === "today" ? "Total breaks today" : card === "avg" ? "Average break duration (completed breaks)" : card === "exceeding" ? "Employees exceeding Break Time" : card === "weekly" ? "Weekly defaulters" : "Monthly defaulters"}</span> counts.{" "}
          <button type="button" data-testid="card-clear" onClick={() => setCard(null)} className="font-medium text-indigo-700 hover:underline">Close</button>
        </p>
      )}

      {tab === "activity" && peopleOfCard && res && (
        <Panel title={`${peopleOfCard.length} ${peopleOfCard.length === 1 ? "employee" : "employees"}`} sub="Click a name for the full break history">
          {peopleOfCard.length === 0 ? <p className="py-4 text-center text-sm text-slate-400">Nobody in this card for the period and filters.</p> : (
            <ul data-testid="card-people" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {peopleOfCard.map((id) => { const p = P(id); const agg = res.range.find((a) => a.userId === id); return (
                <li key={id}><button type="button" onClick={() => setOpenUser(id)} className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-left hover:bg-[var(--brand-50)]">
                  <span className="block truncate font-medium text-slate-900">{p?.name}</span>
                  <span className="block truncate text-xs text-slate-500">{p?.employeeCode ?? "No ID"} · {p?.company}{p?.manager ? ` · ${p.manager}` : ""}</span>
                  {agg && <span className="block text-xs text-slate-500">{agg.breaks} breaks · {dur(agg.seconds)}{agg.excessSeconds ? ` · ${dur(agg.excessSeconds)} over` : ""}</span>}
                </button></li>
              ); })}
            </ul>
          )}
        </Panel>
      )}

      {tab === "activity" && (
        <Panel title="Break activity" sub={res ? `${cardRows.length} ${cardRows.length === 1 ? "break" : "breaks"} · ${periodText}${res.capped ? " · showing the newest 5,000" : ""}` : "Loading…"}>
          <div className="overflow-x-auto">
            <table data-testid="break-table" className="w-full min-w-[1100px] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-400">
                <tr className="border-b border-indigo-50">{["Employee", "Company", "Department", "Reporting manager", "Date", "Type", "Start", "End", "Duration", "Break Time", "Excess", "Status"].map((h) => <th key={h} className="px-2 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-indigo-50">
                {res && shown.length === 0 && <tr><td colSpan={12} className="px-2 py-8 text-center text-slate-400">No breaks for this period and these filters.</td></tr>}
                {shown.map((b) => { const p = P(b.userId); return (
                  <tr key={b.id}>
                    <td className="px-2 py-2"><button type="button" onClick={() => setOpenUser(b.userId)} className="text-left font-medium text-indigo-700 hover:underline">{p?.name}</button><span className="block text-xs text-slate-400">{p?.employeeCode ?? "No ID"}</span></td>
                    <td className="px-2 py-2 text-slate-600">{p?.company}</td>
                    <td className="px-2 py-2 text-slate-600">{p?.department ?? "—"}</td>
                    <td className="px-2 py-2 text-slate-600">{p?.manager ?? "—"}</td>
                    <td className="px-2 py-2 text-slate-600">{dayLabel(b.day)}</td>
                    <td className="px-2 py-2 text-slate-600">{TYPE_LABEL[b.breakType] ?? b.breakType}</td>
                    <td className="px-2 py-2 tabular-nums text-slate-700">{clock(b.startedAt, tz)}</td>
                    <td className="px-2 py-2 tabular-nums text-slate-700">{b.open ? <span className="text-sky-700">running</span> : clock(b.endedAt, tz)}</td>
                    <td className="px-2 py-2 tabular-nums font-medium text-slate-900">{dur(secsOf(b))}{b.correctedDurationSeconds != null && <span className="ml-1 text-[10px] text-slate-400" title="Duration corrected by an Admin">corrected</span>}</td>
                    <td className="px-2 py-2 tabular-nums text-slate-600">{b.allowanceSeconds === null ? <span className="text-slate-400">Not configured</span> : `${dur(b.allowanceSeconds)} / day`}</td>
                    <td className="px-2 py-2 tabular-nums">{b.excessSeconds === null ? <span className="text-slate-400">—</span> : b.excessSeconds > 0 ? <span className="font-medium text-rose-700">{dur(b.excessSeconds)}</span> : <span className="text-slate-400">0</span>}</td>
                    <td className="px-2 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CHIP[b.status]}`}>{STATUS_LABEL[b.status]}</span></td>
                  </tr>
                ); })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
              <span>Page {Math.min(page, pages)} of {pages}</span>
              <div className="flex gap-2">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="h-9 rounded-xl border border-indigo-100 px-3 font-medium text-slate-700 disabled:opacity-40">Previous</button>
                <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)} className="h-9 rounded-xl border border-indigo-100 px-3 font-medium text-slate-700 disabled:opacity-40">Next</button>
              </div>
            </div>
          )}
        </Panel>
      )}

      {(tab === "weekly" || tab === "monthly") && res && (
        <Panel
          title={tab === "weekly" ? `Week ${dayLabel(res.week.from)} to ${dayLabel(res.week.to)}` : new Date(`${res.month.from}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}
          sub={`${tabRows.length} ${card === tab || defaulter === "yes" ? "defaulters" : "employees"} · a defaulter went over their daily Break Time on at least one day (checked day by day; one day is enough)`}
          action={<div className="flex gap-1.5"><button type="button" onClick={() => (tab === "weekly" ? moveWeek(-1) : moveMonth(-1))} className="h-8 rounded-lg border border-indigo-100 px-2.5 text-xs">◀ Previous</button><button type="button" onClick={() => (tab === "weekly" ? moveWeek(1) : moveMonth(1))} className="h-8 rounded-lg border border-indigo-100 px-2.5 text-xs">Next ▶</button></div>}
        >
          <div className="overflow-x-auto">
            <table data-testid="defaulter-table" className="w-full min-w-[1000px] text-left text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-slate-400"><tr className="border-b border-indigo-50">{["Employee", "Company", "Department", "Reporting manager", "Breaks", "Total break", "Permitted", "Excess", "Days over", "Incidents", ...(tab === "monthly" ? ["Avg / day"] : []), "Result", "Dates over Break Time"].map((h) => <th key={h} className="px-2 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-indigo-50">
                {tabRows.length === 0 && <tr><td colSpan={12} className="px-2 py-8 text-center text-slate-400">Nobody for this period and these filters.</td></tr>}
                {tabRows.map((a) => { const p = P(a.userId); return (
                  <tr key={a.userId}>
                    <td className="px-2 py-2"><button type="button" onClick={() => setOpenUser(a.userId)} className="text-left font-medium text-indigo-700 hover:underline">{p?.name}</button><span className="block text-xs text-slate-400">{p?.employeeCode ?? "No ID"}</span></td>
                    <td className="px-2 py-2 text-slate-600">{p?.company}</td><td className="px-2 py-2 text-slate-600">{p?.department ?? "—"}</td><td className="px-2 py-2 text-slate-600">{p?.manager ?? "—"}</td>
                    <td className="px-2 py-2 tabular-nums">{a.breaks}</td><td className="px-2 py-2 tabular-nums">{dur(a.seconds)}</td><td className="px-2 py-2 tabular-nums">{a.configured ? dur(a.permittedSeconds) : "Not configured"}</td>
                    <td className="px-2 py-2 tabular-nums">{a.excessSeconds ? <span className="font-medium text-rose-700">{dur(a.excessSeconds)}</span> : "0"}</td>
                    <td className="px-2 py-2 tabular-nums">{a.daysExceeded}</td><td className="px-2 py-2 tabular-nums">{a.incidents}</td>
                    {tab === "monthly" && <td className="px-2 py-2 tabular-nums">{dur(a.avgDailySeconds)}</td>}
                    <td className="px-2 py-2">{!a.configured ? <span className="text-xs text-slate-400">Not configured</span> : a.defaulter ? <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">Defaulter</span> : <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Within Break Time</span>}</td>
                    <td className="px-2 py-2 text-xs text-slate-600" data-testid="violation-dates">{a.violations.length === 0 ? <span className="text-slate-400">—</span> : <ul className="space-y-0.5">{a.violations.map((v) => <li key={v.day} className="whitespace-nowrap"><span className="font-medium text-slate-800">{dayLabel(v.day)}</span>: {dur(v.actualSeconds)} of {dur(v.allowanceSeconds)} <span className="font-medium text-rose-700">+{dur(v.excessSeconds)}</span></li>)}</ul>}</td>
                  </tr>
                ); })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {openUser && res && <EmployeeBreaks userId={openUser} person={P(openUser)} defaultMonth={res.month} today={res.today} onClose={() => setOpenUser(null)} />}
    </div>
  );
}

/** One employee's break history: daily totals and every break for the chosen dates, with the week and month summaries. Read-only. */
function EmployeeBreaks({ userId, person, defaultMonth, today, onClose }: { userId: string; person?: Person; defaultMonth: { from: string; to: string }; today: string; onClose: () => void }) {
  const [from, setFrom] = useState(defaultMonth.from);
  const [to, setTo] = useState(defaultMonth.to < today ? defaultMonth.to : today);
  const [res, setRes] = useState<Res | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!from || !to || to < from) return;
    let live = true;
    apiGet<Res>(`/break-monitor?userId=${userId}&from=${from}&to=${to}`).then((r) => live && setRes(r)).catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
  }, [userId, from, to]);
  const tz = res?.timezone ?? "Asia/Kolkata";
  const p = res?.people[userId] ?? person;
  const line = (a?: Agg) => (a ? `${a.breaks} breaks · ${dur(a.seconds)} · permitted ${a.configured ? dur(a.permittedSeconds) : "not configured"} · excess ${dur(a.excessSeconds ?? 0)} · ${a.daysExceeded} day(s) over · ${a.incidents} incident(s)${a.violations.length ? ` · over on ${a.violations.map((v) => `${dayLabel(v.day)} (+${dur(v.excessSeconds)})`).join(", ")}` : ""}` : "No breaks");
  return (
    <Modal title={p ? `${p.name}: breaks` : "Breaks"} onClose={onClose} width="max-w-4xl" footer={<button type="button" onClick={onClose} className="h-10 rounded-xl border border-indigo-100 px-4 text-sm font-medium">Close</button>}>
      <div data-testid="employee-breaks" className="space-y-4">
        {p && <p className="text-sm text-slate-600">{p.employeeCode ?? "No ID"} · {p.company}{p.department ? ` · ${p.department}` : ""}{p.manager ? ` · reports to ${p.manager}` : ""} · Break Time {p.allowanceMinutes === null ? "not configured" : `${p.allowanceMinutes} min a day (${p.allowanceSource === "TEAM" ? "team setting" : "company setting"})`}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" aria-label="From" value={from} max={today} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-xl border border-indigo-100 px-3 text-sm" />
          <span className="text-slate-400">to</span>
          <input type="date" aria-label="To" value={to} max={today} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-xl border border-indigo-100 px-3 text-sm" />
          {res && <button type="button" onClick={() => downloadCsv(`breaks-${p?.employeeCode ?? userId}-${from}_to_${to}.csv`, ["Date", "Type", "Start", "End", "Duration", "Break Time", "Excess", "Status"], res.breaks.map((b) => [b.day, TYPE_LABEL[b.breakType] ?? b.breakType, clock(b.startedAt, tz), b.open ? "" : clock(b.endedAt, tz), dur(b.seconds), dur(b.allowanceSeconds), b.excessSeconds === null ? "Not configured" : dur(b.excessSeconds), STATUS_LABEL[b.status]]))} className="ml-auto h-9 rounded-xl border border-indigo-200 px-3 text-sm font-medium text-indigo-700">Download history (CSV)</button>}
        </div>
        {error && <p className="text-sm text-rose-700">{error}</p>}
        {res && (
          <>
            <div className="grid gap-2 sm:grid-cols-3 text-xs">
              <div className="rounded-xl bg-slate-50 p-3"><p className="font-semibold text-slate-700">Selected dates</p><p className="mt-1 text-slate-600">{line(res.range[0])}</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="font-semibold text-slate-700">Week of {dayLabel(res.week.from)}</p><p className="mt-1 text-slate-600">{line(res.weekly[0])}</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="font-semibold text-slate-700">{new Date(`${res.month.from}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}</p><p className="mt-1 text-slate-600">{line(res.monthly[0])}</p></div>
            </div>
            {res.days.length === 0 ? <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-400">No breaks in these dates.</p> : (
              <ul className="space-y-2">
                {res.days.map((d) => (
                  <li key={d.day} className="rounded-xl border border-indigo-50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium text-slate-900">{dayLabel(d.day)}</span><span className="tabular-nums text-slate-600">{d.breaks} breaks · {dur(d.seconds)}{d.allowanceSeconds !== null ? ` of ${dur(d.allowanceSeconds)}` : ""}{d.exceeded ? <span className="ml-2 font-medium text-rose-700">over by {dur(d.excessSeconds)}</span> : null}</span></div>
                    <ul className="mt-1.5 space-y-0.5 text-xs text-slate-600">
                      {res.breaks.filter((b) => b.day === d.day).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((b) => (
                        <li key={b.id} className="flex flex-wrap gap-x-3">{TYPE_LABEL[b.breakType] ?? b.breakType}: {clock(b.startedAt, tz)} to {b.open ? "now (running)" : clock(b.endedAt, tz)} · {dur(b.seconds)}{b.excessSeconds ? <span className="text-rose-700">· {dur(b.excessSeconds)} beyond Break Time</span> : null}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
