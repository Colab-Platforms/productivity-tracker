"use client";

import { useEffect, useRef } from "react";
import { Modal } from "../_employees/Modal";
import { dayTitle } from "./DayRow";
import type { DayModel } from "./model";
import { SEG_COLOR } from "./model";
import { DAYS_SHORT, fmtClock, fmtDur } from "./time";
import type { Timesheet } from "./types";

const KIND_LABEL = { work: "Working time", break: "Break", washroom: "Washroom", overtime: "Overtime", late: "Late" } as const;

// Every interval of the day, in order, with its exact start, end and length.
function Entries({ m, tz }: { m: DayModel; tz: string }) {
  const rows = m.segs
    .filter((s) => s.kind !== "late")
    .map((s) => ({ key: `${s.kind}-${s.start}`, color: SEG_COLOR[s.kind], name: s.kind === "break" || s.kind === "washroom" ? s.label : KIND_LABEL[s.kind], start: s.start, end: s.end, open: m.ongoing && s.end === m.finishMs }));
  return (
    <div className="mt-3 rounded-2xl border border-slate-200">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-sm">
        <span className="text-slate-500">Clock-in</span>
        <span className="font-semibold text-slate-900">
          {fmtClock(m.loginMs, tz)}
          {m.lateMinutes > 0 && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">late by {m.lateMinutes}m</span>}
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 text-sm last:border-b-0">
          <span className="flex items-center gap-2 text-slate-700">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />
            {r.name}
          </span>
          <span className="tabular-nums text-slate-500">
            {fmtClock(r.start, tz)} – {r.open ? "now" : fmtClock(r.end, tz)} · <b className="font-semibold text-slate-800">{fmtDur((r.end - r.start) / 1000)}</b>
          </span>
        </div>
      ))}
      <div className="flex items-center justify-between px-4 py-2.5 text-sm">
        <span className="text-slate-500">Clock-out</span>
        <span className="font-semibold text-slate-900">{m.logoutMs ? fmtClock(m.logoutMs, tz) : m.ongoing ? "Ongoing" : "Not recorded"}</span>
      </div>
      {m.meetings.length > 0 && (
        <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 text-xs text-slate-500">
          Meetings (counted as working time):{" "}
          {m.meetings.map((x, i) => (
            <span key={i} className="mr-3 inline-block">
              {x.label}, {fmtClock(x.start, tz)}
              {x.end ? ` – ${fmtClock(x.end, tz)}` : " – now"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function EntryLogModal({
  models,
  tz,
  selected,
  rangeLabel,
  onClose,
}: {
  models: DayModel[];
  tz: string;
  selected: string | null;
  rangeLabel: string;
  onClose: () => void;
}) {
  const withSession = models.filter((m) => m.hasSession);
  const shown = selected ? withSession.filter((m) => m.date === selected) : withSession;
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    target.current?.scrollIntoView({ block: "start" });
  }, [selected]);

  return (
    <Modal title={selected ? "Entry details" : "Entry log"} subtitle={selected ? dayTitle(selected, models.find((m) => m.date === selected)?.isToday ?? false) : rangeLabel} onClose={onClose} width="max-w-2xl">
      {shown.length === 0 ? (
        <p className="rounded-2xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">No entries in this range.</p>
      ) : (
        <div className="space-y-6">
          {shown.map((m, i) => (
            <div key={m.date} ref={i === 0 ? target : undefined}>
              <div className="flex items-baseline justify-between">
                <p className="font-semibold text-slate-900">{dayTitle(m.date, m.isToday)}</p>
                <p className="text-sm text-slate-500">
                  Total on site <b className="text-slate-900">{fmtDur(m.elapsedSeconds)}</b> · working {fmtDur(m.workSeconds)} · break {fmtDur(m.breakSeconds)}{m.washroomSeconds > 0 && <> · washroom {fmtDur(m.washroomSeconds)}</>}
                  {m.overtimeSeconds > 0 && <> · overtime {fmtDur(m.overtimeSeconds)}</>}
                </p>
              </div>
              <Entries m={m} tz={tz} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function ScheduleModal({ ts, rangeLabel, onClose }: { ts: Timesheet; rangeLabel: string; onClose: () => void }) {
  const sc = ts.schedule;
  const weekly = sc.shift ? sc.shift.workingDays.length * sc.productiveHours : null;
  return (
    <Modal title="Planned hours: your schedule" subtitle="Loaded from your assigned shift and your team's settings" onClose={onClose} width="max-w-lg">
      {sc.shift ? (
        <div className="rounded-2xl border border-slate-200 p-4">
          <p className="text-sm font-semibold text-slate-900">{sc.shift.name}</p>
          <p className="mt-0.5 text-sm text-slate-500">
            {sc.shift.startTime} – {sc.shift.endTime}
            {sc.shift.spansMidnight ? " (overnight)" : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {DAYS_SHORT.map((d, i) => {
              const on = sc.shift!.workingDays.includes(i + 1);
              return (
                <span key={d} className={`w-11 rounded-lg py-1.5 text-center text-xs font-medium ${on ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-400"}`}>
                  {d}
                </span>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">No shift is assigned to you yet, so late and shift hours cannot be shown. Your targets below still apply.</p>
      )}

      <dl className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200 text-sm">
        {[
          ["Productive target per working day", `${sc.productiveHours}h`],
          ["Work day (on site)", `${sc.dailyWorkHours}h`],
          ["Daily break budget", `${sc.breakBudgetMinutes}m`],
          ["Late after shift start + grace", `${sc.lateLoginGraceMinutes}m grace`],
          ["Overtime counts beyond", `${sc.dailyWorkHours}h on site (alert after +${sc.overtimeAlertMinutes}m)`],
          ...(weekly !== null ? [["Weekly planned hours", `${weekly}h over ${sc.shift!.workingDays.length} days`]] : []),
        ].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4 px-4 py-2.5">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-right font-medium text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600">
        <b className="text-slate-800">{rangeLabel}:</b> {ts.totals.expectedDays} scheduled working day{ts.totals.expectedDays === 1 ? "" : "s"}, {fmtDur(ts.totals.plannedSeconds)} planned
        {ts.totals.onLeaveDays > 0 ? `, ${ts.totals.onLeaveDays} day${ts.totals.onLeaveDays === 1 ? "" : "s"} of approved leave not counted` : ""}. Holidays and weekly offs are not counted. This is the same figure the Reports page uses.
      </div>
    </Modal>
  );
}
