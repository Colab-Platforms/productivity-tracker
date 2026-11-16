"use client";

// Read-only list of deleted tasks. HR and Admin see every company they act on; a manager sees only the tasks he deleted himself.
// Everything the task had is kept (employee, project, original date, rating, comments) together with who deleted it, when and why.

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/time";
import { Stars } from "../_ratings/Stars";

type Deleted = {
  id: string;
  employee: string;
  employeeCode: string | null;
  company: string | null;
  title: string;
  description: string | null;
  date: string;
  project: string | null;
  status: string;
  approvalStatus: string;
  rating: number | null;
  ratingComment: string | null;
  completionNote: string | null;
  reviewNote: string | null;
  rejectionNote: string | null;
  approvalNote: string | null;
  taggedManager: string | null;
  hoursSpent: number | null;
  deletedBy: string;
  deletedByRole: string;
  deletedAt: string;
  reason: string;
  note: string | null;
};

const ROLE: Record<string, string> = { ADMIN: "Admin", HR: "HR", MANAGER: "Manager" };

export function DeletedTasks() {
  const [data, setData] = useState<{ ready: boolean; tasks: Deleted[] } | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    let live = true;
    apiGet<{ ready: boolean; tasks: Deleted[] }>("/tasks/deleted")
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load the deleted tasks"));
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = data?.tasks ?? [];
    if (!needle) return list;
    return list.filter((t) => [t.employee, t.employeeCode, t.title, t.project, t.deletedBy, t.reason].some((x) => (x ?? "").toLowerCase().includes(needle)));
  }, [data, q]);

  if (error) return <p className="rounded-2xl rounded-t-none bg-white p-5 text-sm text-rose-700 shadow-[var(--shadow-card)]">{error}</p>;
  if (!data) return <p className="rounded-2xl rounded-t-none bg-white p-5 text-sm text-slate-400 shadow-[var(--shadow-card)]">Loading…</p>;
  if (!data.ready) return <p className="rounded-2xl rounded-t-none bg-white p-5 text-sm text-slate-600 shadow-[var(--shadow-card)]">Deleting tasks is not switched on yet.</p>;

  return (
    <section className="overflow-hidden rounded-2xl rounded-t-none bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-50 px-5 py-3.5">
        <p className="text-xs text-slate-500">Removed from active lists, counts and reports. Kept here for the record (newest first, up to 300).</p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search employee, task, project…"
          aria-label="Search deleted tasks"
          className="w-full rounded-xl border border-indigo-100 px-3 py-1.5 text-sm sm:w-64"
        />
      </div>
      <ul className="divide-y divide-indigo-50">
        {shown.map((t) => (
          <li key={t.id} className="px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-slate-900 [overflow-wrap:anywhere]">{t.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {t.employee}{t.employeeCode ? ` · ${t.employeeCode}` : ""}{t.company ? ` · ${t.company}` : ""} · Task date {formatDate(`${t.date}T12:00:00Z`, { day: "numeric", month: "short", year: "numeric" })}{t.project ? ` · ${t.project}` : ""}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-medium text-rose-700">Deleted</span>
            </div>
            {t.description && <p className="mt-1 break-words text-xs text-slate-500">{t.description}</p>}
            <p className="mt-1.5 text-xs text-slate-600">
              Was: {t.approvalStatus.toLowerCase()} · {t.status.replace("_", " ").toLowerCase()}{t.taggedManager ? ` · tagged to ${t.taggedManager}` : ""}{t.hoursSpent != null ? ` · ${t.hoursSpent} h` : ""}
            </p>
            {t.rating != null && (
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <Stars value={t.rating} size={14} />
                {t.ratingComment ? <span className="break-words">“{t.ratingComment}”</span> : null}
                <span className="text-slate-400">(not counted any more)</span>
              </p>
            )}
            {(t.completionNote || t.reviewNote || t.rejectionNote || t.approvalNote) && (
              <p className="mt-1 break-words text-xs text-slate-500">
                {t.completionNote ? <>Employee note: {t.completionNote}. </> : null}
                {t.approvalNote ? <>Approval note: {t.approvalNote}. </> : null}
                {t.rejectionNote ? <>Sent back: {t.rejectionNote}. </> : null}
                {t.reviewNote ? <>Manager comment: {t.reviewNote}</> : null}
              </p>
            )}
            <p className="mt-2 rounded-lg bg-rose-50/70 px-2.5 py-1.5 text-xs text-rose-900">
              Deleted by <span className="font-medium">{t.deletedBy}</span> ({ROLE[t.deletedByRole] ?? t.deletedByRole}) on {formatDateTime(t.deletedAt, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
              {" · "}<span className="font-medium">{t.reason}</span>{t.note ? `: ${t.note}` : ""}
            </p>
          </li>
        ))}
        {shown.length === 0 && <li className="px-5 py-6 text-center text-xs text-slate-400">{data.tasks.length === 0 ? "No tasks have been deleted." : "Nothing matches your search."}</li>}
      </ul>
    </section>
  );
}
