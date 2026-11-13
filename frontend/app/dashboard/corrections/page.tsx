"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { API_BASE, apiGet, apiPost, getToken } from "@/lib/api";
import { useMe } from "../layout";
import { Modal } from "../_employees/Modal";
import { fmtClock, fmtDur } from "../_timesheet/time";
import RequestCorrectionModal from "../_corrections/RequestModal";
import { ManagerDecisionBox, SkipManagerBox, StepNote, stepBadge } from "../_approvals/ManagerStep";
import { STATUS_LABEL, STATUS_STYLE, type CorrectionDetails, type CorrectionRequest, type SessionSnapshot } from "../_corrections/types";

// ---------------------------------------------------------------------------
// ATTENDANCE CORRECTIONS
// Everyone: ask for a correction and follow the answer.
// HR / Admin: review requests, compare original and requested times, approve
// or reject (a rejection needs a reason), and read each correction's history.
// The server enforces who may decide; this page only hides what you cannot use.
// ---------------------------------------------------------------------------

type Mine = { timezone: string; windowDays: number; requests: CorrectionRequest[] };
type TeamCorrections = { timezone: string; pending: CorrectionRequest[]; answered: CorrectionRequest[] };
type Review = { timezone: string; counts: Record<string, number>; teams: { id: string; name: string }[]; requests: CorrectionRequest[] };

const day = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const when = (s: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(s));
const t = (s: string | null, tz: string) => (s ? fmtClock(Date.parse(s), tz) : "Not recorded");

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
  return { data: res?.data ?? null, error: res && res.path === path ? (res.error ?? "") : "" };
}

