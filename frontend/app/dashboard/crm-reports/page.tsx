"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { apiGet } from "@/lib/api";
import { homeFor } from "@/lib/roleHome";
import { useMe } from "../layout";
import { PRESETS, TABS, buildSections, chartFor, employeeChoices, filterByEmployee, formatValue, isStale, labelOf, numericOf, paginate, type Envelope, type Section, type Table, type TabKey } from "./view";

// CRM REPORTS: one page, one sidebar entry, one allowed person (decided by the server). Every figure is the CRM's own answer, passed through the HRMS server.
const REFRESH_MS = 5 * 60_000;
const PAGE_SIZE = 15;
const card = "rounded-2xl bg-white shadow-[var(--shadow-card)]";
const inputCls = "h-10 rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-900";

type Failure = { message: string; code?: string };

export default function CrmReportsPage() {
  const me = useMe();
  const router = useRouter();
  const [access, setAccess] = useState<"checking" | "yes" | "no">("checking");

  // The server is the gate; this only keeps other people off the address.
  useEffect(() => {
    if (!me) return;
    apiGet<{ allowed: boolean }>("/crm-reports/access")
      .then((r) => setAccess(r.allowed === true ? "yes" : "no"))
      .catch(() => setAccess("no"));
  }, [me]);
  useEffect(() => {
    if (me && access === "no") router.replace(homeFor(me.role));
  }, [me, access, router]);

  if (access !== "yes") return <p className="text-sm text-slate-500">{access === "checking" ? "Checking access…" : "Redirecting…"}</p>;
  return <Reports />;
}

