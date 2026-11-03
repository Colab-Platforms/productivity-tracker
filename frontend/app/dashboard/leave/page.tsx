"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { unit } from "@/lib/plural";
import { useMe } from "../layout";
import { Modal } from "../_employees/Modal";
import { ManagerDecisionBox, SkipManagerBox, StepNote, stepBadge, type ManagerStep } from "../_approvals/ManagerStep";

// ---------------------------------------------------------------------------
// LEAVE
// Everyone: ask for leave, see the answer, see how much they have taken.
// HR / Admin: approve or reject requests, and see how much each person has taken.
// Nothing is counted in reports until HR approves it.
// ---------------------------------------------------------------------------

type Taken = Record<string, number> & { total: number };
type Request = {
  id: string;
  from: string;
  to: string;
  leaveType: string;
  isHalfDay: boolean;
  isFirstHalf: boolean;
  dayCount: number;
  reason: string;
  status: string;
  decidedAt: string | null;
  decisionNote: string | null;
  decidedBy: string | null;
  createdAt: string;
  managerStep?: ManagerStep;
};
type Mine = { year: number; taken: Taken; pending: number; requests: Request[] };
type Review = Request & { person: { id: string; name: string; employeeCode: string | null; designation: string | null }; takenThisYear: Taken };
type TeamLeave = { year: number; pending: Review[]; answered: Review[] };
type Summary = { year: number; people: { id: string; name: string; employeeCode: string | null; designation: string | null; taken: Taken; pending: number }[] };
type PersonDetail = {
  year: number;
  person: { name: string; employeeCode: string | null; designation: string | null };
  taken: Taken;
  requests: Request[];
  days: { date: string; leaveType: string; isHalfDay: boolean; fromRequest: boolean }[];
};

const TYPE_LABEL: Record<string, string> = { CASUAL: "Casual", SICK: "Sick", EARNED: "Earned", UNPAID: "Unpaid", PLANNED: "Planned", COMP_OFF: "Comp-off", OTHER: "Other" };
const REQUEST_TYPES = ["CASUAL", "SICK", "EARNED", "UNPAID"];
const STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-amber-50 text-amber-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-red-50 text-red-600",
  CANCELLED: "bg-slate-100 text-slate-500",
};
const STATUS_LABEL: Record<string, string> = { PENDING: "Waiting for HR", APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Cancelled" };

const day = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const range = (r: { from: string; to: string }) => (r.from === r.to ? day(r.from) : `${day(r.from)} – ${day(r.to)}`);
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const todayIso = () => new Date().toISOString().slice(0, 10);

function useApi<T>(path: string | null, reload: number) {
  const [res, setRes] = useState<{ path: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    apiGet<T>(path)
      .then((data) => live && setRes({ path, data }))
      .catch((e: Error) => live && setRes((prev) => ({ path, data: prev?.data, error: e.message })));
    return () => {
      live = false;
    };
  }, [path, reload]);
  return { data: res?.data ?? null, error: res && res.path === path ? (res.error ?? "") : "", loading: path !== null && res?.path !== path };
}

