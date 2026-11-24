// ===========================================================================
// QUICK ADD (multiple tasks) — the employee's fast way to send several tasks from one screen.
//
// Every row is its own task: its own project, its own reporting manager, hours, priority and progress. "Submit all" sends each row
// separately (one record each, waiting for ITS manager only). A row that cannot be sent stays here with the reason; nothing typed is lost.
// Drafts are the person's own unsent rows, saved to their account; a draft is never a task and no manager sees it.
// ===========================================================================

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost, apiPut } from "@/lib/api";
import { formatDate, isoDaysAgo, todayIso } from "@/lib/time";
import { BLOCKED_REASON_MAX, PROGRESS_OPTIONS } from "../../_progress/progress";
import {
  MAX_QUICK_ROWS,
  applyDefault,
  applyResults,
  blankRow,
  duplicateOf,
  fromDraft,
  inferDefaults,
  isCustom,
  isEmptyRow,
  lateState,
  LATE_REASON_MAX,
  reasonProblem,
  resetRowChoice,
  startingDefaults,
  rowProblem,
  setRowChoice,
  toDraft,
  toPayload,
  type DefaultField,
  type DefaultSettings,
  type QuickRow,
  type ServerResult,
} from "./quickRows";

type Project = { id: string; label: string };
type Manager = { id: string; name: string; code: string | null; role: string };
type DraftsPayload = { ready: boolean; drafts: Parameters<typeof fromDraft>[0][] };
type BulkPayload = { results: ServerResult[]; submitted: number; failed: number };


const LAST_KEY = "hrms-quickadd-last"; // a convenience only: the last project and manager chosen in this browser

function readLast(): { projectId?: string; managerId?: string } | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    return raw ? (JSON.parse(raw) as { projectId?: string; managerId?: string }) : null;
  } catch {
    return null;
  }
}
function writeLast(v: { projectId?: string; managerId?: string }) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ ...(readLast() ?? {}), ...v }));
  } catch {
    /* private window or blocked storage: the page works without it */
  }
}

const field = "mt-1 w-full min-w-0 rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-500";

// Tells the person where a row's project / manager comes from: "Default" (follows the default settings) or "Custom" (picked on this row,
// with a link to go back to the default).
function DefaultTag({ custom, hasDefault, showWhenFollowing, onReset, disabled }: { custom: boolean; hasDefault: boolean; showWhenFollowing: boolean; onReset: () => void; disabled: boolean }) {
  if (custom) {
    return (
      <span className="ml-2 inline-flex items-center gap-1.5 align-middle">
        <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">Custom</span>
        {hasDefault && (
          <button type="button" onClick={onReset} disabled={disabled} className="text-[10px] font-medium text-indigo-700 underline disabled:opacity-40">
            Reset to default
          </button>
        )}
      </span>
    );
  }
  if (hasDefault && showWhenFollowing) return <span className="ml-2 rounded-full bg-emerald-50 px-1.5 py-0.5 align-middle text-[10px] font-medium text-emerald-800">Default</span>;
  return null;
}

