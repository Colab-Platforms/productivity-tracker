"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { todayIso } from "@/lib/time";
import { plural } from "@/lib/plural";
import { useMe } from "../../layout";
import { filterQuery, type Filters } from "../../_filters/useHrFilters";
import { describeFilters } from "./exportMeta";
import { dayLabel, downloadCsv } from "./format";
import { downloadReportXlsx } from "./reportXlsx";
import { addDays } from "./ranges";
import { allSheets, categorySheet, CATEGORIES, csvLines, oneEmployeeSheet, periodLabel, reportInfo, type CategoryKey, type TeamReportData } from "./teamReportBook";

// ---------------------------------------------------------------------------
// EXPORT REPORTS (Manager, and HR / Admin for the people they already see). One period, one list of people, one download:
//   - the complete team workbook: summary, attendance, task performance, meetings and huddles, break and working hours, leave and late remarks,
//     break details, attendance corrections, and one sheet per employee with every day of the period;
//   - one report on its own (Excel sheet or CSV), or one employee's full record.
// The data is ONE call (GET /team-attendance/team-report) for exactly the people the other reports show (the filter bar above narrows them), so
// every sheet agrees and nothing is cut by paging. The figures are the HRMS's own; nothing is calculated here.
// ---------------------------------------------------------------------------

type Preset = "last7" | "last15" | "last30" | "thismonth" | "custom";
const PRESETS: [Preset, string][] = [["last7", "Last 7 days"], ["last15", "Last 15 days"], ["last30", "Last 30 days"], ["thismonth", "This month"], ["custom", "Custom date range"]];
const MAX_DAYS = 93;

function rangeOf(p: Preset, today: string, custom: { from: string; to: string }): { from: string; to: string } {
  switch (p) {
    case "last7": return { from: addDays(today, -6), to: today };
    case "last15": return { from: addDays(today, -14), to: today };
    case "last30": return { from: addDays(today, -29), to: today };
    case "thismonth": return { from: `${today.slice(0, 8)}01`, to: today };
    default: return custom;
  }
}
const spanDays = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;