function Badge({ status, step }: { status: string; step?: ManagerStep }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? ""}`}>{stepBadge(status, step) ?? STATUS_LABEL[status] ?? status}</span>;
}

function TakenChips({ t }: { t: Taken }) {
  const other = (t.PLANNED ?? 0) + (t.COMP_OFF ?? 0) + (t.OTHER ?? 0);
  const items: [string, number][] = [["Casual", t.CASUAL], ["Sick", t.SICK], ["Earned", t.EARNED], ["Unpaid", t.UNPAID], ["Other", other]];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(([k, v]) => (
        <span key={k} className={`rounded-full px-3 py-1 text-xs font-medium ${v > 0 ? "bg-indigo-50 text-indigo-700" : "bg-slate-50 text-slate-400"}`}>
          {k} {num(v ?? 0)}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function LeavePage() {
  const me = useMe();
  const isHr = me?.role === "HR" || me?.role === "ADMIN";
  const isManager = me?.role === "MANAGER";
  const [tab, setTab] = useState<"mine" | "review" | "taken" | "team">("mine");
  const [reload, setReload] = useState(0);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyId, setBusyId] = useState("");

  const mine = useApi<Mine>("/leave/mine", reload);
  const [status, setStatus] = useState("PENDING");
  const review = useApi<{ requests: Review[] }>(isHr && tab === "review" ? `/leave/requests?status=${status}` : null, reload);
  const pendingCount = useApi<{ requests: Review[] }>(isHr ? "/leave/requests?status=PENDING" : null, reload);

  // Manager step: requests from the people who report to this manager.
  const team = useApi<TeamLeave>(isManager ? "/leave/manager/requests" : null, reload);

  const [year, setYear] = useState(new Date().getFullYear());
  const [search, setSearch] = useState("");
  const summary = useApi<Summary>(isHr && tab === "taken" ? `/leave/summary?year=${year}` : null, reload);
  const [personId, setPersonId] = useState<string | null>(null);
  const person = useApi<PersonDetail>(personId ? `/leave/person/${personId}?year=${year}` : null, reload);

  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function managerDecide(id: string, decision: "APPROVE" | "REJECT", comment: string) {
    if (busyId) return;
    setBusyId(id);
    setActionError("");
    try {
      await apiPost(`/leave/manager/requests/${id}/decide`, { decision, note: comment });
      setNotice(decision === "APPROVE" ? "Approved. HR has been told and makes the final decision." : "Rejected. The employee has been told.");
      setReload((n) => n + 1);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusyId("");
    }
  }

  async function decide(id: string, decision: "APPROVE" | "REJECT", skipReason?: string) {
    if (busyId) return;
    setBusyId(id);
    setActionError("");
    try {
      await apiPost(`/leave/requests/${id}/decide`, { decision, note, ...(skipReason ? { skipManager: true, skipReason } : {}) });
      setNotice(decision === "APPROVE" ? "Leave approved. Those days now count as leave in reports." : "Leave rejected.");
      setNoteFor(null);
      setNote("");
      setReload((n) => n + 1);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusyId("");
    }
  }

  async function cancel(id: string) {
    if (busyId) return;
    setBusyId(id);
    setActionError("");
    try {
      await apiPost(`/leave/requests/${id}/cancel`);
      setNotice("Request cancelled.");
      setReload((n) => n + 1);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusyId("");
    }
  }

  const people = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (summary.data?.people ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || (p.employeeCode ?? "").toLowerCase().includes(q));
  }, [summary.data, search]);

  const card = "rounded-2xl bg-white shadow-[var(--shadow-card)]";
  const waitingForMe = team.data?.pending.length ?? 0;
  const tabs: [typeof tab, string][] = isHr
    ? [["mine", "My leave"], ["review", `Requests to review${pendingCount.data?.requests.length ? ` (${pendingCount.data.requests.length})` : ""}`], ["taken", "Leave taken"]]
    : isManager
      ? [["mine", "My leave"], ["team", `Team requests${waitingForMe ? ` (${waitingForMe})` : ""}`]]
      : [["mine", "My leave"]];

  return (
    <div className="page-fluid space-y-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Leave</h1>
          <p className="mt-1 text-sm text-slate-500">Ask for leave, track the answer, and see how much has been taken.</p>
        </div>
        <button onClick={() => setAsking(true)} className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">
          Request leave
        </button>
      </div>

      {tabs.length > 1 && (
        <div className="flex gap-2">
          {tabs.map(([k, label]) => (
            <button key={k} onClick={() => { setTab(k); setNotice(""); setActionError(""); }} className={`rounded-xl px-4 py-2 text-sm font-medium ${tab === k ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-indigo-50"}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}
      {actionError && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{actionError}</p>}

      {/* ---------------- my leave ---------------- */}
      {tab === "mine" && (
        <>
          <section className={`${card} p-6`}>
            <p className="text-sm text-slate-500">Leave taken in {mine.data?.year ?? new Date().getFullYear()}</p>
            <p className="mt-1 text-3xl font-semibold text-slate-900">
              {mine.data ? num(mine.data.taken.total) : "–"} <span className="text-base font-normal text-slate-400">days</span>
              {mine.data && mine.data.pending > 0 && <span className="ml-3 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">{mine.data.pending} waiting for HR</span>}
            </p>
            <div className="mt-3">{mine.data && <TakenChips t={mine.data.taken} />}</div>
          </section>

          <section className={`${card} p-6`}>
            <h2 className="font-semibold text-slate-900">My requests</h2>
            {mine.error && <p className="mt-3 text-sm text-red-600">{mine.error}</p>}
            {mine.data && mine.data.requests.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">You haven&apos;t requested any leave yet.</p>}
            <div className="mt-4 divide-y divide-indigo-100">
              {mine.data?.requests.map((r) => (
                <div key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
                  <div>
                    <p className="font-medium text-slate-900">
                      {range(r)} <span className="text-slate-400">·</span> {num(r.dayCount)} {r.dayCount === 1 ? "day" : "days"} <span className="text-slate-400">·</span> {TYPE_LABEL[r.leaveType] ?? r.leaveType}
                      {r.isHalfDay && <span className="ml-1 text-slate-500">({r.isFirstHalf ? "first" : "second"} half)</span>}
                    </p>
                    <p className="mt-0.5 text-sm text-slate-500">{r.reason}</p>
                    {(r.decidedBy || r.decisionNote) && (
                      <p className="mt-1 text-xs text-slate-400">
                        {r.decidedBy && <>Decided by {r.decidedBy}</>}
                        {r.decisionNote && <> · “{r.decisionNote}”</>}
                      </p>
                    )}
                    <StepNote step={r.managerStep} />
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge status={r.status} step={r.managerStep} />
                    {r.status === "PENDING" && (
                      <button disabled={busyId === r.id} onClick={() => cancel(r.id)} className="rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* ---------------- HR: requests to review ---------------- */}
      {tab === "review" && isHr && (
        <section className={`${card} p-6`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-slate-900">Requests</h2>
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-700">
              <option value="PENDING">Waiting for HR</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="">All</option>
            </select>
          </div>
          {review.error && <p className="mt-3 text-sm text-red-600">{review.error}</p>}
          {review.data && review.data.requests.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">Nothing here.</p>}
          <div className="mt-4 divide-y divide-indigo-100">
            {review.data?.requests.map((r) => (
              <div key={r.id} className="py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900">
                      {r.person.name} <span className="text-sm font-normal text-slate-400">{r.person.employeeCode}{r.person.designation ? ` · ${r.person.designation}` : ""}</span>
                    </p>
                    <p className="mt-0.5 text-sm text-slate-700">
                      {range(r)} · {num(r.dayCount)} {r.dayCount === 1 ? "day" : "days"} · {TYPE_LABEL[r.leaveType] ?? r.leaveType}
                      {r.isHalfDay && ` (${r.isFirstHalf ? "first" : "second"} half)`}
                    </p>
                    <p className="mt-0.5 text-sm text-slate-500">“{r.reason}”</p>
                    <p className="mt-1 text-xs text-slate-400">Already taken this year: {num(r.takenThisYear.total)} {unit(r.takenThisYear.total, "day")}</p>
                    {r.decidedBy && <p className="mt-1 text-xs text-slate-400">Decided by {r.decidedBy}{r.decisionNote ? ` · “${r.decisionNote}”` : ""}</p>}
                    <StepNote step={r.managerStep} />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge status={r.status} step={r.managerStep} />
                    {r.status === "PENDING" && r.person.id !== me?.id && r.managerStep?.status === "PENDING" && (
                      <SkipManagerBox busy={busyId === r.id} onDecide={(d, reason) => decide(r.id, d, reason)} />
                    )}
                    {r.status === "PENDING" && r.person.id !== me?.id && r.managerStep?.status !== "PENDING" && (
                      <>
                        <button disabled={busyId === r.id} onClick={() => decide(r.id, "APPROVE")} className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                          Approve
                        </button>
                        <button disabled={busyId === r.id} onClick={() => setNoteFor(noteFor === r.id ? null : r.id)} className="rounded-lg border border-red-200 px-3.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
                          Reject
                        </button>
                      </>
                    )}
                    {r.status === "PENDING" && r.person.id === me?.id && <span className="text-xs text-slate-400">Another HR/Admin must decide this</span>}
                  </div>
                </div>
                {noteFor === r.id && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Reason for rejecting (optional)" className="min-w-[16rem] flex-1 rounded-xl border border-indigo-100 px-3 py-2 text-sm" />
                    <button disabled={busyId === r.id} onClick={() => decide(r.id, "REJECT")} className="rounded-lg bg-red-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
                      Confirm reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---------------- Manager: requests from my team ---------------- */}
      {tab === "team" && isManager && (
        <section className={`${card} p-6`}>
          <h2 className="font-semibold text-slate-900">Requests from your team</h2>
          <p className="mt-1 text-sm text-slate-500">You answer first. If you approve, HR makes the final decision; if you reject, it is closed.</p>
          {team.error && <p className="mt-3 text-sm text-red-600">{team.error}</p>}
          {team.data && team.data.pending.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">Nothing is waiting for you.</p>}
          <div className="mt-4 divide-y divide-indigo-100">
            {team.data?.pending.map((r) => (
              <div key={r.id} className="py-4">
                <p className="font-medium text-slate-900">
                  {r.person.name} <span className="text-sm font-normal text-slate-400">{r.person.employeeCode}{r.person.designation ? ` · ${r.person.designation}` : ""}</span>
                </p>
                <p className="mt-0.5 text-sm text-slate-700">
                  {range(r)} · {num(r.dayCount)} {r.dayCount === 1 ? "day" : "days"} · {TYPE_LABEL[r.leaveType] ?? r.leaveType}
                  {r.isHalfDay && ` (${r.isFirstHalf ? "first" : "second"} half)`}
                </p>
                <p className="mt-0.5 text-sm text-slate-500">“{r.reason}”</p>
                <p className="mt-1 text-xs text-slate-400">Already taken this year: {num(r.takenThisYear.total)} {unit(r.takenThisYear.total, "day")}</p>
                <ManagerDecisionBox busy={busyId === r.id} onDecide={(d, c) => managerDecide(r.id, d, c)} />
              </div>
            ))}
          </div>
          {team.data && team.data.answered.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-slate-900">Answered by you</h3>
              <div className="mt-2 divide-y divide-indigo-100">
                {team.data.answered.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{r.person.name} <span className="font-normal text-slate-400">· {range(r)}</span></p>
                      <StepNote step={r.managerStep} />
                    </div>
                    <Badge status={r.status} step={r.managerStep} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ---------------- HR: leave taken ---------------- */}
      {tab === "taken" && isHr && (
        <section className={`${card} p-6`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-slate-900">Leave taken in {year}</h2>
            <div className="flex gap-2">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or ID" className="rounded-xl border border-indigo-100 px-3 py-2 text-sm" />
              <select aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))} className="rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm">
                {[0, 1, 2].map((i) => {
                  const y = new Date().getFullYear() - i;
                  return <option key={y} value={y}>{y}</option>;
                })}
              </select>
            </div>
          </div>
          {summary.error && <p className="mt-3 text-sm text-red-600">{summary.error}</p>}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="text-xs text-slate-400">
                  <th className="py-2 font-medium">Person</th>
                  {["Casual", "Sick", "Earned", "Unpaid", "Other", "Total", "Waiting"].map((h) => (
                    <th key={h} className="py-2 text-right font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-indigo-100">
                {people.map((p) => (
                  <tr key={p.id} onClick={() => setPersonId(p.id)} className="cursor-pointer hover:bg-indigo-50/40">
                    <td className="py-3">
                      <p className="font-medium text-slate-900">{p.name}</p>
                      <p className="text-xs text-slate-400">{p.employeeCode}</p>
                    </td>
                    {[p.taken.CASUAL, p.taken.SICK, p.taken.EARNED, p.taken.UNPAID, (p.taken.PLANNED ?? 0) + (p.taken.COMP_OFF ?? 0) + (p.taken.OTHER ?? 0)].map((v, i) => (
                      <td key={i} className="py-3 text-right tabular-nums text-slate-600">{num(v ?? 0)}</td>
                    ))}
                    <td className="py-3 text-right font-semibold tabular-nums text-slate-900">{num(p.taken.total)}</td>
                    <td className="py-3 text-right tabular-nums">{p.pending > 0 ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">{p.pending}</span> : <span className="text-slate-300">0</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {summary.data && people.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">No one matches.</p>}
          </div>
          <p className="mt-3 text-xs text-slate-400">Counted from approved leave (half days count 0.5). Click a person to see every request and day.</p>
        </section>
      )}

      {asking && (
        <RequestModal
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            setNotice("Request sent. HR will review it, and you will see the answer here.");
            setTab("mine");
            setReload((n) => n + 1);
          }}
        />
      )}

      {personId && (
        <Modal title={person.data?.person.name ?? "Leave history"} subtitle={person.data ? `${person.data.person.employeeCode ?? ""} · ${year}` : undefined} onClose={() => setPersonId(null)} width="max-w-2xl">
          {person.error && <p className="text-sm text-red-600">{person.error}</p>}
          {person.data && (
            <div className="space-y-5">
              <div>
                <p className="text-sm text-slate-500">Taken in {person.data.year}</p>
                <p className="text-2xl font-semibold text-slate-900">{num(person.data.taken.total)} {unit(person.data.taken.total, "day")}</p>
                <div className="mt-2"><TakenChips t={person.data.taken} /></div>
              </div>
              <div>
                <p className="mb-2 text-sm font-semibold text-slate-900">Requests</p>
                {person.data.requests.length === 0 && <p className="text-sm text-slate-500">No requests.</p>}
                <div className="divide-y divide-indigo-100 rounded-2xl border border-indigo-100">
                  {person.data.requests.map((r) => (
                    <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                      <span className="text-slate-700">{range(r)} · {num(r.dayCount)}d · {TYPE_LABEL[r.leaveType]}<span className="block text-xs text-slate-400">{r.reason}</span></span>
                      <Badge status={r.status} />
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-semibold text-slate-900">Days on leave</p>
                {person.data.days.length === 0 && <p className="text-sm text-slate-500">None this year.</p>}
                <div className="flex flex-wrap gap-2">
                  {person.data.days.map((d) => (
                    <span key={d.date} className="rounded-lg bg-slate-50 px-2.5 py-1 text-xs text-slate-600">
                      {day(d.date).replace(/, \d{4}$/, "")} · {TYPE_LABEL[d.leaveType]}{d.isHalfDay ? " ½" : ""}{!d.fromRequest ? " (marked by HR)" : ""}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function RequestModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [leaveType, setLeaveType] = useState("CASUAL");
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [half, setHalf] = useState(false);
  const [firstHalf, setFirstHalf] = useState(true);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const oneDay = from === to;
  const invalid = !from || !to || to < from;

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiPost("/leave/requests", { from, to, leaveType, isHalfDay: half && oneDay, isFirstHalf: firstHalf, reason });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const input = "w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800";
  return (
    <Modal
      title="Request leave"
      subtitle="HR approves it first. It only counts as leave once approved."
      onClose={onClose}
      width="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Close</button>
          <button disabled={busy || invalid || reason.trim().length < 3} onClick={submit} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "Sending…" : "Send request"}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <label className="block text-sm text-slate-600">
          Type of leave
          <select value={leaveType} onChange={(e) => setLeaveType(e.target.value)} className={`${input} mt-1`}>
            {REQUEST_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-slate-600">
            From
            <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (to < e.target.value) setTo(e.target.value); }} className={`${input} mt-1`} />
          </label>
          <label className="block text-sm text-slate-600">
            To
            <input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} className={`${input} mt-1`} />
          </label>
        </div>
        {oneDay && (
          <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
            <label className="flex items-center gap-2"><input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} /> Half day</label>
            {half && (
              <>
                <label className="flex items-center gap-1.5"><input type="radio" checked={firstHalf} onChange={() => setFirstHalf(true)} /> First half</label>
                <label className="flex items-center gap-1.5"><input type="radio" checked={!firstHalf} onChange={() => setFirstHalf(false)} /> Second half</label>
              </>
            )}
          </div>
        )}
        <label className="block text-sm text-slate-600">
          Reason
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} className={`${input} mt-1`} placeholder="A short reason for HR" />
        </label>
        <p className="text-xs text-slate-400">Weekly offs and company holidays in the range are not counted.</p>
        {to < from && <p className="text-sm text-red-600">The end date can&apos;t be before the start date.</p>}
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}