// `previous` switches the screen to "Add Previous Day's Tasks": the person picks an earlier day, every row is saved on THAT day (never today),
// and outside the company's allowed window a reason is required. Drafts are not offered in that mode.
export default function QuickAdd({ projects, managers, onSent, previous, defaults: serverDefaults }: { projects: Project[]; managers: Manager[]; onSent: () => void; previous?: { allowedDays: number; maxDays: number }; defaults?: { projectId: string | null; managerId: string | null } }) {
  const choices = { projects, managers };
  const [rows, setRows] = useState<QuickRow[]>(() => [blankRow(), blankRow(), blankRow()]);
  // Default task settings: the project and reporting manager every row follows until the person picks its own.
  const [defaults, setDefaults] = useState<DefaultSettings>({ projectId: "", managerId: "" });
  // True for a default that came from the person's own team allocation / reporting line (shown in the box's help text).
  const [fromRecords, setFromRecords] = useState({ project: false, manager: false });
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  });
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState("");
  const [note, setNote] = useState("");
  const [summary, setSummary] = useState<{ sent: string[]; failed: number; forDate?: string } | null>(null);
  const [draftsOn, setDraftsOn] = useState(false);
  const [forDate, setForDate] = useState(() => isoDaysAgo(1));
  const [reason, setReason] = useState("");
  const lock = useRef(false); // stops a second click while a request is running (no duplicate submission)
  const hasDraft = useRef(false);
  const choicesRef = useRef(choices);
  useEffect(() => {
    choicesRef.current = choices;
  });

  // Preselect the last project / manager on the starting rows, and restore this person's saved draft if there is one.
  useEffect(() => {
    let alive = true;
    // The box starts from the person's records (team allocation, reporting manager); where those give no single answer, from their last choice.
    const d = startingDefaults(serverDefaults, readLast(), choicesRef.current);
    setDefaults({ projectId: d.projectId, managerId: d.managerId });
    setFromRecords(d.fromRecords);
    setRows((cur) => (cur.every(isEmptyRow) ? cur.map((r) => ({ ...r, projectId: d.projectId, managerId: d.managerId })) : cur));
    if (previous) return () => { alive = false; }; // no drafts for previous days
    apiGet<DraftsPayload>("/tasks/drafts")
      .then((res) => {
        if (!alive) return;
        setDraftsOn(res.ready);
        if (res.ready && res.drafts.length) {
          hasDraft.current = true;
          if (rowsRef.current.every(isEmptyRow)) {
            // The draft keeps each row's own project and manager; the default is worked out again from them (see inferDefaults).
            const restored = inferDefaults(res.drafts.map((x) => fromDraft(x, choicesRef.current)));
            setDefaults(restored.defaults);
            setRows(restored.rows);
          }
          const blockedBack = res.drafts.filter((x) => x.progress === "BLOCKED").length;
          setNote(`Your saved draft was restored (${res.drafts.length} task${res.drafts.length === 1 ? "" : "s"}). It is still not sent.${blockedBack ? " Blocked tasks need their reason typed again (a draft does not keep it)." : ""}`);
        }
      })
      .catch(() => {
        /* drafts unavailable: Quick Add still works */
      });
    return () => {
      alive = false;
    };
    // runs once on mount: `previous` never changes for a mounted screen (each mode has its own instance)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Description, hours, priority, progress and details: only that row changes.
  const patch = useCallback((uid: string, change: Partial<QuickRow>) => {
    setRows((cur) => cur.map((r) => (r.uid === uid ? { ...r, ...change, error: undefined } : r)));
  }, []);

  // The person picked a project / manager for ONE row: only that row changes (custom unless it equals the default).
  function choose(uid: string, f: DefaultField, value: string) {
    setRows((cur) => cur.map((r) => (r.uid === uid ? setRowChoice(r, f, value, defaults) : r)));
  }
  // "Reset to default" on one row.
  function resetChoice(uid: string, f: DefaultField) {
    setRows((cur) => cur.map((r) => (r.uid === uid ? resetRowChoice(r, f, defaults) : r)));
  }
  // The DEFAULT changed: rows that follow it take the new value, hand-picked rows stay exactly as they are.
  function changeDefault(f: DefaultField, value: string) {
    setDefaults((d) => ({ ...d, [f]: value }));
    setRows((cur) => applyDefault(cur, f, value));
    if (value) writeLast({ [f]: value });
  }

  function addRow() {
    if (rows.length >= MAX_QUICK_ROWS) {
      setBanner(`You can send up to ${MAX_QUICK_ROWS} tasks at a time.`);
      return;
    }
    setBanner("");
    setRows((cur) => [...cur, blankRow(defaults)]);
  }

  function duplicate(r: QuickRow) {
    if (rows.length >= MAX_QUICK_ROWS) {
      setBanner(`You can send up to ${MAX_QUICK_ROWS} tasks at a time.`);
      return;
    }
    setBanner("");
    setRows((cur) => {
      const i = cur.findIndex((x) => x.uid === r.uid);
      const copy = duplicateOf(r);
      return [...cur.slice(0, i + 1), copy, ...cur.slice(i + 1)];
    });
  }

  function remove(r: QuickRow) {
    setRows((cur) => (cur.length <= 1 ? [blankRow(defaults)] : cur.filter((x) => x.uid !== r.uid)));
  }

  async function saveDraft() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setBanner("");
    setNote("");
    try {
      const keep = rows.filter((r) => !isEmptyRow(r));
      const res = await apiPut<DraftsPayload>("/tasks/drafts", { rows: keep.map(toDraft) });
      hasDraft.current = res.drafts.length > 0;
      const blockedKept = keep.filter((r) => r.progress === "BLOCKED").length;
      setNote(keep.length ? `Draft saved (${keep.length} task${keep.length === 1 ? "" : "s"}). Only you can see it; nothing was sent.${blockedKept ? " A draft does not keep the blocked reason, so you will type it again when you open it." : ""}` : "Draft cleared.");
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Could not save the draft.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function submitAll() {
    if (lock.current) return;
    const todo = rows.filter((r) => !isEmptyRow(r));
    setSummary(null);
    setNote("");
    if (!todo.length) {
      setBanner("Add at least one task.");
      return;
    }
    if (previous) {
      const ls = lateState(forDate, todayIso(), previous.allowedDays, previous.maxDays);
      if (ls.notPast) return void setBanner("Pick a day before today. Use Quick Add for today.");
      if (ls.tooOld) return void setBanner(`Tasks can be added for the last ${previous.maxDays} days only.`);
      const rp = reasonProblem(reason, ls.outside);
      if (rp) return void setBanner(rp);
    }
    // Each row is checked on its own; a row with a problem is marked and NOT sent, the others still go.
    const problems = new Map(todo.map((r) => [r.uid, rowProblem(r, choices)] as const));
    const marked = rows.map((r) => (problems.get(r.uid) ? { ...r, error: problems.get(r.uid)! } : { ...r, error: undefined }));
    const valid = todo.filter((r) => !problems.get(r.uid));
    setRows(marked);
    if (!valid.length) {
      setBanner("Fix the highlighted tasks, then submit again.");
      return;
    }
    lock.current = true;
    setBusy(true);
    setBanner("");
    try {
      const res = await apiPost<BulkPayload>("/tasks/bulk", { rows: valid.map(toPayload), ...(previous ? { forDate, lateReason: reason.trim() } : {}) });
      const { sent, kept } = applyResults(marked, res.results);
      const left = kept.length ? kept : [blankRow(defaults)];
      setRows(left);
      const failedCount = kept.filter((r) => !isEmptyRow(r)).length;
      setSummary({ sent: sent.map((r) => r.title.trim()), failed: failedCount, forDate: previous ? forDate : undefined });
      if (previous && sent.length && !failedCount) setReason("");
      if (hasDraft.current) {
        // The draft now holds only what is still unsent.
        const remaining = kept.filter((r) => !isEmptyRow(r));
        apiPut<DraftsPayload>("/tasks/drafts", { rows: remaining.map(toDraft) })
          .then((d) => (hasDraft.current = d.drafts.length > 0))
          .catch(() => setNote("The tasks were sent, but your saved draft could not be refreshed. Open it again to check."));
      }
      if (sent.length) onSent();
    } catch (err) {
      // Nothing was sent as far as we know; every row is still here.
      setBanner(err instanceof Error ? err.message : "Could not send the tasks. Nothing was lost; try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const filled = rows.filter((r) => !isEmptyRow(r)).length;
  const ls = previous ? lateState(forDate, todayIso(), previous.allowedDays, previous.maxDays) : null;
  const dateText = previous ? formatDate(`${forDate}T12:00:00Z`, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";
  const needProject = projects.length > 0;
  const needManager = managers.length > 0;

  return (
    <section className="space-y-3 rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] sm:p-5" aria-label="Quick Add multiple tasks">
      {previous && ls && (
        <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-slate-600">
              Task date
              <input
                type="date"
                value={forDate}
                min={isoDaysAgo(previous.maxDays)}
                max={isoDaysAgo(1)}
                onChange={(e) => e.target.value && setForDate(e.target.value)}
                className={field + " w-44"}
                aria-label="Task date"
              />
            </label>
            <p className="pb-2 text-sm font-medium text-slate-800" aria-live="polite">
              Adding tasks for {dateText}
              {!ls.notPast && !ls.tooOld ? <span className="font-normal text-slate-500"> · {ls.lateByDays} day{ls.lateByDays === 1 ? "" : "s"} ago</span> : null}
            </p>
          </div>
          {ls.notPast || ls.tooOld ? (
            <p className="text-xs font-medium text-rose-700" role="alert">{ls.notPast ? "Pick a day before today." : `That is too old. Tasks can be added for the last ${previous.maxDays} days only.`}</p>
          ) : (
            <p className="text-xs text-amber-900">
              {ls.outside
                ? `This is more than ${previous.allowedDays} day${previous.allowedDays === 1 ? "" : "s"} ago, so a reason is required. Your tagged manager reviews it.`
                : `Within the allowed ${previous.allowedDays} day${previous.allowedDays === 1 ? "" : "s"}. Each task is saved on this date and marked as a late submission. Your tagged manager approves it as usual.`}
            </p>
          )}
          <label className="block text-xs text-slate-600">
            Reason for submitting late{ls.outside ? <span className="text-rose-500"> *</span> : <span className="text-slate-400"> (optional)</span>}
            <textarea
              value={reason}
              maxLength={LATE_REASON_MAX}
              rows={2}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why were these not added on the day?"
              className={field + " resize-y"}
            />
            <span className="mt-0.5 block text-right text-[11px] text-slate-400">{reason.length}/{LATE_REASON_MAX}</span>
          </label>
          <p className="text-[11px] text-slate-500">Your attendance is not changed. The tasks count on {dateText} once your manager approves them.</p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          Each row is its own task and goes only to the manager you tag on it.{" "}
          <span className="text-slate-400">{previous ? "Saved on the date above" : "Today"} · up to {MAX_QUICK_ROWS} at a time</span>
        </p>
        <span className="rounded-full bg-[#E7F6F1] px-2.5 py-1 text-xs font-medium text-slate-600" aria-live="polite">
          {filled} task{filled === 1 ? "" : "s"} filled in
        </span>
      </div>

      {summary && (
        <div role="status" className={`rounded-xl border px-4 py-3 text-sm ${summary.failed ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
          <p className="font-medium">
            {summary.sent.length} task{summary.sent.length === 1 ? "" : "s"} sent for approval{summary.forDate ? ` for ${formatDate(`${summary.forDate}T12:00:00Z`, { day: "numeric", month: "short", year: "numeric" })} (late submission)` : ""}
            {summary.failed ? ` · ${summary.failed} could not be sent (still below, with the reason)` : ""}
          </p>
          {summary.sent.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-xs">
              {summary.sent.map((t, i) => (
                <li key={i} className="break-words">{t}</li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setSummary(null)} className="mt-2 text-xs underline">Dismiss</button>
        </div>
      )}
      {note && <p className="rounded-xl bg-indigo-50 px-3 py-2 text-xs text-indigo-800" role="status">{note}</p>}
      {banner && <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{banner}</p>}

      <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-3" aria-label="Default task settings">
        <p className="text-sm font-medium text-slate-800">Default task settings</p>
        <p className="mt-0.5 text-xs text-slate-500">Pick once; every task below follows it. You can still change the project or manager on any single task.{fromRecords.project || fromRecords.manager ? " Filled in from your team and your reporting manager; change it any time." : ""}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <label className="min-w-0 text-xs text-slate-500">
            Default project
            <select
              value={defaults.projectId}
              disabled={!needProject}
              onChange={(e) => changeDefault("projectId", e.target.value)}
              title={projects.find((p) => p.id === defaults.projectId)?.label}
              className={field + " truncate"}
            >
              <option value="">{needProject ? "No default project" : "No project available"}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-xs text-slate-500">
            Default reporting manager
            <select
              value={defaults.managerId}
              disabled={!needManager}
              onChange={(e) => changeDefault("managerId", e.target.value)}
              title={managers.find((m) => m.id === defaults.managerId)?.name}
              className={field + " truncate"}
            >
              <option value="">{needManager ? "No default manager" : "No manager available"}</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>{m.name}{m.code ? ` (${m.code})` : ""}{m.role === "ADMIN" ? " · Admin" : ""}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <ol className="space-y-3">
        {rows.map((r, i) => (
          <li key={r.uid} className={`rounded-xl border p-3 ${r.error ? "border-rose-300 bg-rose-50/40" : "border-indigo-100"}`}>
            <div className="flex flex-wrap items-start gap-2">
              <span className="mt-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-semibold text-indigo-700">{i + 1}</span>
              <label className="min-w-0 flex-1 basis-[11rem] text-xs text-slate-500">
                <span className="sr-only">Task description {i + 1}</span>
                <input
                  value={r.title}
                  maxLength={200}
                  onChange={(e) => patch(r.uid, { title: e.target.value })}
                  placeholder="Task description"
                  className={field + " mt-0"}
                />
              </label>
              <div className="ml-auto flex shrink-0 items-center gap-1 text-xs sm:pt-1.5">
                <button type="button" onClick={() => duplicate(r)} disabled={busy} className="rounded-lg px-2 py-1 text-slate-500 transition hover:bg-indigo-50 hover:text-indigo-700 disabled:opacity-40" title="Duplicate this task">Duplicate</button>
                <button type="button" onClick={() => remove(r)} disabled={busy} className="rounded-lg px-2 py-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40" title="Remove this task">Remove</button>
              </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-6">
              {/* The Default / Custom tag and its reset button are NOT inside the <label>: a label wrapping a button would be tied to the button instead of the dropdown. */}
              <div className="col-span-2 min-w-0 text-xs text-slate-500 sm:col-span-3">
                <div className="flex flex-wrap items-center">
                  <label htmlFor={`proj-${r.uid}`}>Project{needProject && <span className="text-rose-500"> *</span>}</label>
                  <DefaultTag custom={isCustom(r, "projectId")} hasDefault={!!defaults.projectId} showWhenFollowing={!!r.projectId} onReset={() => resetChoice(r.uid, "projectId")} disabled={busy} />
                </div>
                <select id={`proj-${r.uid}`} value={r.projectId} disabled={!needProject} onChange={(e) => choose(r.uid, "projectId", e.target.value)} title={projects.find((p) => p.id === r.projectId)?.label} className={field + " truncate"}>
                  <option value="">{needProject ? "Select a project" : "No project available"}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2 min-w-0 text-xs text-slate-500 sm:col-span-3">
                <div className="flex flex-wrap items-center">
                  <label htmlFor={`mgr-${r.uid}`}>Reporting manager{needManager && <span className="text-rose-500"> *</span>}</label>
                  <DefaultTag custom={isCustom(r, "managerId")} hasDefault={!!defaults.managerId} showWhenFollowing={!!r.managerId} onReset={() => resetChoice(r.uid, "managerId")} disabled={busy} />
                </div>
                <select id={`mgr-${r.uid}`} value={r.managerId} disabled={!needManager} onChange={(e) => choose(r.uid, "managerId", e.target.value)} title={managers.find((m) => m.id === r.managerId)?.name} className={field + " truncate"}>
                  <option value="">{needManager ? "Select a manager" : "No manager available"}</option>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}{m.code ? ` (${m.code})` : ""}{m.role === "ADMIN" ? " · Admin" : ""}</option>
                  ))}
                </select>
              </div>
              <label className="col-span-2 min-w-0 text-xs text-slate-500 sm:col-span-2">
                Progress
                <select value={r.progress} onChange={(e) => patch(r.uid, { progress: e.target.value })} className={field}>
                  {PROGRESS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              {r.progress === "BLOCKED" && (
                <label className="col-span-2 min-w-0 text-xs text-slate-500 sm:col-span-6">
                  Blocked reason <span className="text-rose-500">*</span>
                  <textarea
                    value={r.blockedNote ?? ""}
                    onChange={(e) => patch(r.uid, { blockedNote: e.target.value })}
                    maxLength={BLOCKED_REASON_MAX}
                    rows={2}
                    placeholder="What is stopping this task? Your reporting manager will see it."
                    className={field + " resize-y [overflow-wrap:anywhere]"}
                  />
                </label>
              )}
            </div>

            <details className="mt-2 text-xs text-slate-500" open={!!r.description}>
              <summary className="cursor-pointer select-none text-slate-500 hover:text-indigo-700">Additional details (optional)</summary>
              <input value={r.description} maxLength={2000} onChange={(e) => patch(r.uid, { description: e.target.value })} placeholder="Any detail your manager needs" className={field} />
            </details>

            {r.error && <p className="mt-2 text-xs font-medium text-rose-700" role="alert">{r.error}</p>}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <button type="button" onClick={addRow} disabled={busy} className="rounded-xl border border-indigo-200 px-4 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-50 disabled:opacity-40">
          + Add another task
        </button>
        <div className="flex flex-wrap items-center gap-2">
          {draftsOn && (
            <button type="button" onClick={saveDraft} disabled={busy} className="rounded-xl border border-indigo-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-indigo-50 disabled:opacity-40">
              Save as draft
            </button>
          )}
          <button type="button" onClick={submitAll} disabled={busy || filled === 0} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40">
            {busy ? "Sending…" : `Submit all tasks${filled ? ` (${filled})` : ""}`}
          </button>
        </div>
      </div>
      {!draftsOn && !previous && <p className="text-[11px] text-slate-400">Saving drafts is not switched on yet. Your rows stay on this screen until you submit.</p>}
    </section>
  );
}
