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

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMe } from "../layout";
import { apiGet, apiPost , API_BASE } from "@/lib/api";
import { useTaskRealtime } from "@/lib/realtime";
import { formatDate, isoDaysAgo } from "@/lib/time";
import { DateFilter, RangeTasks, rangeFor, type RangeKey } from "./_range/RangeTasks";
import QuickAdd from "./_quick/QuickAdd";
import SelfManagedTasks, { type SelfPayload } from "./_self/SelfManagedTasks";
import { Stars } from "../_ratings/Stars";
import { BlockedReasonModal } from "../_progress/BlockedReasonModal";
import { PROGRESS_CHIP_CLASS, PROGRESS_LABEL, PROGRESS_OPTIONS, blockedReasonProblem, normalProgress, BLOCKED_REASON_MAX } from "../_progress/progress";
import { EditTaskModal } from "../_taskedit/EditTaskModal";
import { EditButton } from "../_taskedit/EditButton";
import { EditedChip } from "../_taskedit/EditedChip";
import { TaskHistoryModal } from "../_taskedit/TaskHistoryModal";
import type { EditableTask } from "../_taskedit/editTypes";
import { ViewTabs } from "../_assigned/ViewTabs";
import AssignedToMe from "../_assigned/AssignedToMe";
import AssignedByMe from "../_assigned/AssignedByMe";
import AssignTasks from "../_assigned/AssignTasks";
import ReviewQueue from "../approvals/ReviewQueue";
import { type Weighted } from "../_weighted/Weighted";
import EmployeeRepetitionAlert from "./_repetition/EmployeeRepetitionAlert";

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
  // The manager's star rating (1-5) and comment; null = not rated yet.
  rating: number | null;
  ratingComment: string | null;
  completionNote: string | null;
  reviewNote: string | null;
  isCarriedOver: boolean;
  assignedBy: string | null;
  approvedBy: string | null;
  reviewedBy: string | null;
  // Daily task entry (present once the server has it switched on): progress is separate from approval.
  progress?: "TODO" | "IN_PROGRESS" | "COMPLETED" | "BLOCKED" | "NOT_STARTED";
  hoursSpent?: number | null;
  taggedManager?: string | null;
  blockedNote?: string | null;
  approvalNote?: string | null;
  project?: string | null;
  projectId?: string | null;
  // Editing (from the server): the id of the tagged manager, the version token, and what route an edit takes.
  taggedManagerId?: string | null;
  version?: number;
  editRoute?: "DIRECT" | "CORRECTION" | null;
  edited?: { at: string | null; count: number } | null;
  pendingCorrection?: boolean;
};

// For each project the person is on: who may approve its tasks (the project's managers) and who is preselected.
// Two independent lists: every project the person may pick, and every manager they may tag. Picking one never changes the other.
type EntryForm = {
  ready: boolean;
  projects: { id: string; name: string; label: string; company: string | null; ownCompany: boolean }[];
  managers: { id: string; name: string; code: string | null; role: string }[];
  // Worked out by the server from the person's team allocation and reporting line (null = the records give no single answer).
  defaults?: { projectId: string | null; managerId: string | null; projectSource: string | null; managerSource: string | null };
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
  // true for an Employee who holds the TASK_ASSIGN_COMPANY capability (a Productivity Supervisor): the "Assign Tasks" tab is shown
  canAssignCompany?: boolean;
  entryForm?: EntryForm;
  projects?: { id: string; name: string }[];
  awaitingApproval: Task[];
  rejected: Task[];
  active: Task[];
  done: Task[];
  score: Score;
  weighted?: Weighted;
};

const WEIGHTS = [
  { value: "LOW", label: "Low", points: 1 },
  { value: "MEDIUM", label: "Medium", points: 4 },
  { value: "HIGH", label: "High", points: 5 },
  { value: "CRITICAL", label: "Critical", points: 5 },
];

const WEIGHT_CHIP: Record<string, string> = {
  LOW: "bg-[#E7F6F1] text-slate-600",
  MEDIUM: "bg-sky-50 text-sky-700",
  HIGH: "bg-amber-50 text-amber-700",
  CRITICAL: "bg-rose-50 text-rose-700",
};

