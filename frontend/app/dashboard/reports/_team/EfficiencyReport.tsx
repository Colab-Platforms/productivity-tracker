"use client";

// WORK EFFICIENCY INDEX (policy EFFICIENCY_V1). Display only: every figure comes from GET /team-attendance/efficiency (backend tasks/efficiency.logic.ts),
// so this table, the breakdown and any export can never disagree. Click a final percentage to see each standard, its weight, the real numbers, the formula,
// the points earned and the tasks behind it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { Modal } from "../../_employees/Modal";
import { filterQuery, type Filters as HrFilterState } from "../../_filters/useHrFilters";
import { durationShort } from "../../_timer/TaskTimer";
import { PRESETS, rangeFor, type Preset } from "./ranges";
import { dayLabel } from "./format";

type Component = { key: string; label: string; weight: number; state: "SCORED" | "NOT_APPLICABLE" | "MISSING_EVIDENCE"; percent: number | null; earned: number | null; numerator: number | null; denominator: number | null; formula: string; note: string };
type Line = { id: string; title: string; date: string; outcome: string; rating: number | null; actualSeconds: number | null; expectedSeconds: number | null; timeCredit: number | null; reverts: number; partialPercent: number | null; overdue: boolean; dependency: boolean };
type Eff = {
  version: string; percent: number | null; status: string; eligible: number; completed: number; partial: number; returned: number; notCompleted: number; completionRate: number | null;
  ratedTasks: number; awaitingRating: number; averageRating: number | null; attributableDeletions: number; activeSeconds: number; expectedSeconds: number; attendanceRate: number | null;
  components: Component[]; lines: Line[]; deletions: { id: string; title: string; reasonCode: string; reasonNote: string | null; attributable: boolean }[]; missing: string[];
};
type Person = { userId: string; name: string; employeeCode: string | null; teamName: string | null; efficiency: Eff };
type Payload = { from: string; to: string; today: string; version: string; scope?: { orgTotal: number; filteredTotal: number }; people: Person[] };

const STATUS_LABEL: Record<string, string> = { NO_TASKS: "No tasks", INCOMPLETE_EVIDENCE: "Incomplete evidence", INSUFFICIENT_EVIDENCE: "Insufficient evidence", PROVISIONAL: "Provisional", FINAL: "Final" };
const STATUS_CHIP: Record<string, string> = {
  NO_TASKS: "bg-slate-100 text-slate-600", INCOMPLETE_EVIDENCE: "bg-amber-50 text-amber-800", INSUFFICIENT_EVIDENCE: "bg-violet-50 text-violet-700",
  PROVISIONAL: "bg-sky-50 text-sky-700", FINAL: "bg-emerald-50 text-emerald-700",
};
const OUTCOME_LABEL: Record<string, string> = { COMPLETED: "Completed", PARTIAL: "Partial (verified)", RETURNED: "Returned for rework", NOT_COMPLETED: "Not completed" };
const STATE_TEXT: Record<Component["state"], string> = { SCORED: "Scored", NOT_APPLICABLE: "Not applicable", MISSING_EVIDENCE: "Missing evidence" };
const th = "px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500";
const hrs = (s: number) => (s > 0 ? durationShort(s) : "—");

