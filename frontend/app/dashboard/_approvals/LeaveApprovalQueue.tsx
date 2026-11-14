"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { unit } from "@/lib/plural";
import { ManagerDecisionBox, StepNote, stepBadge, type ManagerStep } from "./ManagerStep";
import { FlowLine, StageBadge, type FlowFields } from "./LeaveFlow";

// ---------------------------------------------------------------------------
// LEAVE WAITING FOR THIS PERSON'S FIRST-STAGE ANSWER (Approval Centre, Admin).
// Requests tagged to this person: an Admin answers a Manager's leave first (HR then makes the final decision) and HR's own leave (final with the
// Admin). Same data and same decide call as before (/leave/manager/requests, /leave/manager/requests/:id/decide); only the place it is shown moved
// out of Leave Oversight, which is now for monitoring. A rejection is final.
// ---------------------------------------------------------------------------

type Taken = Record<string, number> & { total: number };
type Review = {
  id: string;
  from: string;
  to: string;
  leaveType: string;
  isHalfDay: boolean;
  isFirstHalf: boolean;
  dayCount: number;
  reason: string;
  status: string;
  requesterRole?: string;
  managerStep?: ManagerStep;
  person: { id: string; name: string; employeeCode: string | null; designation: string | null };
  takenThisYear: Taken;
} & FlowFields;
type TeamLeave = { year: number; pending: Review[]; answered: Review[] };

const TYPE_LABEL: Record<string, string> = { CASUAL: "Casual", SICK: "Sick", EARNED: "Earned", UNPAID: "Unpaid", PLANNED: "Planned", COMP_OFF: "Comp-off", OTHER: "Other" };
const STATUS_STYLE: Record<string, string> = { PENDING: "bg-amber-50 text-amber-700", APPROVED: "bg-emerald-50 text-emerald-700", REJECTED: "bg-red-50 text-red-600", CANCELLED: "bg-slate-100 text-slate-500" };
const STATUS_LABEL: Record<string, string> = { PENDING: "Waiting for HR", APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Cancelled" };
const day = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const range = (r: { from: string; to: string }) => (r.from === r.to ? day(r.from) : `${day(r.from)} – ${day(r.to)}`);
const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function Badge({ r }: { r: Review }) {
  if (r.stage && r.stageLabel) return <StageBadge stage={r.stage} label={r.stageLabel} />;
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status] ?? ""}`}>{stepBadge(r.status, r.managerStep) ?? STATUS_LABEL[r.status] ?? r.status}</span>;
}

export default function LeaveApprovalQueue({ onCount }: { onCount?: (waiting: number) => void }) {
  const [data, setData] = useState<TeamLeave | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    apiGet<TeamLeave>("/leave/manager/requests")
      .then((d) => {
        if (!live) return;
        setData(d);
        setError("");
        onCount?.(d.pending.length);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // onCount is a plain callback from the parent; the list reloads only when a decision is made
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  async function decide(id: string, decision: "APPROVE" | "REJECT", comment: string) {
    if (busyId) return;
    setBusyId(id);
    setError("");
    setNotice("");
    try {
      await apiPost(`/leave/manager/requests/${id}/decide`, { decision, note: comment });
      const done = (data?.pending ?? []).find((x) => x.id === id);
      setNotice(decision === "APPROVE" ? (done?.requesterRole === "HR" ? "Approved. This leave is now approved." : "Approved. HR has been told and makes the final decision.") : "Rejected. The person has been told.");
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]" aria-label="Leave waiting for your approval">
      <h2 className="font-semibold text-slate-900">Leave sent to you for approval</h2>
      <p className="mt-1 text-sm text-slate-500">Only requests tagged to you appear here. A manager&apos;s leave goes to HR for the final decision after you approve; HR&apos;s own leave is final with you. A rejection closes it.</p>
      {notice && <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}
      {!data && !error && <div className="mt-4 skeleton h-20" />}
      {data && data.pending.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">Nothing is waiting for you.</p>}
      <div className="mt-4 divide-y divide-indigo-100">
        {data?.pending.map((r) => (
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
            <FlowLine r={r} />
            <ManagerDecisionBox busy={busyId === r.id} onDecide={(d, c) => decide(r.id, d, c)} hint={r.requesterRole === "HR" ? "Your approval is final for HR's leave. A rejection is final." : "After you approve, HR makes the final decision. A rejection is final."} />
          </div>
        ))}
      </div>
      {data && data.answered.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-slate-900">Answered by you</h3>
          <div className="mt-2 divide-y divide-indigo-100">
            {data.answered.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">{r.person.name} <span className="font-normal text-slate-400">· {range(r)}</span></p>
                  <StepNote step={r.managerStep} />
                </div>
                <Badge r={r} />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
