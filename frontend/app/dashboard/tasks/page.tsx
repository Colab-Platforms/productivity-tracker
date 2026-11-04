// ===========================================================================
// DAILY TASKS — the employee's side
//
// Three states, three sections, in the order they happen: what you've asked
// to do, what you've been cleared to do, and what came of it.
//
// A proposal is visibly not counted — greyed, no points — because the whole
// point of approval is that unapproved work isn't work yet.
// ===========================================================================

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost , API_BASE } from "@/lib/api";
import { useTaskRealtime } from "@/lib/realtime";
import { formatDate, isoDaysAgo } from "@/lib/time";
import { DateFilter, RangeTasks, rangeFor, type RangeKey } from "./_range/RangeTasks";
import SelfManagedTasks, { type SelfPayload } from "./_self/SelfManagedTasks";

const API = API_BASE;

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${
        typeof window === "undefined" ? "" : localStorage.getItem("token") ?? ""
      }`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "That didn't work");
  return data as T;
}

type Task = {
  id: string;
  title: string;
  description: string | null;
  date: string;
  weight: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  approvalStatus: "PENDING" | "APPROVED" | "REJECTED";
  rejectionNote: string | null;
  // Set when a manager reopened the task. fromEarlierDay = it belongs to a past day but is shown here because it is unfinished again.
  reopened?: { type: string; label: string; remark: string; resubmitted: boolean } | null;
  fromEarlierDay?: boolean;
  outcome: "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED" | null;
  completionNote: string | null;
  reviewNote: string | null;
  isCarriedOver: boolean;
  assignedBy: string | null;
  approvedBy: string | null;
  reviewedBy: string | null;
};

type Score = {
  totalWeight: number;
  doneWeight: number;
  percent: number;
  total: number;
  completed: number;
  awaitingApproval: number;
};

type Payload = {
  // true for a manager once self-managed tasks are available: his own tasks need no approval (see _self/SelfManagedTasks)
  selfManagedMode?: boolean;
  awaitingApproval: Task[];
  rejected: Task[];
  active: Task[];
  done: Task[];
  score: Score;
};

const WEIGHTS = [
  { value: "LOW", label: "Low", points: 1 },
  { value: "MEDIUM", label: "Medium", points: 2 },
  { value: "HIGH", label: "High", points: 3 },
  { value: "CRITICAL", label: "Critical", points: 5 },
];

const WEIGHT_CHIP: Record<string, string> = {
  LOW: "bg-[#EEF0FD] text-slate-600",
  MEDIUM: "bg-sky-50 text-sky-700",
  HIGH: "bg-amber-50 text-amber-700",
  CRITICAL: "bg-rose-50 text-rose-700",
};

const OUTCOME_CHIP: Record<string, { label: string; cls: string }> = {
  COMPLETED: { label: "Completed", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  PARTIALLY_COMPLETED: {
    label: "Partially done",
    cls: "bg-amber-50 text-amber-700 ring-amber-200",
  },
  FAILED: { label: "Not done", cls: "bg-rose-50 text-rose-700 ring-rose-200" },
};

export default function TasksPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [weight, setWeight] = useState("MEDIUM");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rangeKey, setRangeKey] = useState<RangeKey>("today");
  const [picked, setPicked] = useState(isoDaysAgo(1));

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Payload>("/tasks"));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your tasks");
    }
  }, []);

  // Live updates: the server signals when one of MY tasks changes (a manager assigns, approves or grades it),
  // and the page reloads at once. While the live connection is up the 30-second poll is only a slow safety net.
  const { connected } = useTaskRealtime(() => void load());
  const connectedRef = useRef(connected);
  useEffect(() => {
    connectedRef.current = connected;
  });

  useEffect(() => {
    void load();
    let last = Date.now();
    const poll = setInterval(() => {
      if (!connectedRef.current || Date.now() - last > 5 * 60_000) {
        last = Date.now();
        void load();
      }
    }, 30000);
    return () => clearInterval(poll);
  }, [load]);

  async function propose(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError("");
    try {
      setData(await apiPost<Payload>("/tasks", { title, description, weight }));
      setTitle("");
      setDescription("");
      setWeight("MEDIUM");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(task: Task, status: string) {
    setBusy(true);
    setError("");
    try {
      setData(await call<Payload>(`/tasks/${task.id}`, "PATCH", { status }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that");
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(task: Task) {
    setBusy(true);
    setError("");
    try {
      setData(await call<Payload>(`/tasks/${task.id}`, "DELETE"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that");
    } finally {
      setBusy(false);
    }
  }

  const score = data?.score;

  // A manager's own work: self-managed, no approval. Employees (and everyone else) keep the screen below.
  if (data?.selfManagedMode) {
    return <SelfManagedTasks data={data as unknown as SelfPayload} onData={(p) => setData(p as unknown as Payload)} error={error} setError={setError} />;
  }

  return (
    <div className="p-8 page-4xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Daily tasks
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {formatDate(new Date(), {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </p>
      </header>

      <DateFilter value={rangeKey} picked={picked} onChange={(k, p) => { setRangeKey(k); setPicked(p); }} />
      {rangeKey !== "today" && <RangeTasks {...rangeFor(rangeKey, picked)} />}
      {rangeKey !== "today" ? null : <>
      {/* --- score ------------------------------------------------------- */}
      {score && (
        <section className="rounded-2xl bg-indigo-600 p-6 text-white">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-4xl font-semibold tabular-nums tracking-tight">
                {score.percent}%
              </p>
              <p className="mt-1 text-sm text-indigo-100">
                {score.completed} of {score.total} approved tasks ·{" "}
                <span className="tabular-nums">
                  {score.doneWeight}/{score.totalWeight}
                </span>{" "}
                points
              </p>
            </div>
            {score.awaitingApproval > 0 && (
              <p className="rounded-xl bg-white/15 px-3 py-1.5 text-xs text-indigo-100">
                {score.awaitingApproval} waiting on your manager — not counted yet
              </p>
            )}
          </div>

          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full bg-emerald-400 transition-all duration-700"
              style={{ width: `${score.percent}%` }}
            />
          </div>

          <p className="mt-3 text-xs text-indigo-200">
            Weighted — a critical task counts five times a low one. Partially done work
            scores half.
          </p>
        </section>
      )}

      {/* --- propose ------------------------------------------------------ */}
      <form
        onSubmit={propose}
        className="rounded-2xl bg-white shadow-[var(--shadow-card)] p-4 space-y-3"
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What do you plan to do today?"
          className="w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500"
        />

        <div className="flex flex-wrap gap-2">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Any detail your manager needs (optional)"
            className="min-w-56 flex-1 rounded-xl border border-indigo-200 px-3 py-2 text-sm outline-none placeholder:text-slate-400 focus:border-indigo-500"
          />
          <select
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            className="rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900"
          >
            {WEIGHTS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label} · {w.points}pt
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40"
          >
            Send for approval
          </button>
        </div>
      </form>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {/* --- awaiting approval -------------------------------------------- */}
      {data && data.awaitingApproval.length > 0 && (
        <Section
          title="Waiting for approval"
          hint="Your manager hasn't decided yet. These don't count towards your score."
        >
          {data.awaitingApproval.map((t) => (
            <li key={t.id} className="flex items-start gap-3 px-5 py-3.5">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-500">{t.title}</p>
                {t.description && (
                  <p className="mt-0.5 text-xs text-slate-400">{t.description}</p>
                )}
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  WEIGHT_CHIP[t.weight]
                }`}
              >
                {t.weight.toLowerCase()}
              </span>
              <button
                onClick={() => withdraw(t)}
                disabled={busy}
                className="shrink-0 text-xs text-slate-300 transition hover:text-rose-600"
              >
                Withdraw
              </button>
            </li>
          ))}
        </Section>
      )}

      {/* --- rejected ------------------------------------------------------ */}
      {data && data.rejected.length > 0 && (
        <Section title="Sent back" hint="Read the reason, then propose it again.">
          {data.rejected.map((t) => (
            <li key={t.id} className="px-5 py-3.5">
              <p className="text-sm text-slate-700 line-through">{t.title}</p>
              {t.rejectionNote && (
                <p className="mt-1 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700">
                  {t.approvedBy ?? "Your manager"}: {t.rejectionNote}
                </p>
              )}
            </li>
          ))}
        </Section>
      )}

      {/* --- today's work --------------------------------------------------- */}
      <Section
        title={`Today's work (${data?.active.length ?? 0})`}
        hint="Approved and counting. Move each one along as you go."
      >
        {data?.active.length === 0 && (
          <li className="px-5 py-8 text-center text-sm text-slate-400">
            Nothing approved yet.
          </li>
        )}
        {data?.active.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                t.status === "IN_PROGRESS" ? "animate-pulse bg-sky-500" : "bg-slate-300"
              }`}
            />

            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-900">{t.title}</p>
              <p className="mt-0.5 text-xs text-slate-400">
                {t.assignedBy
                  ? `Assigned by ${t.assignedBy}`
                  : `Approved by ${t.approvedBy ?? "your manager"}`}
                {t.isCarriedOver && " · carried over"}
                {t.fromEarlierDay && ` · from ${t.date}`}
              </p>
              {t.reopened && (
                <p className="mt-1.5 rounded-lg bg-violet-50 px-2.5 py-1.5 text-xs text-violet-900">
                  <span className="font-medium">Reopened by your manager · {t.reopened.label}:</span> {t.reopened.remark}
                </p>
              )}
            </div>

            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                WEIGHT_CHIP[t.weight]
              }`}
            >
              {t.weight.toLowerCase()}
            </span>

            {t.status === "PENDING" ? (
              <button
                onClick={() => setStatus(t, "IN_PROGRESS")}
                disabled={busy}
                className="shrink-0 rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-sky-400 hover:text-sky-700 disabled:opacity-40"
              >
                Start
              </button>
            ) : (
              <button
                onClick={() => setStatus(t, "PENDING")}
                disabled={busy}
                className="shrink-0 rounded-xl border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-medium text-sky-700 transition hover:bg-sky-100 disabled:opacity-40"
              >
                In progress
              </button>
            )}

            <button
              onClick={() => setStatus(t, "COMPLETED")}
              disabled={busy}
              className="shrink-0 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40"
            >
              Mark done
            </button>
          </li>
        ))}
      </Section>

      {/* --- done ----------------------------------------------------------- */}
      {data && data.done.length > 0 && (
        <Section
          title={`Done (${data.done.length})`}
          hint="Your manager grades these. Until then they score full marks."
        >
          {data.done.map((t) => {
            const grade = t.outcome ? OUTCOME_CHIP[t.outcome] : null;
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-700">{t.title}</p>
                  {t.reviewNote && (
                    <p className="mt-0.5 text-xs text-slate-500">
                      {t.reviewedBy}: {t.reviewNote}
                    </p>
                  )}
                </div>

                {grade ? (
                  <span
                    className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ${grade.cls}`}
                  >
                    {grade.label}
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-slate-400">
                    waiting on review
                  </span>
                )}

                {!t.outcome && (
                  <button
                    onClick={() => setStatus(t, "IN_PROGRESS")}
                    disabled={busy}
                    className="shrink-0 text-xs text-slate-300 transition hover:text-slate-700"
                  >
                    Reopen
                  </button>
                )}
              </li>
            );
          })}
        </Section>
      )}
      </>}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
      <div className="border-b border-indigo-50 px-5 py-3.5">
        <h2 className="text-sm font-medium text-slate-900">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
      </div>
      <ul className="divide-y divide-indigo-50">{children}</ul>
    </section>
  );
}