export default function EfficiencyReport({ filters, ready = true }: { filters?: HrFilterState; ready?: boolean }) {
  const hrQuery = filters ? filterQuery(filters) : "";
  const [preset, setPreset] = useState<Preset>("last30");
  const [today, setToday] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Person | null>(null);
  const [detail, setDetail] = useState<Person | null>(null);

  const range = useMemo(() => (today ? rangeFor(preset, today) : { from: "", to: "" }), [preset, today]);
  const load = useCallback(async () => {
    if (!ready || !range) return;
    const qs = new URLSearchParams();
    if (range.from) qs.set("from", range.from);
    if (range.to) qs.set("to", range.to);
    try {
      const d = await apiGet<Payload>(`/team-attendance/efficiency?${qs.toString()}${hrQuery ? `&${hrQuery}` : ""}`);
      setData(d); setToday(d.today); setError("");
    } catch (e) { setError((e as Error).message); }
  }, [range, hrQuery, ready]);
  useEffect(() => { void load(); }, [load]);

  // the task lines are only sent for one person: ask for them when the breakdown opens
  useEffect(() => {
    if (!open || !data) return;
    let live = true;
    setDetail(null);
    apiGet<Payload>(`/team-attendance/efficiency?from=${data.from}&to=${data.to}&userId=${open.userId}${hrQuery ? `&${hrQuery}` : ""}`)
      .then((d) => live && setDetail(d.people[0] ?? null)).catch(() => live && setDetail(null));
    return () => { live = false; };
  }, [open, data, hrQuery]);

  if (error) return <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>;
  if (!data) return <div className="skeleton h-40" aria-busy="true" />;
  const people = data.people.filter((p) => p.efficiency.eligible > 0 || p.efficiency.status !== "NO_TASKS");

  return (
    <div className="space-y-4" data-testid="efficiency-report">
      <div className="flex flex-wrap items-center gap-2">
        <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} aria-label="Period" className="h-10 rounded-xl border border-indigo-100 bg-white px-3 text-sm">
          {PRESETS.filter(([k]) => k !== "single" && k !== "custom").map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span className="text-sm text-slate-500">{dayLabel(data.from)} to {dayLabel(data.to)} · policy {data.version}</span>
      </div>
      <p className="rounded-xl bg-white px-4 py-3 text-xs text-slate-500 shadow-[var(--shadow-card)]">
        Eight measured standards, one outcome per task (a task is never penalised twice). A blank final means a standard has work to judge but no evidence yet
        (for example no manager rating, or no manager-confirmed time): nothing is guessed. Click a percentage for the full calculation.
      </p>
      <div className="overflow-x-auto rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className={th}>Employee</th><th className={`${th} text-right`}>Eligible</th><th className={`${th} text-right`}>Completed</th><th className={`${th} text-right`}>Completion</th>
              <th className={`${th} text-right`}>Avg rating</th><th className={`${th} text-right`}>Partial</th><th className={`${th} text-right`}>Not completed</th><th className={`${th} text-right`}>Reverted</th>
              <th className={`${th} text-right`}>Valid deletions</th><th className={`${th} text-right`}>Active hours</th><th className={`${th} text-right`}>Expected hours</th>
              <th className={`${th} text-right`}>Attendance</th><th className={`${th} text-right`}>Work Efficiency Index</th><th className={th}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-indigo-50">
            {people.length === 0 && <tr><td colSpan={14} className="px-4 py-8 text-center text-slate-500">No eligible tasks in this period.</td></tr>}
            {people.map((p) => {
              const e = p.efficiency;
              return (
                <tr key={p.userId} data-testid="eff-row">
                  <td className="px-3 py-2.5"><span className="font-medium text-slate-900">{p.name}</span><span className="block text-xs text-slate-400">{p.employeeCode}{p.teamName ? ` · ${p.teamName}` : ""}</span></td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{e.eligible}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{e.completed}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{e.completionRate != null ? `${e.completionRate}%` : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{e.averageRating != null ? `${e.averageRating} / 5 (${e.ratedTasks})` : <span className="text-xs text-slate-400">{e.completed ? "Not rated" : "—"}</span>}{e.awaitingRating > 0 && e.ratedTasks > 0 ? <span className="ml-1 text-xs text-violet-700">+{e.awaitingRating} pending</span> : null}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{e.partial}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{e.notCompleted}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{e.returned}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{e.attributableDeletions}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{hrs(e.activeSeconds)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{e.expectedSeconds > 0 ? hrs(e.expectedSeconds) : <span className="text-xs text-slate-400">Not set</span>}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{e.attendanceRate != null ? `${e.attendanceRate}%` : "—"}</td>
                  <td className="px-3 py-2.5 text-right">
                    <button type="button" onClick={() => setOpen(p)} data-testid="eff-score" className="rounded-lg px-2 py-1 font-semibold tabular-nums text-indigo-700 hover:bg-indigo-50" title="Open the calculation">
                      {e.percent != null ? `${e.percent}%` : "Blank"}
                    </button>
                  </td>
                  <td className="px-3 py-2.5"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[e.status]}`}>{STATUS_LABEL[e.status]}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {open && (
        <Modal title={`${open.name} · Work Efficiency Index`} subtitle={`${dayLabel(data.from)} to ${dayLabel(data.to)} · policy ${data.version}`} onClose={() => setOpen(null)} width="max-w-4xl">
          {(() => {
            const e = (detail ?? open).efficiency;
            return (
              <div className="space-y-4" data-testid="eff-breakdown">
                <p className="text-2xl font-semibold text-slate-900">{e.percent != null ? `${e.percent}%` : "No final percentage"} <span className={`ml-2 rounded-full px-2 py-0.5 align-middle text-xs font-medium ${STATUS_CHIP[e.status]}`}>{STATUS_LABEL[e.status]}</span></p>
                {e.missing.length > 0 && <ul className="list-disc rounded-xl bg-amber-50 px-6 py-3 text-xs text-amber-900">{e.missing.map((m) => <li key={m}>{m}</li>)}</ul>}
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead><tr><th className={th}>Standard</th><th className={`${th} text-right`}>Weight</th><th className={th}>Actual data</th><th className={th}>Calculation</th><th className={`${th} text-right`}>Result</th><th className={`${th} text-right`}>Points</th></tr></thead>
                    <tbody className="divide-y divide-indigo-50">
                      {e.components.map((c) => (
                        <tr key={c.key} data-testid={`eff-comp-${c.key}`} className="align-top">
                          <td className="px-3 py-2 font-medium text-slate-900">{c.label}<span className="block text-xs font-normal text-slate-400">{STATE_TEXT[c.state]}</span></td>
                          <td className="px-3 py-2 text-right tabular-nums">{c.weight}%</td>
                          <td className="max-w-xs px-3 py-2 text-xs text-slate-600">{c.note}</td>
                          <td className="max-w-xs px-3 py-2 text-xs text-slate-500">{c.formula}{c.numerator != null && c.denominator != null ? ` = ${c.numerator} / ${c.denominator}` : ""}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{c.percent != null ? `${c.percent}%` : "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{c.earned != null ? `${c.earned} / ${c.weight}` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-slate-500">Active time is the same tracked figure the manager sees on the task review screen. Reasonable time is the manager's estimate, entered after completion. Final = points earned / weights of the standards that apply x 100. Standards with nothing to measure are marked Not applicable and their weight is shared by the rest; a standard with missing evidence leaves the final blank.</p>
                <div>
                  <h4 className="mb-1 text-sm font-semibold text-slate-800">Task history ({e.lines.length})</h4>
                  {!detail ? <div className="skeleton h-16" aria-busy="true" /> : (
                    <div className="max-h-72 overflow-auto rounded-xl border border-indigo-50">
                      <table className="min-w-full text-xs">
                        <thead className="sticky top-0 bg-slate-50"><tr><th className={th}>Task</th><th className={th}>Date</th><th className={th}>Outcome</th><th className={`${th} text-right`}>Rating</th><th className={`${th} text-right`}>Active</th><th className={`${th} text-right`} title="The reasonable time the manager confirmed after the work was completed">Reasonable (post-completion)</th><th className={`${th} text-right`}>Time credit</th></tr></thead>
                        <tbody className="divide-y divide-indigo-50">
                          {e.lines.map((l) => (
                            <tr key={l.id}>
                              <td className="max-w-xs px-3 py-1.5 text-slate-800"><span className="line-clamp-2 break-words">{l.title}</span></td>
                              <td className="whitespace-nowrap px-3 py-1.5">{dayLabel(l.date)}</td>
                              <td className="px-3 py-1.5">{OUTCOME_LABEL[l.outcome] ?? l.outcome}{l.overdue ? " · overdue" : ""}{l.dependency ? " · dependency" : ""}{l.reverts ? ` · returned ${l.reverts}x` : ""}{l.partialPercent != null ? ` · ${l.partialPercent}%` : ""}</td>
                              <td className="px-3 py-1.5 text-right">{l.rating ?? "—"}</td>
                              <td className="px-3 py-1.5 text-right">{l.actualSeconds != null ? durationShort(l.actualSeconds) : "Not tracked"}</td>
                              <td className="px-3 py-1.5 text-right">{l.expectedSeconds != null ? durationShort(l.expectedSeconds) : "—"}</td>
                              <td className="px-3 py-1.5 text-right">{l.timeCredit != null ? `${Math.round(l.timeCredit * 100)}%` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {detail && e.deletions.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs text-slate-600">{e.deletions.map((d) => <li key={d.id}>Deleted by a manager: “{d.title}” · {d.reasonCode}{d.reasonNote ? ` (${d.reasonNote})` : ""} · {d.attributable ? "counted against the employee" : "not counted"}</li>)}</ul>
                  )}
                </div>
              </div>
            );
          })()}
        </Modal>
      )}
    </div>
  );
}
