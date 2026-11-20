"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { isoDaysAgo } from "@/lib/time";
import { Stars } from "../../_ratings/Stars";
import { LateBadge, LateNote, type LateInfo } from "../../_late/Late";
import { PROGRESS_CHIP_CLASS, PROGRESS_LABEL } from "../../_progress/progress";
import { EditTaskModal } from "../../_taskedit/EditTaskModal";
import { EditButton } from "../../_taskedit/EditButton";
import { EditedChip } from "../../_taskedit/EditedChip";
import { WeightedCard, type Weighted } from "../../_weighted/Weighted";
import { TaskHistoryModal } from "../../_taskedit/TaskHistoryModal";
import type { EditChoices, EditableTask } from "../../_taskedit/editTypes";

export type RangeKey = "today" | "yesterday" | "last7" | "date";

const PRESETS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7", label: "Last 7 days" },
  { key: "date", label: "Pick a date" },
];

// Turns the chosen filter into a from/to pair (company-timezone days).
export function rangeFor(key: RangeKey, picked: string): { from: string; to: string } {
  if (key === "yesterday") return { from: isoDaysAgo(1), to: isoDaysAgo(1) };
  if (key === "last7") return { from: isoDaysAgo(6), to: isoDaysAgo(0) };
  return { from: picked, to: picked };
}

export function DateFilter({ value, picked, onChange }: { value: RangeKey; picked: string; onChange: (k: RangeKey, picked: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => onChange(p.key, picked)}
          aria-pressed={value === p.key}
          className={`rounded-xl px-3.5 py-2 text-sm font-medium ${value === p.key ? "bg-indigo-600 text-white" : "border border-indigo-100 bg-white text-slate-700 hover:bg-indigo-50/60"}`}
        >
          {p.label}
        </button>
      ))}
      {value === "date" && (
        <input
          type="date"
          value={picked}
          max={isoDaysAgo(0)}
          onChange={(e) => e.target.value && onChange("date", e.target.value)}
          className="rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900"
          aria-label="Choose a day"
        />
      )}
    </div>
  );
}

type RTask = EditableTask & {
  status: string; rating: number | null; ratingComment: string | null;
  completionNote: string | null; reviewNote: string | null; rejectionNote: string | null;
  late?: LateInfo | null;
};
type RangeData = { from: string; to: string; score: { percent: number | null; done: number; total: number }; weighted?: Weighted; tasks: RTask[] };

function stateOf(t: RTask): { label: string; tone: string } {
  if (t.approvalStatus === "REJECTED") return { label: "Not approved", tone: "bg-red-50 text-red-700" };
  if (t.approvalStatus === "PENDING") return { label: "Waiting for approval", tone: "bg-amber-50 text-amber-700" };
  if (t.status === "COMPLETED") {
    if (t.rating != null) return { label: `Rated ${t.rating}/5`, tone: t.rating >= 4 ? "bg-emerald-50 text-emerald-700" : t.rating === 3 ? "bg-sky-50 text-sky-700" : "bg-red-50 text-red-700" };
    return { label: "Done, waiting for rating", tone: "bg-amber-50 text-amber-700" };
  }
  if (t.status === "CANCELLED") return { label: "Cancelled", tone: "bg-slate-100 text-slate-600" };
  return { label: t.status === "IN_PROGRESS" ? "In progress" : "To do", tone: "bg-indigo-50 text-indigo-700" };
}

const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short", year: "numeric" });

