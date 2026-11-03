// ===========================================================================
// APPROVALS — the manager's queue
//
// Two queues, in the order a manager works them: what needs agreeing to
// before anyone starts, and what needs grading now it's finished.
//
// Grading is three buttons, not a form. A manager will do this twenty times
// a day and every extra click is a reason not to bother.
// ===========================================================================

"use client";

import { useEffect, useRef, useState } from "react";
import { useTaskRealtime } from "@/lib/realtime";
import { API_BASE } from "@/lib/api";
import { todayIso } from "@/lib/time";
import { plural } from "@/lib/plural";
import { useMe } from "../layout";
import { RevertModal } from "./RevertModal";
import { EmployeePicker } from "./EmployeePicker";
import { buildPeople } from "./people";

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
  weight: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: string;
  approvalStatus: string;
  outcome: string | null;
  completionNote: string | null;
  reviewNote: string | null;
  rejectionNote: string | null;
  // Set when a manager sent the task back (Partially / Not fully completed). resubmitted = the employee finished it again.
  reopened?: { type: string; label: string; remark: string; resubmitted: boolean } | null;
  personName: string | null;
  isCarriedOver: boolean;
  createdAt: string;
};

// A task as the queue sends it: the task itself plus who it belongs to (an id, a name and an employee ID).
type Row = Task & { userId: string; who: string; employeeCode: string | null; date: string };

type Queue = {
  date: string; // the company's "today"
  teamSize: number;
  members: { id: string; name: string; employeeCode: string | null }[];
  proposals: Task[];
  toReview: Task[];
  recent: Task[];
  all: Row[];
};

// Every task belongs to exactly ONE of these, so the tab counts always add up to the total in view.
type TabKey = "waiting" | "todo" | "inProgress" | "completed" | "closed";

function bucketOf(t: { approvalStatus?: string | null; status?: string | null }): TabKey {
  const a = String(t.approvalStatus ?? "");
  const st = String(t.status ?? "");
  if (a === "PENDING") return "waiting"; // not agreed yet, whatever its status says
  if (a === "REJECTED" || st === "CANCELLED") return "closed"; // sent back, or cancelled
  if (st === "IN_PROGRESS") return "inProgress";
  if (st === "COMPLETED") return "completed"; // graded or not
  return "todo";
}

// The dates to ask the server for. null = the default view (today, plus anything older still waiting).
// Days are the company's calendar days, taken from the server's own "today".
function rangeFor(preset: string, today: string, customFrom: string, customTo: string): { from: string; to: string } | null {
  const plus = (iso: string, n: number) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };
  if (preset === "yesterday") return { from: plus(today, -1), to: plus(today, -1) };
  if (preset === "week") return { from: plus(today, -6), to: today };
  if (preset === "thisweek") {
    const [y, m, d] = today.split("-").map(Number);
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
    return { from: plus(today, -dow), to: today };
  }
  if (preset === "month") return { from: today.slice(0, 8) + "01", to: today };
  if (preset === "custom") return customFrom && customTo ? { from: customFrom, to: customTo } : null;
  return null;
}

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

const OUTCOMES = [
  { value: "COMPLETED", label: "Completed", cls: "border-emerald-300 text-emerald-700 hover:bg-emerald-50" },
  { value: "PARTIALLY_COMPLETED", label: "Partially", cls: "border-amber-300 text-amber-700 hover:bg-amber-50" },
  { value: "FAILED", label: "Not done", cls: "border-rose-300 text-rose-700 hover:bg-rose-50" },
];

const OUTCOME_CHIP: Record<string, { label: string; cls: string }> = {
  COMPLETED: { label: "completed", cls: "bg-emerald-50 text-emerald-700" },
  PARTIALLY_COMPLETED: { label: "partially done", cls: "bg-amber-50 text-amber-700" },
  FAILED: { label: "not done", cls: "bg-rose-50 text-rose-700" },
};

// The endpoint sends the person under several keys and the screen was reading
// one it never sends, so every row showed a blank name. Reading all of them
// means a rename on either side cannot silently empty this column again.
type RowLike = {
  personName?: string | null;
  name?: string | null;
  who?: string | null;
  employee?: string | null;
  employeeCode?: string | null;
  date?: string | null;
  status?: string | null;
  approvalStatus?: string | null;
  outcome?: string | null;
  id?: string;
  title?: string;
};