export default function TeamExport({ filters, ready }: { filters: Filters; ready: boolean }) {
  const me = useMe();
  const today = todayIso();
  const [preset, setPreset] = useState<Preset>("last15");
  const [custom, setCustom] = useState({ from: addDays(today, -14), to: today });
  const [data, setData] = useState<TeamReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [which, setWhich] = useState<CategoryKey | "employee">("attendance");
  const [employee, setEmployee] = useState("");

  const range = useMemo(() => rangeOf(preset, today, custom), [preset, today, custom]);
  const problem = !range.from || !range.to ? "Choose both dates." : range.to < range.from ? "The end date is before the start date." : spanDays(range.from, range.to) > MAX_DAYS ? `Pick ${MAX_DAYS} days or fewer.` : range.to > today ? "The end date is in the future." : "";
  const fq = filterQuery(filters);
  const path = `/team-attendance/team-report?from=${range.from}&to=${range.to}${fq ? `&${fq}` : ""}`;

  // The preview (who and how many) is the same call the download uses, so the number shown is the number downloaded.
  useEffect(() => {
    if (!ready || problem) return;
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      apiGet<TeamReportData>(path)
        .then((d) => {
          if (!live) return;
          setData(d);
          setError("");
          setEmployee((cur) => (cur && d.people.some((p) => p.id === cur) ? cur : d.people[0]?.id ?? ""));
        })
        .catch((e: Error) => live && setError(e.message))
        .finally(() => live && setLoading(false));
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [path, ready, problem]);

  const who = me ? `${me.firstName} ${me.lastName}`.trim() : null;
  const stamp = `${range.from}_to_${range.to}`;

  // A download always asks again, so the file is as current as the moment of the click.
  async function run(kind: string, make: (d: TeamReportData) => Promise<void> | void) {
    if (busy || problem) return;
    setBusy(kind);
    setError("");
    try {
      const fresh = await apiGet<TeamReportData>(path);
      if (fresh.people.length === 0) throw new Error("There are no employees in this selection for these dates.");
      await make(fresh);
    } catch (e) {
      setError((e as Error).message || "Could not create the file.");
    } finally {
      setBusy("");
    }
  }
  const info = async (d: TeamReportData, label?: string) => reportInfo(d, await describeFilters(filters), who, label);

  const selectedLabel = which === "employee" ? "One employee, every day" : CATEGORIES.find((c) => c.key === which)?.label ?? "";
  const nothing = !data || data.people.length === 0;
  const btn = "h-10 rounded-xl px-4 text-sm font-medium disabled:opacity-50";

  return (
    <section aria-label="Export reports" className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">Export reports</h2>
          <p className="mt-0.5 text-sm text-slate-500">The complete team report for one period: attendance, working hours and breaks, tasks and ratings, meetings and Team Huddles, leave. One Excel file with a sheet for each report and one for every employee.</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
        {PRESETS.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={preset === k} onClick={() => setPreset(k)} className={`h-9 rounded-full px-3.5 text-sm font-medium ${preset === k ? "bg-indigo-600 text-white" : "border border-indigo-100 bg-white text-slate-700 hover:bg-[var(--brand-50)]"}`}>
            {l}
          </button>
        ))}
        {preset === "custom" && (
          <span className="flex items-center gap-2">
            <input type="date" aria-label="From" value={custom.from} max={today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="h-9 rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-700" />
            <span className="text-xs text-slate-400">to</span>
            <input type="date" aria-label="To" value={custom.to} max={today} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="h-9 rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-700" />
          </span>
        )}
      </div>

      <p className="mt-3 text-sm text-slate-700" aria-live="polite" data-testid="export-summary">
        {problem ? (
          <span className="text-rose-600">{problem}</span>
        ) : (
          <>
            <strong className="text-slate-900">{dayLabel(range.from)} to {dayLabel(range.to)}</strong> · {spanDays(range.from, range.to)} {spanDays(range.from, range.to) === 1 ? "day" : "days"} ·{" "}
            {loading && !data ? "counting people…" : <strong className="text-slate-900">{plural(data?.people.length ?? 0, "employee")} included</strong>}
            {data && !loading && data.scope.orgTotal > data.people.length && <span className="text-slate-400"> (of {data.scope.orgTotal} you can see; the filters above narrow it)</span>}
          </>
        )}
      </p>

      {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-600">{error}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" disabled={!!busy || !!problem || nothing} aria-busy={busy === "full"} onClick={() => run("full", async (d) => { await downloadReportXlsx(`team-productivity-report_${stamp}.xlsx`, allSheets(d), await info(d)); })} className={`${btn} bg-indigo-600 text-white hover:bg-indigo-700`}>
          {busy === "full" ? "Preparing the workbook…" : "Download complete team report (.xlsx)"}
        </button>
      </div>

      <div className="mt-5 border-t border-indigo-50 pt-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Download one report</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select aria-label="Report" value={which} onChange={(e) => setWhich(e.target.value as CategoryKey | "employee")} className="h-10 rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-700">
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            <option value="employee">One employee, every day</option>
          </select>
          {which === "employee" && (
            <select aria-label="Employee" value={employee} onChange={(e) => setEmployee(e.target.value)} className="h-10 max-w-[18rem] rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-700">
              {(data?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}{p.employeeCode ? ` (${p.employeeCode})` : ""}</option>)}
            </select>
          )}
          <button
            type="button"
            disabled={!!busy || !!problem || nothing || (which === "employee" && !employee)}
            onClick={() => run("one-x", async (d) => {
              const sheet = which === "employee" ? oneEmployeeSheet(d, employee) : categorySheet(d, which);
              const code = which === "employee" ? d.people.find((p) => p.id === employee)?.employeeCode ?? "employee" : CATEGORIES.find((c) => c.key === which)!.file;
              await downloadReportXlsx(`${which === "employee" ? `employee-${code}` : `team-${code}`}_${stamp}.xlsx`, [sheet], await info(d, `${selectedLabel} (${periodLabel(d)})`));
            })}
            className={`${btn} border border-indigo-100 bg-white text-slate-700 hover:bg-[var(--brand-50)]`}
          >
            {busy === "one-x" ? "Preparing…" : "Download Excel"}
          </button>
          <button
            type="button"
            disabled={!!busy || !!problem || nothing || (which === "employee" && !employee)}
            onClick={() => run("one-c", (d) => {
              const sheet = which === "employee" ? oneEmployeeSheet(d, employee) : categorySheet(d, which);
              const code = which === "employee" ? d.people.find((p) => p.id === employee)?.employeeCode ?? "employee" : CATEGORIES.find((c) => c.key === which)!.file;
              const lines = csvLines(sheet);
              downloadCsv(`${which === "employee" ? `employee-${code}` : `team-${code}`}_${stamp}.csv`, lines[0], lines.slice(1));
            })}
            className={`${btn} border border-indigo-100 bg-white text-slate-700 hover:bg-[var(--brand-50)]`}
          >
            Download CSV
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400">Excel opens with a sheet per report; the CSV is the chosen report on its own. Break time stays separate from productive time, and Team Huddle time is shown inside productive hours, never on top.</p>
      </div>
    </section>
  );
}