// Daily Tasks is the ONE place for task operations. Which part is open can come from the address (?tab=submitted | assigned), so notifications and
// dashboard links land on the right tab; Tasks & Performance (/dashboard/approvals) only shows figures.
export default function TasksPage() {
  return (
    <Suspense fallback={<div className="skeleton h-10" aria-busy="true" />}>
      <TasksPageInner />
    </Suspense>
  );
}

function TasksPageInner() {
  const me = useMe();
  const tabParam = useSearchParams().get("tab");
  // The tab the person clicked wins until the address itself changes (a link to another tab).
  const [pickedView, setPickedView] = useState<string | null>(null);
  const [seenParam, setSeenParam] = useState<string | null>(tabParam);
  if (seenParam !== tabParam) {
    setSeenParam(tabParam);
    setPickedView(null);
  }
  const [data, setData] = useState<Payload | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [weight, setWeight] = useState("MEDIUM");
  // null = the person has not chosen: the project / manager follow the default worked out from their records. "" = they chose "none".
  const [projectPick, setProjectPick] = useState<string | null>(null);
  const [taggedPick, setTaggedPick] = useState<string | null>(null);
  const [hours, setHours] = useState("");
  const [progress, setProgress] = useState("IN_PROGRESS");
  const [blockedNote, setBlockedNote] = useState("");
  // A task being switched to Blocked in the list: asks for the reason first.
  const [blockFor, setBlockFor] = useState<Task | null>(null);
  const [blockError, setBlockError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rangeKey, setRangeKey] = useState<RangeKey>("today");
  const [picked, setPicked] = useState(isoDaysAgo(1));
  const [entryMode, setEntryMode] = useState<"single" | "quick" | "previous">("single");
  // Editing a submitted task (or asking for a correction) and reading its history.
  const [editFor, setEditFor] = useState<EditableTask | null>(null);
  const [historyFor, setHistoryFor] = useState<{ id: string; title: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [rangeReload, setRangeReload] = useState(0);
  // How many previous days may be added without a reason (company setting); `ready` is false until the server has the feature.
  const [latePolicy, setLatePolicy] = useState<{ ready: boolean; allowedDays: number; maxDays: number } | null>(null);
  // Which part of Daily Tasks is open. Employee: "main" (my submitted tasks) or "assigned". Manager: "own", "submitted" (the approval queue) or "assigned".
  // Same page, no sidebar item: the switch sits at the top.
  const view = pickedView ?? (tabParam === "submitted" || tabParam === "assigned" || tabParam === "assign" ? tabParam : "main");
  const setView = setPickedView;
  // HR and Admin may open the same queue of employee-submitted tasks (they only act on tasks tagged to them; the rest is view only).
  const canReview = me?.role === "HR" || me?.role === "ADMIN";
  const [assignedOpen, setAssignedOpen] = useState(0);
  useEffect(() => {
    apiGet<{ counts: { todo: number; inProgress: number } }>("/tasks/assigned/mine").then((p) => setAssignedOpen(p.counts.todo + p.counts.inProgress)).catch(() => undefined);
  }, []);
  useEffect(() => {
    apiGet<{ ready: boolean; allowedDays: number; maxDays: number }>("/tasks/late-policy").then(setLatePolicy).catch(() => setLatePolicy(null));
  }, []);

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
      const entry = data?.entryForm?.ready === true;
      const tagged = taggedId ?? "";
      setData(
        await apiPost<Payload>("/tasks", {
          title,
          description,
          weight,
          ...(entry ? { progress, ...(progress === "BLOCKED" ? { blockedNote: blockedNote.trim() } : {}), ...(hours.trim() ? { hoursSpent: Number(hours) } : {}), ...(projectId ? { teamId: projectId } : {}), ...(tagged ? { taggedManagerId: tagged } : {}) } : {}),
        })
      );
      setTitle("");
      setDescription("");
      setWeight("MEDIUM");
      setHours("");
      setProgress("IN_PROGRESS");
      setBlockedNote("");
      setProjectPick(null); // back to the default for the next task
      setTaggedPick(null);
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

  // Switching to Blocked first asks why (the reporting manager sees the reason); every other progress is saved straight away.
  async function changeProgress(task: Task, next: string, reason?: string) {
    if (next === "BLOCKED" && reason === undefined) {
      setBlockError("");
      setBlockFor(task);
      return;
    }
    setBusy(true);
    setError("");
    setBlockError("");
    try {
      setData(await call<Payload>(`/tasks/${task.id}`, "PATCH", { progress: next, ...(next === "BLOCKED" ? { blockedNote: reason } : {}) }));
      setBlockFor(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not update that";
      if (next === "BLOCKED") setBlockError(msg);
      else setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function afterEdit(message: string) {
    setEditFor(null);
    if (message) setNotice(message);
    await load();
    setRangeReload((n) => n + 1);
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
  // Project and manager are chosen independently; nothing is preselected and one never changes the other.
  const projectList = data?.entryForm?.ready ? data.entryForm.projects : (data?.projects ?? []).map((p) => ({ ...p, label: p.name, company: null as string | null, ownCompany: true }));
  const managerList = data?.entryForm?.managers ?? [];
  const needProject = projectList.length > 0;
  const needManager = managerList.length > 0;
  // What the form shows: the person's own choice once they make one, otherwise the default from their team allocation and reporting line.
  const formDefaults = data?.entryForm?.ready ? data.entryForm.defaults : undefined;
  const projectId = projectPick ?? formDefaults?.projectId ?? "";
  const taggedId: string | null = taggedPick === null ? formDefaults?.managerId ?? null : taggedPick || null;
  const projectIsDefault = !!projectId && projectId === formDefaults?.projectId;
  const managerIsDefault = !!taggedId && taggedId === formDefaults?.managerId;

  // A manager's own work: self-managed, no approval. Employees (and everyone else) keep the screen below.
  if (data?.selfManagedMode) {
    const mgrView = view === "submitted" || view === "assigned" ? view : "own";
    return (
      <div className="space-y-5">
        <ViewTabs
          value={mgrView}
          onChange={setView}
          tabs={[{ key: "own", label: "My own tasks" }, { key: "submitted", label: "Employee submitted tasks" }, { key: "assigned", label: "Assigned by me" }]}
        />
        {mgrView === "own" && <SelfManagedTasks data={data as unknown as SelfPayload} onData={(p) => setData(p as unknown as Payload)} error={error} setError={setError} />}
        {mgrView === "submitted" && <ReviewQueue />}
        {mgrView === "assigned" && <AssignedByMe />}
      </div>
    );
  }

  // The Admin's Daily Tasks: no tasks of their own. They see what employees submitted and can assign tasks to employees (owner decision 2026-11-21).
  if (me?.role === "ADMIN") {
    const adminView = view === "assigned" ? "assigned" : "submitted";
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Daily tasks</h1>
        </header>
        <ViewTabs value={adminView} onChange={setView} tabs={[{ key: "submitted", label: "Employee submitted tasks" }, { key: "assigned", label: "Assigned by me" }]} />
        {adminView === "submitted" ? <ReviewQueue /> : <AssignedByMe />}
      </div>
    );
  }

  // An employee's "Assigned by manager" part of the same page.
  const canAssign = data?.canAssignCompany === true && me?.role === "EMPLOYEE";
  const employeeTabs = [
    { key: "main", label: "My submitted tasks" },
    ...(canReview ? [{ key: "submitted", label: "Employee submitted tasks" }] : []),
    { key: "assigned", label: "Assigned by manager", badge: assignedOpen },
    ...(canAssign ? [{ key: "assign", label: "Assign Tasks" }] : []),
  ];
  if (view === "assign" && canAssign) {
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Daily tasks</h1>
        </header>
        <ViewTabs value="assign" onChange={setView} tabs={employeeTabs} />
        <AssignTasks />
      </div>
    );
  }
  if (view === "submitted" && canReview) {
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Daily tasks</h1>
        </header>
        <ViewTabs value="submitted" onChange={setView} tabs={employeeTabs} />
        <ReviewQueue />
      </div>
    );
  }
  if (view === "assigned") {
    return (
      <div className="space-y-5">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Daily tasks</h1>
        </header>
        <ViewTabs value="assigned" onChange={setView} tabs={employeeTabs} />
        <AssignedToMe onCount={setAssignedOpen} />
      </div>
    );
  }

  const editChoices = {
    projects: (data?.entryForm?.ready ? data.entryForm.projects : []).map((p) => ({ id: p.id, label: p.label })),
    managers: data?.entryForm?.managers ?? [],
  };

  return (
    <div className="space-y-5">
      {editFor && <EditTaskModal task={editFor} choices={editChoices} latePolicy={latePolicy} onClose={() => setEditFor(null)} onSaved={(m) => void afterEdit(m)} />}
      {historyFor && <TaskHistoryModal taskId={historyFor.id} title={historyFor.title} onClose={() => setHistoryFor(null)} />}
      {notice && (
        <div role="status" className="flex items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice("")} className="shrink-0 text-emerald-700 hover:underline" aria-label="Dismiss">Dismiss</button>
        </div>
      )}
      {blockFor && (
        <BlockedReasonModal
          title={blockFor.title}
          initial={blockFor.progress === "BLOCKED" ? blockFor.blockedNote ?? "" : ""}
          busy={busy}
          error={blockError}
          onSubmit={(reason) => void changeProgress(blockFor, "BLOCKED", reason)}
          onCancel={() => setBlockFor(null)}
        />
      )}
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

      <ViewTabs value="main" onChange={setView} tabs={employeeTabs} />

      <EmployeeRepetitionAlert />

      <DateFilter value={rangeKey} picked={picked} onChange={(k, p) => { setRangeKey(k); setPicked(p); }} />
      {rangeKey !== "today" && <RangeTasks {...rangeFor(rangeKey, picked)} choices={editChoices} latePolicy={latePolicy} reloadKey={rangeReload} onChanged={() => void load()} />}
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
            Every task counts the same, whatever its priority. Your Overall Performance Score
            (60% completion, 40% manager rating) is under Reports.
          </p>
        </section>
      )}

      {/* --- propose ------------------------------------------------------ */}
      {data?.entryForm?.ready && (
        <div role="tablist" aria-label="How do you want to add tasks?" className="flex w-full flex-col gap-1 rounded-xl bg-white p-1 shadow-[var(--shadow-card)] sm:inline-flex sm:w-auto sm:flex-row sm:gap-0">
          {([["single", "Add Single Task"], ["quick", "Quick Add (Multiple Tasks)"], ["previous", "Add Previous Day's Tasks"]] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={entryMode === k}
              onClick={() => setEntryMode(k)}
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium transition sm:flex-none ${entryMode === k ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-indigo-50"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {data?.entryForm?.ready && entryMode === "quick" && (
        <QuickAdd key="today" projects={data.entryForm.projects} managers={data.entryForm.managers} defaults={data.entryForm.defaults} onSent={() => void load()} />
      )}
      {data?.entryForm?.ready && entryMode === "previous" && (
        latePolicy?.ready ? (
          <QuickAdd key="previous" previous={{ allowedDays: latePolicy.allowedDays, maxDays: latePolicy.maxDays }} projects={data.entryForm.projects} managers={data.entryForm.managers} defaults={data.entryForm.defaults} onSent={() => void load()} />
        ) : (
          <p className="rounded-2xl bg-white p-5 text-sm text-slate-600 shadow-[var(--shadow-card)]">Adding tasks for a previous day is not switched on yet. Please ask your Admin.</p>
        )
      )}
      {!(data?.entryForm?.ready && entryMode !== "single") && <form
        onSubmit={propose}
        className="rounded-2xl bg-white shadow-[var(--shadow-card)] p-5 space-y-4"
      >
        <label className="block text-xs text-slate-500">
          Task description <span className="text-rose-500">*</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What do you plan to do today?"
            className="mt-1 w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500"
          />
        </label>

        <label className="block text-xs text-slate-500">
          Additional details <span className="text-slate-400">(optional)</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Any detail your manager needs"
            className="mt-1 w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500"
          />
        </label>

        {data?.entryForm?.ready && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="min-w-0 text-xs text-slate-500">
              Select Project{needProject && <span className="text-rose-500"> *</span>}
              <select value={projectId} required={needProject} disabled={!needProject} onChange={(e) => setProjectPick(e.target.value)} title={projectList.find((p) => p.id === projectId)?.label} className="mt-1 w-full min-w-0 rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 truncate">
                <option value="">{needProject ? "Select a project" : "No project available"}</option>
                {projectList.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              {projectIsDefault && <span className="mt-1 block text-[11px] text-emerald-700">{formDefaults?.projectSource === "PRIMARY_TEAM" ? "Your main team" : "Your team"} (you can change it)</span>}
            </label>
            <label className="min-w-0 text-xs text-slate-500">
              Tag Reporting Manager{needManager && <span className="text-rose-500"> *</span>}
              <select value={taggedId ?? ""} required={needManager} disabled={!needManager} onChange={(e) => setTaggedPick(e.target.value)} title={managerList.find((m) => m.id === taggedId)?.name} className="mt-1 w-full min-w-0 rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 truncate">
                <option value="">{needManager ? "Select a manager" : "No manager available"}</option>
                {managerList.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}{o.code ? ` (${o.code})` : ""}{o.role === "ADMIN" ? " \u00b7 Admin" : ""}</option>
                ))}
              </select>
              {managerIsDefault && <span className="mt-1 block text-[11px] text-emerald-700">{formDefaults?.managerSource === "REPORTING_MANAGER" ? "Your reporting manager" : "Your additional reporting manager"} (you can change it)</span>}
              {!needManager && <span className="mt-1 block text-[11px] text-amber-600">No manager is available. Ask HR or your Admin.</span>}
            </label>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {data?.entryForm?.ready && (
            <>
              <div className="min-w-0 text-xs text-slate-500">
                Date
                <p className="mt-1 w-full truncate rounded-xl border border-indigo-100 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">{formatDate(new Date(), { day: "numeric", month: "short", year: "numeric" })}</p>
              </div>
              <label className="min-w-0 text-xs text-slate-500">
                Hours spent
                <input type="number" min={0} max={24} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} placeholder="0" className="mt-1 w-full min-w-0 rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500" />
              </label>
              <label className="min-w-0 text-xs text-slate-500">
                Progress
                <select value={progress} onChange={(e) => setProgress(e.target.value)} className="mt-1 w-full min-w-0 rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500">
                  {PROGRESS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="min-w-0 text-xs text-slate-500">
            Task priority
            <select value={weight} onChange={(e) => setWeight(e.target.value)} className="mt-1 w-full min-w-0 rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500">
              {WEIGHTS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label} · {w.points}pt
                </option>
              ))}
            </select>
          </label>
        </div>

        {data?.entryForm?.ready && progress === "BLOCKED" && (
          <label className="block text-xs text-slate-500">
            Blocked reason <span className="text-rose-500">*</span>
            <textarea
              value={blockedNote}
              onChange={(e) => setBlockedNote(e.target.value)}
              maxLength={BLOCKED_REASON_MAX}
              rows={2}
              placeholder="What is stopping this task? Your reporting manager will see it."
              className="mt-1 w-full resize-y break-words rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500 [overflow-wrap:anywhere]"
            />
            <span className="mt-0.5 block text-[11px] text-slate-400">{blockedNote.length}/{BLOCKED_REASON_MAX} · at least 3 characters</span>
          </label>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy || !title.trim() || (data?.entryForm?.ready === true && ((needProject && !projectId) || (needManager && !taggedId) || (progress === "BLOCKED" && blockedReasonProblem(blockedNote) !== null)))}
            className="w-full rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40 sm:w-auto"
          >
            Send for approval
          </button>
        </div>
      </form>}

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
                <EntryMeta t={t} />
                <div className="mt-1"><EditedChip edited={t.edited} pending={t.pendingCorrection} onHistory={t.edited ? () => setHistoryFor({ id: t.id, title: t.title }) : undefined} /></div>
              </div>
              {t.progress && (
                <select aria-label="Progress" value={normalProgress(t.progress)} disabled={busy} onChange={(e) => changeProgress(t, e.target.value)} className="shrink-0 rounded-lg border border-indigo-100 px-2 py-1 text-xs text-slate-700">
                  {PROGRESS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              )}
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  WEIGHT_CHIP[t.weight]
                }`}
              >
                {t.weight.toLowerCase()}
              </span>
              <EditButton task={t} busy={busy} onEdit={() => setEditFor(t)} />
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
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm text-slate-700 line-through">{t.title}</p>
                <EditButton task={t} busy={busy} onEdit={() => setEditFor(t)} />
              </div>
              <EntryMeta t={t} />
              <div className="mt-1"><EditedChip edited={t.edited} onHistory={t.edited ? () => setHistoryFor({ id: t.id, title: t.title }) : undefined} /></div>
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
              <EntryMeta t={t} />
              <div className="mt-1"><EditedChip edited={t.edited} pending={t.pendingCorrection} onHistory={t.edited ? () => setHistoryFor({ id: t.id, title: t.title }) : undefined} /></div>
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

            <EditButton task={t} busy={busy} onEdit={() => setEditFor(t)} />

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
          hint="Your manager rates these from 1 to 5 stars. Until then they score full marks."
        >
          {data.done.map((t) => {
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-700">{t.title}</p>
                  <EntryMeta t={t} />
                  <div className="mt-1"><EditedChip edited={t.edited} pending={t.pendingCorrection} onHistory={t.edited ? () => setHistoryFor({ id: t.id, title: t.title }) : undefined} /></div>
                  {t.ratingComment ? (
                    <p className="mt-0.5 break-words text-xs text-slate-500 [overflow-wrap:anywhere]">
                      {t.reviewedBy ? `${t.reviewedBy}: ` : ""}{t.ratingComment}
                    </p>
                  ) : t.reviewNote ? (
                    <p className="mt-0.5 text-xs text-slate-500">
                      {t.reviewedBy}: {t.reviewNote}
                    </p>
                  ) : null}
                </div>

                <span className="shrink-0">
                  <Stars value={t.rating} size={16} emptyText="waiting for a rating" />
                </span>

                <EditButton task={t} busy={busy} onEdit={() => setEditFor(t)} />

                {t.rating == null && (
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

const PROGRESS_CHIP = (p: string): { label: string; cls: string } => ({ label: PROGRESS_LABEL[p] ?? p, cls: PROGRESS_CHIP_CLASS[p] ?? "bg-slate-100 text-slate-600" });
const APPROVAL_CHIP: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "Approval: Pending", cls: "bg-amber-50 text-amber-700" },
  APPROVED: { label: "Approval: Approved", cls: "bg-emerald-50 text-emerald-700" },
  REJECTED: { label: "Approval: Rejected", cls: "bg-red-50 text-red-600" },
};

// Progress (is the work done?) and approval (has the manager accepted it?) are shown as two separate chips.
function EntryMeta({ t }: { t: Task }) {
  if (!t.progress) return null;
  const p = PROGRESS_CHIP(t.progress);
  const a = APPROVAL_CHIP[t.approvalStatus];
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
      <span className={`rounded-full px-2 py-0.5 font-medium ${p.cls}`}>{p.label}</span>
      <span className={`rounded-full px-2 py-0.5 font-medium ${a.cls}`}>{a.label}</span>
      {t.hoursSpent != null && <span className="text-slate-500">{t.hoursSpent} h</span>}
      {t.project && <span className="text-slate-500">· {t.project}</span>}
      {t.taggedManager && <span className="text-slate-500">· Manager: {t.taggedManager}</span>}
      {t.progress === "BLOCKED" && t.blockedNote && <span className="text-amber-800">· Blocked: {t.blockedNote}</span>}
      {t.approvalNote && <span className="text-slate-500">· Manager's comment: “{t.approvalNote}”</span>}
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