function Badge({ status, step }: { status: string; step?: CorrectionRequest["managerStep"] }) {
  return <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? ""}`}>{stepBadge(status, step) ?? STATUS_LABEL[status] ?? status}</span>;
}

async function openEvidence(id: string) {
  const res = await fetch(`${API_BASE}/attendance-corrections/${id}/attachment`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error("Could not open the file");
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Snapshot({ s, tz }: { s: SessionSnapshot | undefined; tz: string }) {
  if (!s) return <span className="text-slate-400">Nothing recorded</span>;
  return (
    <span>
      {t(s.loginAt, tz)} – {t(s.logoutAt, tz)} · worked {fmtDur(s.productiveSeconds)}
      {s.wasLateLogin ? <span className="ml-1 rounded bg-red-50 px-1.5 text-[11px] text-red-600">late {s.lateByMinutes}m</span> : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
function CorrectionsInner() {
  const me = useMe();
  const isHr = me?.role === "HR" || me?.role === "ADMIN";
  const isManager = me?.role === "MANAGER";
  const params = useSearchParams();
  const linked = params.get("id");

  // The layout only renders this page once the signed-in person is known, so their role is available now:
  // HR/Admin land on the pending list, everyone else on their own requests.
  const [tab, setTab] = useState<"PENDING" | "APPROVED" | "REJECTED" | "MINE" | "TEAM">(isHr ? "PENDING" : "MINE");
  const [busyId, setBusyId] = useState("");
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState("");
  const [asking, setAsking] = useState(false);
  // A link like /dashboard/corrections?id=... (from a notification) opens that request, even if you are already on this page.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [closedLink, setClosedLink] = useState<string | null>(null);
  const openId = chosenId ?? (linked && linked !== closedLink ? linked : null);
  const setOpenId = (id: string | null) => {
    setChosenId(id);
    if (id === null) setClosedLink(linked);
  };
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [teamId, setTeamId] = useState("");

  const mine = useApi<Mine>("/attendance-corrections/mine", reload);
  const qs = new URLSearchParams({ status: tab === "MINE" ? "PENDING" : tab });
  if (q.trim()) qs.set("q", q.trim());
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (teamId) qs.set("teamId", teamId);
  // Manager step: requests from the people who report to this manager.
  const team = useApi<TeamCorrections>(isManager ? "/attendance-corrections/manager/requests" : null, reload);
  const review = useApi<Review>(isHr && tab !== "MINE" && tab !== "TEAM" ? `/attendance-corrections?${qs.toString()}` : null, reload);
  const pendingApi = useApi<{ pending: number }>(isHr ? "/attendance-corrections/pending-count" : null, reload);

  async function managerDecide(id: string, decision: "APPROVE" | "REJECT", comment: string) {
    if (busyId) return;
    setBusyId(id);
    try {
      await apiPost(`/attendance-corrections/manager/requests/${id}/decide`, { decision, comment });
      setNotice(decision === "APPROVE" ? "Approved. HR has been told and makes the final decision." : "Rejected. The employee has been told.");
      setReload((n) => n + 1);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusyId("");
    }
  }

  async function cancel(id: string) {
    try {
      await apiPost(`/attendance-corrections/${id}/cancel`);
      setNotice("Request cancelled.");
      setReload((n) => n + 1);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  const card = "rounded-2xl bg-white shadow-[var(--shadow-card)]";
  const tz = (tab === "MINE" ? mine.data?.timezone : tab === "TEAM" ? team.data?.timezone : review.data?.timezone) ?? "Asia/Kolkata";
  const pending = pendingApi.data?.pending ?? review.data?.counts.PENDING ?? 0;
  const waitingForMe = team.data?.pending.length ?? 0;
  const tabs: ["PENDING" | "APPROVED" | "REJECTED" | "MINE" | "TEAM", string][] = isHr
    ? [["PENDING", `Pending${pending ? ` (${pending})` : ""}`], ["APPROVED", "Approved"], ["REJECTED", "Rejected"], ["MINE", "My requests"]]
    : isManager
      ? [["MINE", "My requests"], ["TEAM", `Team requests${waitingForMe ? ` (${waitingForMe})` : ""}`]]
      : [["MINE", "My requests"]];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Attendance corrections</h1>
          <p className="mt-1 text-sm text-slate-500">
            {isHr ? "Review requests to correct attendance. Nothing changes until you approve." : "Ask HR to correct a day's attendance and follow the answer."}
          </p>
        </div>
        <button onClick={() => setAsking(true)} className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">
          Request correction
        </button>
      </div>

      {tabs.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {tabs.map(([k, label]) => (
            <button key={k} onClick={() => { setTab(k); setNotice(""); }} className={`rounded-xl px-4 py-2 text-sm font-medium ${tab === k ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-indigo-50"}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

      {/* ---------------- my requests ---------------- */}
      {tab === "MINE" && (
        <section className={`${card} p-6`}>
          <h2 className="font-semibold text-slate-900">My requests</h2>
          {mine.error && <p className="mt-3 text-sm text-red-600">{mine.error}</p>}
          {mine.data && mine.data.requests.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">You haven&apos;t requested any corrections.</p>}
          <div className="mt-4 divide-y divide-indigo-100">
            {mine.data?.requests.map((r) => (
              <div key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-4">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">
                    {day(r.date)} <span className="text-slate-400">·</span> {r.typeLabel}
                  </p>
                  <p className="mt-0.5 text-sm text-slate-600">
                    Recorded: {t(r.originalLoginAt, tz)} – {t(r.originalLogoutAt, tz)} <span className="text-slate-400">→</span> Requested: {r.requestedLoginAt ? t(r.requestedLoginAt, tz) : "no change"} – {r.requestedLogoutAt ? t(r.requestedLogoutAt, tz) : "no change"}
                  </p>
                  <p className="mt-0.5 text-sm text-slate-500">“{r.reason}”</p>
                  {(r.reviewedBy || r.reviewComment) && (
                    <p className="mt-1 text-xs text-slate-500">
                      {r.reviewedBy && <>Decided by {r.reviewedBy}</>}
                      {r.reviewComment && <> · Comment: “{r.reviewComment}”</>}
                    </p>
                  )}
                  <StepNote step={r.managerStep} />
                </div>
                <div className="flex items-center gap-2">
                  <Badge status={r.status} step={r.managerStep} />
                  <button onClick={() => setOpenId(r.id)} className="rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Details</button>
                  {r.status === "PENDING" && (
                    <button onClick={() => cancel(r.id)} className="rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---------------- Manager: requests from my team ---------------- */}
      {tab === "TEAM" && isManager && (
        <section className={`${card} p-6`}>
          <h2 className="font-semibold text-slate-900">Requests from your team</h2>
          <p className="mt-1 text-sm text-slate-500">You answer first. If you approve, HR makes the final decision; if you reject, it is closed and attendance stays as it is.</p>
          {team.error && <p className="mt-3 text-sm text-red-600">{team.error}</p>}
          {team.data && team.data.pending.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">Nothing is waiting for you.</p>}
          <div className="mt-4 divide-y divide-indigo-100">
            {team.data?.pending.map((r) => (
              <div key={r.id} className="py-4">
                <p className="font-medium text-slate-900">{r.employee?.name} <span className="text-sm font-normal text-slate-400">{r.employee?.employeeCode}</span></p>
                <p className="mt-0.5 text-sm text-slate-700">{day(r.date)} · {r.typeLabel}</p>
                <p className="mt-0.5 text-sm text-slate-600">
                  Recorded: {t(r.originalLoginAt, tz)} – {t(r.originalLogoutAt, tz)} <span className="text-slate-400">→</span> Requested: {r.requestedLoginAt ? t(r.requestedLoginAt, tz) : "no change"} – {r.requestedLogoutAt ? t(r.requestedLogoutAt, tz) : "no change"}
                </p>
                <p className="mt-0.5 text-sm text-slate-500">“{r.reason}”</p>
                {r.attachmentName && (
                  <button onClick={() => openEvidence(r.id).catch((e: Error) => setNotice(e.message))} className="mt-2 rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50">Open evidence: {r.attachmentName}</button>
                )}
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
                      <p className="text-sm font-medium text-slate-900">{r.employee?.name} <span className="font-normal text-slate-400">· {day(r.date)} · {r.typeLabel}</span></p>
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

      {/* ---------------- HR: review lists ---------------- */}
      {tab !== "MINE" && tab !== "TEAM" && isHr && (
        <section className={`${card} p-6`}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-slate-500">
              Search
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or employee ID" className="mt-1 block w-52 rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-800" />
            </label>
            <label className="text-xs text-slate-500">
              From
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-800" />
            </label>
            <label className="text-xs text-slate-500">
              To
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="mt-1 block rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-800" />
            </label>
            <label className="text-xs text-slate-500">
              Team
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="mt-1 block rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800">
                <option value="">All teams</option>
                {review.data?.teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            {(q || from || to || teamId) && (
              <button onClick={() => { setQ(""); setFrom(""); setTo(""); setTeamId(""); }} className="rounded-xl px-3 py-2 text-xs font-medium text-indigo-600 hover:bg-indigo-50">Clear filters</button>
            )}
          </div>
          {review.error && <p className="mt-3 text-sm text-red-600">{review.error}</p>}
          {review.data && review.data.requests.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">No {tab.toLowerCase()} requests match.</p>}
          <div className="mt-4 overflow-x-auto">
            {review.data && review.data.requests.length > 0 && (
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="text-xs text-slate-400">
                    <th className="py-2 font-medium">Employee</th>
                    <th className="py-2 font-medium">Date</th>
                    <th className="py-2 font-medium">Type</th>
                    <th className="py-2 font-medium">Recorded</th>
                    <th className="py-2 font-medium">Requested</th>
                    <th className="py-2 font-medium">Status</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-indigo-100">
                  {review.data.requests.map((r) => (
                    <tr key={r.id} className="align-top hover:bg-indigo-50/40">
                      <td className="py-3">
                        <p className="font-medium text-slate-900">{r.employee?.name}</p>
                        <p className="text-xs text-slate-400">{r.employee?.employeeCode}</p>
                      </td>
                      <td className="py-3 text-slate-700">{day(r.date)}</td>
                      <td className="py-3 text-slate-700">{r.typeLabel}</td>
                      <td className="py-3 text-slate-600">{t(r.originalLoginAt, tz)} – {t(r.originalLogoutAt, tz)}</td>
                      <td className="py-3 text-slate-600">{r.requestedLoginAt ? t(r.requestedLoginAt, tz) : "–"} – {r.requestedLogoutAt ? t(r.requestedLogoutAt, tz) : "–"}</td>
                      <td className="py-3"><Badge status={r.status} step={r.managerStep} /></td>
                      <td className="py-3 text-right">
                        <button onClick={() => setOpenId(r.id)} className="rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">View</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {asking && (
        <RequestCorrectionModal
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            setNotice("Request sent. HR has been notified, and you will see the answer here.");
            setTab("MINE");
            setReload((n) => n + 1);
          }}
        />
      )}

      {openId && (
        <DetailsModal
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={(text) => {
            setOpenId(null);
            setNotice(text);
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function DetailsModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (text: string) => void }) {
  const [reload, setReload] = useState(0);
  const { data: d, error } = useApi<CorrectionDetails>(`/attendance-corrections/${id}`, reload);
  const [mode, setMode] = useState<"" | "APPROVE" | "REJECT">("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function decide(skipReason?: string, forced?: "APPROVE" | "REJECT") {
    const decision = forced ?? mode;
    if (busy || !decision) return;
    setBusy(true);
    setErr("");
    try {
      await apiPost(`/attendance-corrections/${id}/decide`, { decision, comment, ...(skipReason ? { skipManager: true, skipReason } : {}) });
      onChanged(decision === "APPROVE" ? "Correction approved. The attendance record, worked hours and late status were updated." : "Correction rejected. The attendance record is unchanged.");
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
      setReload((n) => n + 1);
    }
  }

  const tz = d?.timezone ?? "Asia/Kolkata";
  const cell = "px-4 py-2.5 text-sm";
  return (
    <Modal title={d ? `${d.employee?.name ?? "Correction"} · ${day(d.date)}` : "Correction request"} subtitle={d ? `${d.typeLabel}${d.employee?.employeeCode ? ` · ${d.employee.employeeCode}` : ""}` : undefined} onClose={onClose} width="max-w-2xl">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {d && (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <Badge status={d.status} step={d.managerStep} />
              <StepNote step={d.managerStep} />
            </div>
            <p className="text-xs text-slate-400">Submitted {when(d.createdAt, tz)}</p>
          </div>

          <div className="overflow-hidden rounded-2xl border border-indigo-100">
            <table className="w-full text-left">
              <thead className="bg-slate-50 text-xs text-slate-400">
                <tr>
                  <th className={`${cell} font-medium`} />
                  <th className={`${cell} font-medium`}>Recorded when requested</th>
                  <th className={`${cell} font-medium`}>Requested</th>
                  {d.status === "PENDING" && <th className={`${cell} font-medium`}>Recorded now</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-indigo-100">
                <tr>
                  <td className={`${cell} text-slate-500`}>Check-in</td>
                  <td className={cell}>{t(d.originalLoginAt, tz)}</td>
                  <td className={`${cell} font-semibold text-indigo-700`}>{d.requestedLoginAt ? t(d.requestedLoginAt, tz) : <span className="font-normal text-slate-400">no change</span>}</td>
                  {d.status === "PENDING" && <td className={cell}>{d.current ? t(d.current.loginAt, tz) : "Not recorded"}</td>}
                </tr>
                <tr>
                  <td className={`${cell} text-slate-500`}>Check-out</td>
                  <td className={cell}>{t(d.originalLogoutAt, tz)}</td>
                  <td className={`${cell} font-semibold text-indigo-700`}>{d.requestedLogoutAt ? t(d.requestedLogoutAt, tz) : <span className="font-normal text-slate-400">no change</span>}</td>
                  {d.status === "PENDING" && <td className={cell}>{d.current ? t(d.current.logoutAt, tz) : "Not recorded"}</td>}
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Reason</p>
            <p className="mt-1 text-sm text-slate-800">{d.reason}</p>
            {d.attachmentName && (
              <button onClick={() => openEvidence(d.id).catch((e: Error) => setErr(e.message))} className="mt-2 rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
                Open evidence: {d.attachmentName}
              </button>
            )}
          </div>

          {(d.reviewedBy || d.reviewComment) && (
            <div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Decision</p>
              <p className="mt-1">
                {d.reviewedBy ? `${STATUS_LABEL[d.status]} by ${d.reviewedBy}` : STATUS_LABEL[d.status]}
                {d.reviewedAt ? ` · ${when(d.reviewedAt, tz)}` : ""}
              </p>
              {d.reviewComment && <p className="mt-1">“{d.reviewComment}”</p>}
            </div>
          )}

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Audit history</p>
            {d.audits.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">{d.status === "APPROVED" ? "No audit row found." : "Nothing has been changed in attendance by this request."}</p>
            ) : (
              <div className="mt-2 space-y-2">
                {d.audits.map((a) => (
                  <div key={a.id} className="rounded-2xl border border-indigo-100 px-4 py-3 text-sm">
                    <p className="text-xs text-slate-400">Applied by {a.by} · {when(a.at, tz)}</p>
                    <p className="mt-1 text-slate-600"><span className="text-slate-400">Before:</span> {a.before && "loginAt" in a.before ? <Snapshot s={a.before as SessionSnapshot} tz={tz} /> : <span className="text-slate-400">No attendance was recorded</span>}</p>
                    <p className="mt-0.5 text-slate-800"><span className="text-slate-400">After:</span> <Snapshot s={a.after} tz={tz} /></p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}

          {d.canDecide && d.managerStep?.status === "PENDING" && (
            <div className="flex justify-end">
              <SkipManagerBox busy={busy} onDecide={(decision, reason) => decide(reason, decision)} />
            </div>
          )}
          {d.canDecide && d.managerStep?.status !== "PENDING" && !mode && (
            <div className="flex justify-end gap-2">
              <button onClick={() => setMode("REJECT")} className="rounded-xl border border-red-200 px-5 py-2 text-sm font-medium text-red-600 hover:bg-red-50">Reject</button>
              <button onClick={() => setMode("APPROVE")} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700">Approve</button>
            </div>
          )}
          {d.canDecide && d.managerStep?.status !== "PENDING" && mode && (
            <div className="space-y-3 rounded-2xl border border-indigo-100 p-4">
              <p className="text-sm font-medium text-slate-900">
                {mode === "APPROVE"
                  ? "Approve this correction? The attendance record will be updated and the worked hours and late status recalculated with the existing rules."
                  : "Reject this request? The attendance record stays exactly as it is. The employee will see your reason."}
              </p>
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} rows={2} placeholder={mode === "REJECT" ? "Reason for rejecting (required)" : "Comment for the employee (optional)"} className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm" />
              <div className="flex justify-end gap-2">
                <button onClick={() => { setMode(""); setErr(""); }} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Back</button>
                <button
                  disabled={busy || (mode === "REJECT" && comment.trim().length < 3)}
                  onClick={() => decide()}
                  className={`rounded-xl px-5 py-2 text-sm font-medium text-white disabled:opacity-50 ${mode === "APPROVE" ? "bg-indigo-600 hover:bg-indigo-700" : "bg-red-600 hover:bg-red-700"}`}
                >
                  {busy ? "Saving…" : mode === "APPROVE" ? "Confirm approval" : "Confirm rejection"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function CorrectionsPage() {
  return (
    <Suspense fallback={null}>
      <CorrectionsInner />
    </Suspense>
  );
}