function Reports() {
  const [tab, setTab] = useState<TabKey>("sales");
  const [range, setRange] = useState("last_7_days");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [employee, setEmployee] = useState("");
  const [env, setEnv] = useState<Envelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seq = useRef(0);

  const customReady = range !== "custom" || (!!from && !!to && from <= to);

  const load = useCallback(async () => {
    if (!customReady) return;
    const mine = ++seq.current; // an older answer arriving late is ignored
    setLoading(true);
    const qs = new URLSearchParams({ range });
    if (range === "custom") {
      qs.set("from", from);
      qs.set("to", to);
    }
    try {
      const r = await apiGet<Envelope>(`/crm-reports/${tab}?${qs}`);
      if (mine !== seq.current) return;
      setEnv(r);
      setFailure(null);
      setLastOkAt(Date.now());
    } catch (e) {
      if (mine !== seq.current) return;
      const err = e as Error & { code?: string };
      setFailure({ message: err.message, code: err.code }); // the last good data stays on screen, marked stale
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [tab, range, from, to, customReady]);

  // Load on any change, then every 5 minutes. (Setting state from an async load is the whole point of this effect.)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnv(null);
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const sections = env ? buildSections(env) : [];
  const people = employeeChoices(sections);
  const stale = isStale(lastOkAt, failure !== null, now);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => { setTab(t.key); setEmployee(""); }} aria-pressed={tab === t.key}
            className={`h-10 rounded-xl px-4 text-sm font-medium ${tab === t.key ? "bg-indigo-600 text-white" : "bg-white text-slate-700 shadow-[var(--shadow-card)] hover:bg-indigo-50"}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className={`${card} flex flex-wrap items-end gap-3 p-4`}>
        <label className="text-xs text-slate-500">
          Date range
          <select className={`${inputCls} mt-1 block`} value={range} onChange={(e) => setRange(e.target.value)}>
            {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        {range === "custom" && (
          <>
            <label className="text-xs text-slate-500">From<input type="date" className={`${inputCls} mt-1 block`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="text-xs text-slate-500">To<input type="date" className={`${inputCls} mt-1 block`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </>
        )}
        {people.length > 0 && (
          <label className="text-xs text-slate-500">
            Employee
            <select className={`${inputCls} mt-1 block`} value={employee} onChange={(e) => setEmployee(e.target.value)}>
              <option value="">Everyone</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <span className="text-xs text-slate-500" aria-live="polite">
            {lastOkAt ? `Last refreshed ${new Date(lastOkAt).toLocaleTimeString()}` : "Not refreshed yet"} · auto every 5 min
          </span>
          <button type="button" onClick={load} disabled={loading || !customReady} className="h-10 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" disabled={!env} onClick={() => env && exportExcel(tab, env, sections, employee)} className="h-10 rounded-xl border border-indigo-100 bg-white px-4 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60">
            Export Excel
          </button>
        </div>
      </div>
      {range === "custom" && !customReady && <p className="text-sm text-amber-700">Choose a From and To date (From must not be after To).</p>}

      {failure && (
        <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>{env ? "Showing older data. " : ""}</strong>
          {failure.message}
          {stale && lastOkAt && <> The figures below are from {new Date(lastOkAt).toLocaleTimeString()} and may be out of date.</>}
        </div>
      )}
      {!failure && stale && <p className="text-sm text-amber-700">These figures are more than 10 minutes old. Press Refresh.</p>}

      {loading && !env && !failure && <div className={`${card} p-8 text-center text-sm text-slate-500`}>Loading CRM data…</div>}
      {env && <Meta env={env} />}
      {env && sections.length === 0 && <div className={`${card} p-8 text-center text-sm text-slate-500`}>The CRM returned no data for this period.</div>}
      {sections.map((s) => <SectionView key={s.key} section={s} employee={employee} />)}
    </div>
  );
}

function Meta({ env }: { env: Envelope }) {
  const basis = Object.entries(env.basis ?? {});
  return (
    <div className={`${card} p-4 text-xs text-slate-500`}>
      <p>
        <strong className="text-slate-700">{env.from}</strong> to <strong className="text-slate-700">{env.to}</strong> · {env.timezone ?? "Asia/Kolkata"}
        {env.generatedAt && <> · CRM calculated {new Date(env.generatedAt).toLocaleString()}</>}
      </p>
      {(basis.length > 0 || (env.notes?.length ?? 0) > 0) && (
        <details className="mt-2">
          <summary className="cursor-pointer text-indigo-700">How these figures are calculated</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {basis.map(([k, v]) => <li key={k}><strong>{labelOf(k)}:</strong> {v}</li>)}
            {(env.notes ?? []).map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function SectionView({ section, employee }: { section: Section; employee: string }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-slate-900">{section.title}</h2>
      {section.unavailable ? (
        <div className={`${card} p-4 text-sm text-slate-500`}>Not available: {section.unavailable}</div>
      ) : (
        <>
          {section.cards.length > 0 && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
              {section.cards.map((c, i) => (
                <div key={`${c.key}-${i}`} className={`${card} p-4`}>
                  <p className="text-xs text-slate-500">{c.label}</p>
                  <p className={`mt-1 text-xl font-semibold ${c.value === null ? "text-slate-400" : "text-slate-900"}`}>{formatValue(c.key, c.value)}</p>
                </div>
              ))}
            </div>
          )}
          {section.tables.map((t) => <TableView key={t.key} table={t} employee={employee} />)}
        </>
      )}
    </section>
  );
}

function TableView({ table, employee }: { table: Table; employee: string }) {
  const [page, setPage] = useState(1);
  const rows = filterByEmployee(table.rows, employee);
  const chart = chartFor({ ...table, rows });
  const pg = paginate(rows, page, PAGE_SIZE);
  return (
    <div className={`${card} overflow-hidden`}>
      <div className="px-4 pt-4"><h3 className="text-sm font-semibold text-slate-900">{table.title}</h3></div>
      {chart && (
        <div className="h-56 px-2 pt-2" role="img" aria-label={`${labelOf(chart.metricKey)} by ${labelOf(chart.labelKey)}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart.points}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid, #E6ECE9)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={0} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="value" name={labelOf(chart.metricKey)} fill="#0D9E76" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">No rows for this selection.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>{table.columns.map((c) => <th key={c} className="whitespace-nowrap px-4 py-2 font-medium">{labelOf(c)}</th>)}</tr>
            </thead>
            <tbody>
              {pg.rows.map((r, i) => (
                <tr key={i} className="border-t border-indigo-50">
                  {table.columns.map((c) => (
                    <td key={c} className={`whitespace-nowrap px-4 py-2 ${r[c] === null || r[c] === undefined ? "text-slate-400" : "text-slate-700"}`}>{formatValue(c, r[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pg.pages > 1 && (
        <div className="flex items-center justify-between border-t border-indigo-50 px-4 py-2 text-xs text-slate-500">
          <span>{rows.length} rows · page {pg.page} of {pg.pages}</span>
          <span className="flex gap-2">
            <button type="button" disabled={pg.page <= 1} onClick={() => setPage(pg.page - 1)} className="rounded-lg border border-indigo-100 px-3 py-1 disabled:opacity-50">Previous</button>
            <button type="button" disabled={pg.page >= pg.pages} onClick={() => setPage(pg.page + 1)} className="rounded-lg border border-indigo-100 px-3 py-1 disabled:opacity-50">Next</button>
          </span>
        </div>
      )}
    </div>
  );
}

// Excel: loaded only on click. Missing values stay blank (never 0); money is in rupees; one sheet per table, a Summary sheet and a Report info sheet.
async function exportExcel(tab: string, env: Envelope, sections: Section[], employee: string) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const sheetName = (n: string, used: Set<string>) => {
    let base = n.replace(/[\\/?*[\]:]/g, " ").slice(0, 28) || "Sheet";
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base.slice(0, 25)} ${i}`;
    used.add(name);
    return name;
  };
  const used = new Set<string>();
  const summary = wb.addWorksheet(sheetName("Summary", used));
  summary.addRow(["Section", "Measure", "Value"]).font = { bold: true };
  for (const s of sections) {
    if (s.unavailable) summary.addRow([s.title, "Not available", s.unavailable]);
    for (const c of s.cards) summary.addRow([s.title, c.label, c.value === null ? null : typeof c.value === "number" ? numericOf(c.key, c.value) : c.value]);
  }
  for (const s of sections) {
    for (const t of s.tables) {
      const ws = wb.addWorksheet(sheetName(`${s.title} ${t.title === s.title ? "" : t.title}`.trim(), used));
      ws.addRow(t.columns.map(labelOf)).font = { bold: true };
      ws.views = [{ state: "frozen", ySplit: 1 }];
      for (const r of filterByEmployee(t.rows, employee)) ws.addRow(t.columns.map((c) => (typeof r[c] === "number" ? numericOf(c, r[c]) : (r[c] ?? null))));
    }
  }
  const info = wb.addWorksheet(sheetName("Report info", used));
  info.addRows([["Report", labelOf(tab)], ["From", env.from ?? ""], ["To", env.to ?? ""], ["Timezone", env.timezone ?? "Asia/Kolkata"], ["CRM calculated", env.generatedAt ?? ""], ["Exported", new Date().toISOString()], ["Employee filter", employee || "Everyone"], ["Source", "CRM (source of truth)"]]);
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `crm-${tab}-${env.from ?? "all"}_${env.to ?? ""}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