// Read-only list of earlier days. To tick off a forgotten task, open the day in My history.
export function RangeTasks({ from, to, choices, latePolicy, reloadKey = 0, onChanged }: { from: string; to: string; choices?: EditChoices; latePolicy?: { ready: boolean; allowedDays: number; maxDays: number } | null; reloadKey?: number; onChanged?: () => void }) {
  const [res, setRes] = useState<{ key: string; data?: RangeData; error?: string } | null>(null);
  const [editFor, setEditFor] = useState<EditableTask | null>(null);
  const [historyFor, setHistoryFor] = useState<{ id: string; title: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [local, setLocal] = useState(0);
  const key = `${from}|${to}|${reloadKey}|${local}`;
  useEffect(() => {
    let live = true;
    apiGet<RangeData>(`/tasks/range?from=${from}&to=${to}`)
      .then((data) => live && setRes({ key, data }))
      .catch((e: Error) => live && setRes({ key, error: e.message }));
    return () => { live = false; };
  }, [from, to, key]);
  const cur = res && res.key === key ? res : null;

  if (!cur) return <div className="skeleton h-32" aria-busy="true" />;
  if (cur.error) return <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{cur.error}</p>;
  const data = cur.data!;
  if (data.tasks.length === 0) return <p className="rounded-2xl bg-white px-4 py-10 text-center text-sm text-slate-500 shadow-[var(--shadow-card)]">No tasks were recorded in this period.</p>;

  const days = [...new Set(data.tasks.map((t) => t.date))];
  return (
    <div className="space-y-4">
      {editFor && choices && (
        <EditTaskModal
          task={editFor}
          choices={choices}
          latePolicy={latePolicy ?? null}
          onClose={() => setEditFor(null)}
          onSaved={(m) => { setEditFor(null); if (m) setNotice(m); setLocal((n) => n + 1); onChanged?.(); }}
        />
      )}
      {historyFor && <TaskHistoryModal taskId={historyFor.id} title={historyFor.title} onClose={() => setHistoryFor(null)} />}
      {notice && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice("")} className="shrink-0 text-emerald-700 hover:underline" aria-label="Dismiss">Dismiss</button>
        </div>
      )}
      <p className="text-sm text-slate-500">
        {data.score.done} of {data.score.total} approved tasks done{data.score.percent !== null ? ` · score ${data.score.percent}%` : ""}. Forgot to tick one? Open that day in <a href="/dashboard/history" className="font-medium text-indigo-700 hover:underline">My history</a>.
      </p>
      {data.weighted && <WeightedCard w={data.weighted} title="Weighted task performance (selected dates)" />}
      {days.map((d) => (
        <section key={d} className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]">
          <h2 className="text-sm font-semibold text-slate-900">{dayLabel(d)}</h2>
          <ul className="mt-3 space-y-3">
            {data.tasks.filter((t) => t.date === d).map((t) => {
              const s = stateOf(t);
              return (
                <li key={t.id} className="rounded-xl border border-indigo-100 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="font-medium text-slate-900">{t.title}</p>
                    <span className="flex flex-wrap items-center gap-1.5">{choices && <EditButton task={t} onEdit={() => setEditFor(t)} />}<LateBadge late={t.late} />{t.progress && <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${PROGRESS_CHIP_CLASS[t.progress] ?? "bg-slate-100 text-slate-600"}`}>{PROGRESS_LABEL[t.progress] ?? t.progress}</span>}<span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${s.tone}`}>{s.label}</span></span>
                  </div>
                  <LateNote date={t.date} late={t.late} />
                  <div className="mt-1"><EditedChip edited={t.edited} pending={t.pendingCorrection} onHistory={t.edited ? () => setHistoryFor({ id: t.id, title: t.title }) : undefined} /></div>
                  {t.progress === "BLOCKED" && <p className="mt-1 break-words rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 [overflow-wrap:anywhere]"><span className="font-medium">Blocked:</span> {t.blockedNote || "No reason was written."}</p>}
                  {t.project && <p className="mt-1 text-xs text-slate-400">{t.project}</p>}
                  {t.description && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{t.description}</p>}
                  {t.rating != null && <p className="mt-1"><Stars value={t.rating} size={14} /></p>}
                  {(t.ratingComment || t.reviewNote || t.rejectionNote) && <p className="mt-1 text-sm text-slate-600"><span className="font-medium text-slate-700">Manager&apos;s comment: </span>{t.ratingComment || t.reviewNote || t.rejectionNote}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
