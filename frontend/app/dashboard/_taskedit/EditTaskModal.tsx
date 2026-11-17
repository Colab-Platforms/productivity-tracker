"use client";

// Edit a submitted task, or ask for a correction to an approved / rated one. The same fields and rules as the "Add task" form.
//  - Edit mode (pending or sent back): every field, then a confirmation; the task goes (back) to the manager for approval.
//  - Correction mode (approved or rated): date and approving manager are fixed, a reason is required, and nothing changes until the manager approves.
// The server enforces every rule; this screen only guides and shows the messages.

import { useState } from "react";
import { apiPost } from "@/lib/api";
import { isoDaysAgo, todayIso } from "@/lib/time";
import { Modal } from "../_employees/Modal";
import { BLOCKED_REASON_MAX, PROGRESS_OPTIONS, blockedReasonProblem } from "../_progress/progress";
import { fieldChanges, type EditChoices, type EditableTask } from "./editTypes";

const WEIGHTS = [
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
  { value: "CRITICAL", label: "Critical" },
];
const input = "mt-1 w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500 disabled:bg-slate-50 disabled:text-slate-500";
const normProgress = (p?: string | null) => (p === "NOT_STARTED" || !p ? "TODO" : p);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function EditTaskModal({
  task,
  choices,
  latePolicy,
  onClose,
  onSaved,
}: {
  task: EditableTask;
  choices: EditChoices;
  latePolicy: { ready: boolean; allowedDays: number; maxDays: number } | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const correction = task.editRoute === "CORRECTION";
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [projectId, setProjectId] = useState(task.projectId ?? "");
  const [managerId, setManagerId] = useState(task.taggedManagerId ?? "");
  const [date, setDate] = useState(task.date);
  const [hours, setHours] = useState(task.hoursSpent == null ? "" : String(task.hoursSpent));
  const [weight, setWeight] = useState(task.weight);
  const [progress, setProgress] = useState(normProgress(task.progress));
  const [blockedNote, setBlockedNote] = useState(task.progress === "BLOCKED" ? task.blockedNote ?? "" : "");
  const [lateReason, setLateReason] = useState("");
  const [reason, setReason] = useState("");
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);

  // The task's own current project / manager stay selectable even if they are no longer on the offered list.
  const projects = choices.projects.some((p) => p.id === task.projectId) || !task.projectId ? choices.projects : [{ id: task.projectId, label: task.project ?? "Current project" }, ...choices.projects];
  const managers = choices.managers.some((m) => m.id === task.taggedManagerId) || !task.taggedManagerId ? choices.managers : [{ id: task.taggedManagerId, name: task.taggedManager ?? "Current manager" }, ...choices.managers];
  const projectName = (id: string) => projects.find((p) => p.id === id)?.label ?? null;
  const managerName = (id: string) => managers.find((m) => m.id === id)?.name ?? null;

  const today = todayIso();
  const lateBy = date < today ? daysBetween(date, today) : 0;
  const dateChanged = date !== task.date;
  const outsideWindow = !correction && dateChanged && lateBy > (latePolicy?.allowedDays ?? 3);
  const tooOld = !correction && dateChanged && lateBy > (latePolicy?.maxDays ?? 14);

  const before: Record<string, unknown> = { title: task.title, description: task.description ?? "", projectId: task.projectId ?? "", project: task.project, managerId: task.taggedManagerId ?? "", manager: task.taggedManager, date: task.date, hoursSpent: task.hoursSpent ?? null, priority: task.weight, progress: normProgress(task.progress), blockedReason: task.progress === "BLOCKED" ? task.blockedNote ?? "" : null };
  const after: Record<string, unknown> = { title: title.trim(), description: description.trim(), projectId, project: projectName(projectId), managerId, manager: managerName(managerId), date, hoursSpent: hours.trim() === "" ? null : Number(hours), priority: weight, progress, blockedReason: progress === "BLOCKED" ? blockedNote.trim() : null };
  const changes = fieldChanges(
    Object.fromEntries(Object.entries(before).filter(([k]) => !correction || (k !== "date" && k !== "managerId" && k !== "manager"))),
    Object.fromEntries(Object.entries(after).filter(([k]) => !correction || (k !== "date" && k !== "managerId" && k !== "manager")))
  ).filter((c) => c.from !== c.to && !(c.from === "—" && c.to === "—"));

  function problem(): string | null {
    if (!title.trim()) return "Write what the task is.";
    if (title.trim().length > 200) return "Keep the task under 200 characters.";
    if (projects.length > 0 && !projectId) return "Select the project this task belongs to.";
    if (!correction && managers.length > 0 && !managerId) return "Select the reporting manager who should review this task.";
    if (hours.trim() !== "" && (!Number.isFinite(Number(hours)) || Number(hours) < 0 || Number(hours) > 24)) return "Hours spent must be a number from 0 to 24.";
    if (progress === "BLOCKED") {
      const b = blockedReasonProblem(blockedNote);
      if (b) return b;
    }
    if (!correction && date > today) return "A task can't be dated in the future.";
    if (tooOld) return `That date is too old. Tasks can be moved back ${latePolicy?.maxDays ?? 14} days at most.`;
    if (outsideWindow && lateReason.trim().length < 3) return "Add a reason (at least 3 characters) for moving it this far back.";
    if (correction && reason.trim().length < 3) return "Say why the correction is needed (at least 3 characters).";
    if (changes.length === 0) return "Nothing has changed yet.";
    return null;
  }
  const formProblem = problem();

  async function save() {
    setBusy(true);
    setError("");
    try {
      const common = { title: title.trim(), description: description.trim(), teamId: projectId || undefined, hoursSpent: hours.trim() === "" ? null : Number(hours), weight, progress, ...(progress === "BLOCKED" ? { blockedNote: blockedNote.trim() } : {}) };
      if (correction) {
        await apiPost(`/tasks/${task.id}/correction`, { ...common, reason: reason.trim() });
        onSaved("Correction sent to your manager. Nothing changes until they approve it.");
      } else {
        await apiPost(`/tasks/${task.id}/edit`, { ...common, version: task.version, taggedManagerId: managerId || undefined, date, ...(outsideWindow ? { lateReason: lateReason.trim() } : {}) });
        onSaved(task.approvalStatus === "REJECTED" ? "Saved and sent back to your manager for approval." : "Saved. Your manager has been told it was updated.");
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      setError(err.message || "Could not save that");
      if (err.code === "EDITED_ELSEWHERE" || /changed by someone else/i.test(err.message)) setStale(true);
      setStep("form");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={correction ? "Request a correction" : "Edit task"}
      subtitle={correction ? "This task is already approved. Your manager must approve the change before it becomes official." : task.approvalStatus === "REJECTED" ? "This task was sent back. Saving sends it for approval again." : "Saving keeps it waiting for approval and tells your manager."}
      onClose={onClose}
      dismissible={!busy}
      width="max-w-2xl"
      footer={
        step === "form" ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-indigo-50">Cancel</button>
            {stale ? (
              <button type="button" onClick={() => onSaved("")} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Reload the task</button>
            ) : (
              <button type="button" onClick={() => { setError(""); setStep("confirm"); }} disabled={formProblem !== null} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
                {correction ? "Review request" : "Review changes"}
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={() => setStep("form")} disabled={busy} className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 hover:bg-indigo-50">Back</button>
            <button type="button" onClick={() => void save()} disabled={busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
              {busy ? "Saving…" : correction ? "Send correction request" : "Confirm and save"}
            </button>
          </div>
        )
      }
    >
      {error && <p role="alert" className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-800">{error}</p>}

      {step === "confirm" ? (
        <div data-testid="edit-confirm" className="space-y-3 text-sm">
          <p className="font-medium text-slate-900">{correction ? "You are asking to change:" : "You are about to change:"}</p>
          <ul className="divide-y divide-indigo-50 rounded-xl border border-indigo-100">
            {changes.map((c) => (
              <li key={c.label} className="px-3 py-2">
                <p className="text-xs font-medium text-slate-500">{c.label}</p>
                <p className="break-words text-slate-700 [overflow-wrap:anywhere]"><span className="text-slate-400 line-through">{c.from}</span> <span aria-hidden="true">→</span> <span className="font-medium text-slate-900">{c.to}</span></p>
              </li>
            ))}
          </ul>
          {correction ? (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">The task stays exactly as it is, with its approval{task.rating != null ? " and its rating" : ""}, until your manager decides.{task.rating != null ? " If they approve, the rating is cleared so it can be rated again." : ""} Reason: {reason.trim()}</p>
          ) : (
            <p className="rounded-xl bg-indigo-50 px-3 py-2 text-xs text-indigo-900">{task.approvalStatus === "REJECTED" ? "The earlier reason it was sent back is kept in the history. " : ""}The task will wait for approval{managerId && managerId !== task.taggedManagerId ? ` from ${managerName(managerId)}` : ""}.{date !== task.date ? " Moving the date follows the backdated-task rules." : ""}</p>
          )}
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (formProblem === null) setStep("confirm"); }}>
          {task.approvalStatus === "REJECTED" && task.rejectionNote && (
            <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800"><span className="font-medium">Sent back:</span> {task.rejectionNote}</p>
          )}
          <label className="block text-xs text-slate-500">
            Task description <span className="text-rose-500">*</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={input} aria-label="Task description" />
          </label>
          <label className="block text-xs text-slate-500">
            Additional details
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} className={`${input} resize-y [overflow-wrap:anywhere]`} aria-label="Additional details" />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block min-w-0 text-xs text-slate-500">
              Project <span className="text-rose-500">*</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={input} aria-label="Project">
                <option value="">Select a project</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label className="block min-w-0 text-xs text-slate-500">
              Reporting manager <span className="text-rose-500">{correction ? "" : "*"}</span>
              <select value={managerId} onChange={(e) => setManagerId(e.target.value)} disabled={correction} className={input} aria-label="Reporting manager">
                <option value="">Select a manager</option>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.name}{m.role === "HR" ? " (HR)" : ""}</option>)}
              </select>
              {correction && <span className="mt-0.5 block text-[11px] text-slate-400">The approving manager can&apos;t be changed by a correction.</span>}
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <label className="block text-xs text-slate-500">
              Task date
              <input type="date" value={date} max={isoDaysAgo(0)} min={isoDaysAgo(latePolicy?.maxDays ?? 14)} onChange={(e) => e.target.value && setDate(e.target.value)} disabled={correction} className={input} aria-label="Task date" />
            </label>
            <label className="block text-xs text-slate-500">
              Hours spent
              <input type="number" min={0} max={24} step={0.25} value={hours} onChange={(e) => setHours(e.target.value)} className={input} aria-label="Hours spent" />
            </label>
            <label className="block text-xs text-slate-500">
              Progress
              <select value={progress} onChange={(e) => setProgress(e.target.value)} className={input} aria-label="Progress">
                {PROGRESS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="block text-xs text-slate-500">
              Task priority
              <select value={weight} onChange={(e) => setWeight(e.target.value)} className={input} aria-label="Priority">
                {WEIGHTS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </select>
            </label>
          </div>
          {!correction && dateChanged && lateBy > 0 && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">{lateBy} day{lateBy === 1 ? "" : "s"} back. {outsideWindow ? `That is more than the ${latePolicy?.allowedDays ?? 3}-day window, so a reason is needed.` : "Inside the allowed window, it will be marked as a late submission."}</p>
          )}
          {outsideWindow && !tooOld && (
            <label className="block text-xs text-slate-500">
              Reason for moving it back <span className="text-rose-500">*</span>
              <textarea value={lateReason} onChange={(e) => setLateReason(e.target.value)} rows={2} maxLength={300} className={`${input} resize-y [overflow-wrap:anywhere]`} aria-label="Reason for moving the date back" />
            </label>
          )}
          {progress === "BLOCKED" && (
            <label className="block text-xs text-slate-500">
              Blocked reason <span className="text-rose-500">*</span>
              <textarea value={blockedNote} onChange={(e) => setBlockedNote(e.target.value)} maxLength={BLOCKED_REASON_MAX} rows={2} placeholder="What is stopping this task? Your reporting manager will see it." className={`${input} resize-y [overflow-wrap:anywhere]`} aria-label="Blocked reason" />
              <span className="mt-0.5 block text-[11px] text-slate-400">{blockedNote.length}/{BLOCKED_REASON_MAX} · at least 3 characters</span>
            </label>
          )}
          {correction && (
            <label className="block text-xs text-slate-500">
              Why is this correction needed? <span className="text-rose-500">*</span>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} placeholder="For example: wrong project name, hours were entered incorrectly." className={`${input} resize-y [overflow-wrap:anywhere]`} aria-label="Reason for the correction" />
              <span className="mt-0.5 block text-[11px] text-slate-400">{reason.length}/300 · your manager sees this</span>
            </label>
          )}
          {formProblem && changes.length > 0 && <p className="text-xs text-rose-600">{formProblem}</p>}
          {changes.length === 0 && <p className="text-xs text-slate-400">Change something to enable saving.</p>}
        </form>
      )}
    </Modal>
  );
}