function dayLabel(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  const days = Math.round(
    (new Date(todayIso() + "T00:00:00Z").getTime() - d.getTime()) / 86400000
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  // Past two days an actual date is more useful than "day before yesterday",
  // which stops meaning anything once you are chasing week-old work.
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function personLabel(t: RowLike): string {
  const who = t.personName || t.name || t.who || t.employee || "Unknown";
  const code = t.employeeCode ? ` (${t.employeeCode})` : "";
  const when = dayLabel(t.date);
  return when ? `${who}${code} · ${when}` : `${who}${code}`;
}
export default function ApprovalsPage() {
  const me = useMe();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [revertFor, setRevertFor] = useState<Row | null>(null);
  const [revertError, setRevertError] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [title, setTitle] = useState("");
  const [weight, setWeight] = useState("MEDIUM");

  // ONE source of truth. Every counter, chip and list on this page is computed from the same rows (the tasks the
  // server returned for the chosen dates) by the same helpers below, so they cannot disagree:
  //   person   - the selected employee's id ("" = Everyone). An id, never a display name: two people can share one.
  //   bucketOf - the ONE tab a task belongs to, so the tabs add up to the total for the selected scope.
  // Changing the person, the tab or the dates never resets the other two.
  const [person, setPerson] = useState<string>("");
  const [preset, setPreset] = useState<string>("default");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [tab, setTab] = useState<TabKey>("waiting");
  const [reload, setReload] = useState(0);
  // The company's "today" (from the server). Until the first answer arrives, the browser's own local date.
  const [today, setToday] = useState<string>(() => todayIso());

  // Live updates: when a task of anyone in view changes, the server sends a signal and the SAME reload as an
  // approve/grade click runs (same dates, same person, same tab). While the live connection is up the page
  // polls only as a slow safety net; while it is down it polls every 30 seconds, as it always did.
  const { connected } = useTaskRealtime(() => setReload((n) => n + 1));
  const connectedRef = useRef(connected);
  useEffect(() => {
    connectedRef.current = connected;
  });

  const rows: Row[] = queue?.all ?? [];
  const inScope = person ? rows.filter((t) => t.userId === person) : rows;
  const counts: Record<TabKey, number> = { waiting: 0, todo: 0, inProgress: 0, completed: 0, closed: 0 };
  for (const t of inScope) counts[bucketOf(t)] += 1;
  const listed = inScope.filter((t) => bucketOf(t) === tab);

  // The whole reporting team for the dropdown, each with the number of tasks they have in the dates being viewed.
  const pickerPeople = buildPeople(queue?.members ?? [], rows, person);

  const range = rangeFor(preset, today, customFrom, customTo);
  const path = range ? `/tasks/review/queue?from=${range.from}&to=${range.to}` : "/tasks/review/queue";
  const waitingForDates = preset === "custom" && !range; // custom needs both ends before anything is asked

  // The only place the queue is fetched. The same dates are used by the first load, the 30-second refresh and
  // the reload after an approve/grade, so nothing quietly snaps back to "Today".
  useEffect(() => {
    if (waitingForDates) return;
    let cancelled = false;
    let lastFetch = Date.now();
    const go = async () => {
      try {
        const next = await call<Queue>(path);
        if (cancelled) return;
        lastFetch = Date.now();
        setQueue(next);
        setToday(next.date);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the queue");
      }
    };
    void go();
    const poll = setInterval(() => {
      if (!connectedRef.current || Date.now() - lastFetch > 5 * 60_000) void go();
    }, 30000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [path, waitingForDates, reload]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setReload((n) => n + 1); // re-ask for the SAME dates
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  async function sendRevert(type: "PARTIAL" | "NOT_FULL", remark: string) {
    if (!revertFor) return;
    setBusy(true);
    setRevertError("");
    try {
      await call<Queue>(`/tasks/review/${revertFor.id}/revert`, "POST", { type, remark });
      setRevertFor(null);
      setReload((n) => n + 1);
    } catch (e) {
      setRevertError(e instanceof Error ? e.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  }

  const allowed = ["MANAGER", "HR", "ADMIN"].includes(me?.role ?? "");

  if (me && !allowed) {
    return (
      <div className="p-8">
        <div className="rounded-2xl bg-white shadow-[var(--shadow-card)] p-8 text-center text-sm text-slate-600">
          Approvals are for managers.
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 page-5xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Team tasks</h1>
        <p className="mt-1 text-sm text-slate-500">
          Agree the work before it starts, grade it once it's done.
          {queue ? ` ${plural(queue.teamSize, "person", "people")} in your teams.` : ""}
        </p>
        <p className={"mt-1.5 inline-flex items-center gap-1.5 text-xs " + (connected ? "text-emerald-600" : "text-amber-600")} aria-live="polite">
          <span className={"h-1.5 w-1.5 rounded-full " + (connected ? "bg-emerald-500" : "bg-amber-400")} />
          {connected ? "Live: changes appear as they happen" : "Reconnecting… checking for changes every 30 seconds"}
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {revertFor && (
        <RevertModal title={revertFor.title} who={personLabel(revertFor as RowLike)} busy={busy} error={revertError} onSubmit={(type, remark) => void sendRevert(type, remark)} onCancel={() => setRevertFor(null)} />
      )}

      {/* --- assign ------------------------------------------------------- */}
      {/* --- who, what state, when --------------------------------------- */}
      <section className="rounded-2xl rounded-b-none border border-b-0 border-indigo-100 bg-white">
        {/* who: one searchable dropdown (default Everyone) instead of a row of name chips */}
        <div className="px-4 py-3">
          <EmployeePicker people={pickerPeople} total={rows.length} value={person} onChange={setPerson} />
        </div>

        {/* state + when */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-indigo-50 px-4">
          <div className="flex flex-wrap items-center gap-6">
            {([
              { key: "waiting", label: "Needs approval", n: counts.waiting },
              { key: "todo", label: "To do", n: counts.todo },
              { key: "inProgress", label: "In progress", n: counts.inProgress },
              { key: "completed", label: "Completed", n: counts.completed },
              { key: "closed", label: "Closed", n: counts.closed },
            ] as { key: TabKey; label: string; n: number }[]).map((o) => (
              <button
                key={o.key}
                onClick={() => setTab(o.key)}
                className={`-mb-px flex items-center gap-2 border-b-2 py-3 text-sm transition ${
                  tab === o.key
                    ? "border-indigo-600 font-semibold text-indigo-700"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {o.label}
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${
                    tab === o.key
                      ? "bg-indigo-100 text-indigo-700"
                      : "bg-[#EEF0FD] text-slate-500"
                  }`}
                >
                  {o.n}
                </span>
              </button>
            ))}
          </div>

          <div className="relative py-2">
            <select
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              className="rounded-xl border border-indigo-100 bg-white px-3 py-1.5 text-sm text-slate-700"
            >
              <option value="default">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="week">Last 7 days</option>
              <option value="thisweek">This week</option>
              <option value="month">This month</option>
              <option value="custom">Custom dates</option>
            </select>
          </div>
        </div>

        {preset === "custom" && (
          <div className="flex flex-wrap items-center gap-2 border-t border-indigo-50 px-4 py-3">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-xl border border-indigo-100 px-2 py-1 text-xs"
            />
            <span className="text-xs text-slate-400">to</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-xl border border-indigo-100 px-2 py-1 text-xs"
            />
          </div>
        )}
      </section>

      {/* --- who and when ------------------------------------------------ */}
      {/* --- proposals ---------------------------------------------------- */}
      {tab === "waiting" && (
      <section className="overflow-hidden rounded-2xl rounded-t-none bg-white shadow-[var(--shadow-card)]">
        <div className="border-b border-indigo-50 px-5 py-3.5">
          <p className="mt-0.5 text-xs text-slate-400">
            Until you approve these, they don't count for anyone.
          </p>
        </div>

        <ul className="divide-y divide-indigo-50">
          {listed.length === 0 && (
            <li className="px-5 py-8 text-center text-sm text-slate-400">
              Nothing waiting.
            </li>
          )}

          {listed.map((t) => (
            <li key={t.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-900">{t.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {personLabel(t as RowLike)}
                    {t.isCarriedOver && " · carried over"}
                  </p>
                  {t.description && (
                    <p className="mt-1 text-xs text-slate-500">{t.description}</p>
                  )}
                </div>

                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    WEIGHT_CHIP[t.weight]
                  }`}
                >
                  {t.weight.toLowerCase()}
                </span>

                <div className="flex shrink-0 gap-2">
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        call<Queue>(`/tasks/review/${t.id}/approve`, "POST", {
                          approve: true,
                        })
                      )
                    }
                    className="rounded-xl bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-700 disabled:opacity-40"
                  >
                    Approve
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setRejecting(rejecting === t.id ? null : t.id);
                      setReason("");
                    }}
                    className="rounded-xl border border-indigo-200 px-4 py-1.5 text-xs font-medium text-slate-600 transition hover:border-rose-300 hover:text-rose-700 disabled:opacity-40"
                  >
                    Send back
                  </button>
                </div>
              </div>

              {rejecting === t.id && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    autoFocus
                    placeholder="Why are you sending it back? They'll see this."
                    className="min-w-56 flex-1 rounded-xl border border-indigo-200 px-3 py-2 text-sm outline-none focus:border-indigo-500"
                  />
                  <button
                    disabled={busy || !reason.trim()}
                    onClick={() =>
                      run(async () => {
                        const next = await call<Queue>(
                          `/tasks/review/${t.id}/approve`,
                          "POST",
                          { approve: false, rejectionNote: reason }
                        );
                        setRejecting(null);
                        setReason("");
                        return next;
                      })
                    }
                    className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-700 disabled:opacity-40"
                  >
                    Send back
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      )}

      {/* --- to grade ------------------------------------------------------ */}
      {/* --- work already approved -------------------------------------- */}
      {["todo", "inProgress"].includes(tab) && (
      <section className="overflow-hidden rounded-2xl rounded-t-none bg-white shadow-[var(--shadow-card)]">
        <div className="border-b border-indigo-50 px-5 py-3.5">
          <p className="mt-0.5 text-xs text-slate-400">
            What you have already approved, and where it has got to.
          </p>
        </div>

        <ul className="divide-y divide-indigo-50">
          {listed.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-slate-900">{t.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">{personLabel(t as RowLike)}</p>
                {t.reopened && !t.reopened.resubmitted && (
                  <p className="mt-1 rounded-lg bg-violet-50 px-2.5 py-1.5 text-xs text-violet-900"><span className="font-medium">Reopened · {t.reopened.label}:</span> {t.reopened.remark}</p>
                )}
              </div>
            </li>
          ))}

          {listed.length === 0 && (
            <li className="px-5 py-6 text-center text-xs text-slate-400">
              Nothing here.
            </li>
          )}
        </ul>
      </section>
      )}

      {tab === "completed" && (
      <section className="overflow-hidden rounded-2xl rounded-t-none bg-white shadow-[var(--shadow-card)]">
        <div className="border-b border-indigo-50 px-5 py-3.5">
          <p className="mt-0.5 text-xs text-slate-400">
            Until you grade a task it scores full marks.
          </p>
        </div>

        <ul className="divide-y divide-indigo-50">
          {listed.length === 0 && (
            <li className="px-5 py-8 text-center text-sm text-slate-400">
              Nothing completed.
            </li>
          )}

          {listed.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900">{t.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">{personLabel(t as RowLike)}</p>
                {t.completionNote && (
                  <p className="mt-1 text-xs text-slate-500">
                    Their note: {t.completionNote}
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

              {t.reopened?.resubmitted && <span className="shrink-0 rounded bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700" title={`Reopened (${t.reopened.label}) and finished again`}>resubmitted</span>}
              <button
                type="button"
                disabled={busy}
                onClick={() => { setRevertError(""); setRevertFor(t as Row); }}
                title="Send this task back to In Progress with a remark"
                className="shrink-0 rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-medium text-indigo-700 transition hover:bg-indigo-50 disabled:opacity-40"
              >
                Revert / Reopen
              </button>
              {t.outcome ? (
                <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${OUTCOME_CHIP[t.outcome]?.cls ?? ""}`}>
                  {OUTCOME_CHIP[t.outcome]?.label ?? String(t.outcome).toLowerCase()}
                </span>
              ) : (
              <div className="flex shrink-0 gap-2">
                {OUTCOMES.map((o) => (
                  <button
                    key={o.value}
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        call<Queue>(`/tasks/review/${t.id}/outcome`, "POST", {
                          outcome: o.value,
                        })
                      )
                    }
                    className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${o.cls}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      )}

      {/* --- recent -------------------------------------------------------- */}
      {tab === "closed" && (
        <section className="overflow-hidden rounded-2xl rounded-t-none bg-white shadow-[var(--shadow-card)]">
          <div className="border-b border-indigo-50 px-5 py-3.5">
            <p className="mt-0.5 text-xs text-slate-400">
              Work that was sent back or cancelled. It does not count for anyone.
            </p>
          </div>
          <ul className="divide-y divide-indigo-50">
            {listed.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-900">{t.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{personLabel(t as RowLike)}</p>
                  {t.rejectionNote && <p className="mt-1 text-xs text-slate-500">Sent back: {t.rejectionNote}</p>}
                </div>
                <span className="shrink-0 rounded px-2 py-0.5 text-xs font-medium bg-rose-50 text-rose-700">
                  {t.approvalStatus === "REJECTED" ? "sent back" : "cancelled"}
                </span>
              </li>
            ))}
            {listed.length === 0 && <li className="px-5 py-6 text-center text-xs text-slate-400">Nothing here.</li>}
          </ul>
        </section>
      )}
    </div>
  );
}