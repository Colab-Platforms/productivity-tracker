"use client";

import { SEG_COLOR, type DayModel } from "./model";
import { fmtClock, fmtDur, longDay, weekdayName } from "./time";

const pct = (m: DayModel, ms: number) => ((ms - m.axisStart) / (m.axisEnd - m.axisStart)) * 100;

export function dayTitle(date: string, isToday: boolean) {
  return isToday ? "Today" : `${weekdayName(date)}, ${longDay(date).replace(/, \d{4}$/, "")}`;
}

// A day with nothing to draw: said plainly, never faked.
function QuietRow({ m, onCorrect }: { m: DayModel; onCorrect?: (date: string) => void }) {
  const d = m.day;
  const note = d.onLeave
    ? "On leave"
    : d.holiday && d.holiday.dayType !== "OPTIONAL_HOLIDAY"
      ? `${d.holiday.dayType === "WEEKLY_OFF" ? "Weekly off" : "Holiday"} · ${d.holiday.name}`
      : !d.expected
        ? "Day off"
        : m.isToday
          ? "Not clocked in yet"
          : "No activity recorded";
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-dashed border-slate-200 py-3.5 first:border-t-0">
      <p className="text-[15px] font-semibold text-slate-700">{dayTitle(m.date, m.isToday)}</p>
      <p className="flex items-center gap-3 text-sm text-slate-400">
        {note}
        {onCorrect && !d.onLeave && (
          <button type="button" onClick={() => onCorrect(m.date)} className="rounded-lg border border-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50">
            Request correction
          </button>
        )}
      </p>
    </div>
  );
}

export default function DayRow({ model: m, tz, onOpen, onCorrect }: { model: DayModel; tz: string; onOpen: (date: string) => void; onCorrect?: (date: string) => void }) {
  if (!m.hasSession) return <QuietRow m={m} onCorrect={onCorrect} />;

  const span = m.axisEnd - m.axisStart;
  const clockOut = m.logoutMs ? fmtClock(m.logoutMs, tz) : m.ongoing ? "Ongoing" : "Not recorded";

  return (
    <div className="border-t border-dashed border-slate-200 py-5 first:border-t-0">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-[15px] font-semibold text-slate-900">{dayTitle(m.date, m.isToday)}{m.day.session?.project && <span className="ml-2 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">{m.day.session.project.name}</span>}{m.day.session?.wasLateLogin && m.day.session.lateRemark && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700" title={m.day.session.lateRemark}>Late remark: {m.day.session.lateRemark.length > 60 ? m.day.session.lateRemark.slice(0, 60) + "…" : m.day.session.lateRemark}</span>}</p>
        <p className="flex items-center gap-3 text-sm text-slate-500">
          {m.day.session?.correction && (
            <span title={`Corrected by ${m.day.session.correction.by}`} className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Corrected by HR</span>
          )}
          {onCorrect && (
            <button type="button" onClick={() => onCorrect(m.date)} className="rounded-lg border border-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50">
              Request correction
            </button>
          )}
          <span>Duration: <span className="font-semibold text-slate-900">{fmtDur(m.elapsedSeconds)}</span></span>
        </p>
      </div>

      {/* Horizontally scrollable on small screens so the hours never get squashed. */}
      <div className="mt-3 overflow-x-auto pb-1">
        <div className="min-w-[640px]">
          <div className="grid grid-cols-[5.25rem_minmax(0,1fr)_5.25rem] items-end gap-3">
            <div>
              <p className="text-[11px] text-slate-400">Clock-in</p>
              <p className="text-sm font-semibold text-slate-900">{fmtClock(m.loginMs, tz)}</p>
            </div>

            <div>
              {/* hour markers */}
              <div className="relative mb-1.5 h-4">
                {m.ticks.map((t) => (
                  <span key={t.ms} className="absolute -translate-x-1/2 text-[11px] tabular-nums text-slate-400" style={{ left: `${((t.ms - m.axisStart) / span) * 100}%` }}>
                    {t.label}
                  </span>
                ))}
              </div>

              <button
                type="button"
                onClick={() => onOpen(m.date)}
                aria-label={`Open the entries for ${dayTitle(m.date, m.isToday)}`}
                className="group relative block h-7 w-full overflow-hidden rounded-full bg-slate-100 text-left transition hover:ring-2 hover:ring-violet-200"
              >
                {m.segs.map((g, i) => {
                  const left = pct(m, g.start);
                  const width = Math.max(pct(m, g.end) - left, 0.35);
                  return (
                    <span
                      key={i}
                      title={`${g.label} · ${fmtClock(g.start, tz)} – ${fmtClock(g.end, tz)} · ${fmtDur((g.end - g.start) / 1000)}`}
                      className="absolute inset-y-0.5 rounded-md border-x border-white/70"
                      style={{
                        left: `${left}%`,
                        width: `${width}%`,
                        background:
                          g.kind === "late"
                            ? `repeating-linear-gradient(135deg, ${SEG_COLOR.late}, ${SEG_COLOR.late} 4px, #fca5a5 4px, #fca5a5 8px)`
                            : SEG_COLOR[g.kind],
                      }}
                    />
                  );
                })}
                {/* clock-in / clock-out caps */}
                <span className="absolute inset-y-1 w-[3px] rounded bg-white/90" style={{ left: `calc(${pct(m, m.loginMs)}% + 1px)` }} />
                {m.logoutMs && <span className="absolute inset-y-1 w-[3px] rounded bg-white/90" style={{ left: `calc(${pct(m, m.logoutMs)}% - 4px)` }} />}
              </button>
            </div>

            <div className="text-right">
              <p className="text-[11px] text-slate-400">Clock-out</p>
              <p className={`whitespace-nowrap text-sm font-semibold ${m.logoutMs ? "text-slate-900" : m.ongoing ? "text-violet-600" : "text-amber-600"}`}>{clockOut}</p>
            </div>
          </div>
        </div>
      </div>

      {(m.missingClockOut || m.autoClosed) && (
        <p className="mt-2 text-xs text-amber-700">
          {m.autoClosed ? "This day was closed automatically because no clock-out was recorded." : "No clock-out was recorded for this day, so it is drawn only as far as the last recorded activity."}
        </p>
      )}
    </div>
  );
}
