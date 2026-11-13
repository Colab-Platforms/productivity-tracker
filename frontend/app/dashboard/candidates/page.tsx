"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, getToken , API_BASE } from "@/lib/api";
import { useMe } from "../layout";
import { ProgressBar } from "./ProgressBar";

// ---------------------------------------------------------------------------
// HR — THE CANDIDATE PIPELINE
//
// One screen for every joiner who isn't active yet: where they are, what
// they've uploaded, what HR still owes them, and how long HR has been sitting
// on it. The SLA clock starts when the CANDIDATE finishes, so it only ever
// measures HR's own delay.
// ---------------------------------------------------------------------------

type Candidate = {
  id: string;
  name: string;
  email: string;
  employeeCode: string | null;
  designation: string | null;
  status: string;
  onboardingStatus: string;
  dateOfJoining: string | null;
  createdAt: string;
  submitted: number;
  approved: number;
  rejected: number;
  progressPercent: number;
  submittedPercent: number;
  mandatoryCount: number;
  pendingReview: number;
  waitingHours: number;
  slaHours: number;
  isOverdue: boolean;
};

type Doc = {
  requirementId?: string | null;
  id: string;
  category?: string;
  status?: string;
  fileName?: string | null;
  rejectionReason?: string | null;
  uploadedAt?: string | null;
  label?: string;
  requirement?: { label?: string; isMandatory?: boolean } | null;
  isMandatory?: boolean;
};

// The stages, in the order the schema defines them.
const STAGES = [
  { key: "OFFER_SENT", label: "Offer sent" },
  { key: "OFFER_ACCEPTED", label: "Accepted" },
  { key: "DOCUMENTS_PENDING", label: "Uploading" },
  { key: "DOCUMENTS_SUBMITTED", label: "HR review" },
  { key: "AWAITING_RESUME", label: "Needs contract" },
  { key: "ACTIVE", label: "Active" },
];

const STAGE_CHIP: Record<string, string> = {
  OFFER_SENT: "bg-[#E7F6F1] text-slate-600",
  OFFER_ACCEPTED: "bg-sky-50 text-sky-700",
  DOCUMENTS_PENDING: "bg-amber-50 text-amber-700",
  DOCUMENTS_SUBMITTED: "bg-indigo-50 text-indigo-700",
  AWAITING_RESUME: "bg-violet-50 text-violet-700",
  ACTIVE: "bg-emerald-50 text-emerald-700",
};

const DOC_CHIP: Record<string, string> = {
  REQUESTED: "bg-[#E7F6F1] text-slate-500",
  SUBMITTED: "bg-amber-50 text-amber-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-red-50 text-red-700",
};

const pretty = (s: string) => s.replace(/_/g, " ").toLowerCase();

function docLabel(d: Doc) {
  return (
    d.requirement?.label ??
    d.label ??
    (d.category ? pretty(d.category) : "Document")
  );
}

export default function CandidatesPage() {
  const me = useMe();

  const [rows, setRows] = useState<Candidate[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<unknown>("/onboarding/candidates");
      // The endpoint wraps the list as { candidates: [...] }. Accepting the
      // bare array as well means neither side can silently empty this screen
      // by changing its mind about the wrapper - which is exactly what
      // happened here, with no error raised on either side.
      const list = Array.isArray(res)
        ? res
        : ((res as { candidates?: Candidate[] })?.candidates ?? []);
      setRows(list as Candidate[]);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load candidates");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function openCandidate(id: string) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setDocs([]);
    setLoadingDocs(true);
    try {
      const res = await apiGet<unknown>(`/onboarding/candidates/${id}`);
      // Shape varies by endpoint version, so accept the obvious variants
      // rather than blanking the panel on a key I didn't predict.
      const list =
        (res as { checklist?: Doc[] })?.checklist ??
        (res as { documents?: Doc[] })?.documents ??
        (res as { requirements?: Doc[] })?.requirements ??
        (Array.isArray(res) ? (res as Doc[]) : []);
      setDocs(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load documents");
    } finally {
      setLoadingDocs(false);
    }
  }

  // A plain <a href> is a browser navigation, and browsers attach no login
  // token to those - which is why View returned NOT_AUTHENTICATED. Fetching
  // it ourselves with the token and opening the result keeps the file behind
  // authentication instead of putting a token in the address bar.
  async function viewDocument(docId: string) {
    const base = API_BASE;
    try {
      const res = await fetch(base + "/onboarding/documents/" + docId + "/file", {
        headers: { Authorization: "Bearer " + (getToken() ?? "") },
      });
      if (!res.ok) throw new Error("Could not open that document");
      const url = URL.createObjectURL(await res.blob());
      window.open(url, "_blank", "noreferrer");
      // Released after the new tab has had time to take it.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that document");
    }
  }
  async function review(docId: string, approve: boolean, why?: string) {
    if (!docId) return; // nothing was uploaded for this row, so there is nothing to review
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // A superset body: the endpoint reads whichever fields it expects and
      // ignores the rest. Cheaper than another round trip to confirm names.
      await apiPost(`/onboarding/documents/${docId}/review`, {
        approve,
        status: approve ? "APPROVED" : "REJECTED",
        reason: why ?? null,
        rejectionReason: why ?? null,
      });
      setNotice(approve ? "Approved." : "Sent back to the candidate.");
      setRejecting(null);
      setReason("");
      if (openId) await openCandidate(openId === null ? "" : openId);
      await load();
      if (openId) {
        setOpenId(openId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that");
    } finally {
      setBusy(false);
    }
  }

  if (!me) return null;

  const overdue = rows.filter((r) => r.isOverdue).length;
  const waitingOnHr = rows.filter((r) => r.pendingReview > 0).length;
  const needsContract = rows.filter(
    (r) => r.onboardingStatus === "AWAITING_RESUME"
  ).length;

  return (
    <div>
      <header className="mb-6">
        <p className="text-sm text-slate-400">HR</p>
        <h1 className="mt-0.5 text-2xl font-semibold text-slate-900">
          Joiners
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Everyone who hasn&apos;t started yet. The clock on each row begins
          when the candidate finishes uploading — it measures how long they
          have been waiting on you.
        </p>
      </header>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "In the pipeline", value: rows.length, tone: "text-slate-900" },
          { label: "Waiting on HR", value: waitingOnHr, tone: "text-indigo-600" },
          { label: "Past the deadline", value: overdue, tone: "text-red-600" },
          { label: "Need a contract", value: needsContract, tone: "text-violet-600" },
        ].map((c) => (
          <div
            key={c.label}
            className="rounded-2xl bg-white shadow-[var(--shadow-card)] px-4 py-3"
          >
            <p className="text-xs text-slate-500">{c.label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${c.tone}`}>
              {c.value}
            </p>
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-2xl bg-white shadow-[var(--shadow-card)] px-6 py-14 text-center">
          <p className="text-sm text-slate-500">Nobody is mid-onboarding.</p>
          <p className="mt-1 text-xs text-slate-400">
            New joiners appear here the moment HR creates them.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((c) => {
            const open = openId === c.id;
            // Approved-only, computed on the server. The old sum counted
            // uploaded-but-unreviewed papers as done, so it read 100% while
            // HR still had documents sitting in review.
            const pct = c.progressPercent ?? 0;
            const hoursLeft = c.slaHours - c.waitingHours;

            return (
              <section
                key={c.id}
                className={`overflow-hidden rounded-2xl border bg-white ${
                  c.isOverdue ? "border-red-200" : "border-indigo-100"
                }`}
              >
                <button
                  onClick={() => openCandidate(c.id)}
                  className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-indigo-50/60/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-slate-900">{c.name}</p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          STAGE_CHIP[c.onboardingStatus] ?? STAGE_CHIP.OFFER_SENT
                        }`}
                      >
                        {pretty(c.onboardingStatus)}
                      </span>
                      {c.pendingReview > 0 && (
                        <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white">
                          {c.pendingReview} to review
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-400">
                      {c.designation ?? "No designation"}
                      {c.employeeCode ? ` · ${c.employeeCode}` : ""} · {c.email}
                    </p>
                  </div>

                  <div className="hidden w-36 shrink-0 sm:block">
                    <p className="text-xs text-slate-500">
                      {c.approved} of {c.mandatoryCount} approved
                    </p>
                    <div className="mt-1.5">
                      <ProgressBar
                        percent={pct}
                        submittedPercent={c.submittedPercent}
                      />
                    </div>
                    {c.pendingReview > 0 && (
                      <p className="mt-1 text-[11px] text-amber-600">
                        {c.pendingReview} awaiting your review
                      </p>
                    )}
                  </div>

                  <div className="w-24 shrink-0 text-right">
                    {c.waitingHours > 0 ? (
                      <>
                        <p
                          className={`text-sm font-semibold tabular-nums ${
                            c.isOverdue ? "text-red-600" : "text-slate-900"
                          }`}
                        >
                          {c.isOverdue
                            ? `+${c.waitingHours - c.slaHours}h`
                            : `${Math.max(0, hoursLeft)}h`}
                        </p>
                        <p className="text-[11px] text-slate-400">
                          {c.isOverdue ? "overdue" : "left"}
                        </p>
                      </>
                    ) : (
                      <p className="text-[11px] text-slate-400">
                        waiting on them
                      </p>
                    )}
                  </div>
                </button>

                {open && (
                  <div className="border-t border-indigo-50 bg-slate-50/50 px-5 py-4">
                    {/* The gate nobody mentions until a joiner is stuck
                        behind it. */}
                    {c.onboardingStatus === "AWAITING_RESUME" && (
                      <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
                        <strong>Every document is approved.</strong> The tracker
                        stays locked until HR uploads their resume or signed
                        contract — that last upload is what activates them.
                      </div>
                    )}

                    {loadingDocs ? (
                      <div className="space-y-2">
                        <div className="skeleton h-10" />
                        <div className="skeleton h-10" />
                      </div>
                    ) : docs.length === 0 ? (
                      <p className="py-3 text-sm text-slate-500">
                        Nothing uploaded yet.
                      </p>
                    ) : (
                      <ul className="divide-y divide-indigo-50 overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
                        {docs.map((d) => {
                          const status = String(d.status ?? "REQUESTED");
                          const canReview = status === "SUBMITTED";

                          return (
                            <li key={String(d.requirementId ?? d.id ?? d.label)} className="px-4 py-3">
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <p className="text-sm font-medium text-slate-900">
                                      {docLabel(d)}
                                    </p>
                                    <span
                                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                        DOC_CHIP[status] ?? DOC_CHIP.REQUESTED
                                      }`}
                                    >
                                      {status.toLowerCase()}
                                    </span>
                                  </div>
                                  {d.fileName && (
                                    <p className="mt-0.5 truncate text-xs text-slate-400">
                                      {d.fileName}
                                    </p>
                                  )}
                                  {d.rejectionReason && (
                                    <p className="mt-1 text-xs text-red-600">
                                      Sent back: {d.rejectionReason}
                                    </p>
                                  )}
                                </div>

                                <div className="flex shrink-0 items-center gap-2">
                                  {d.fileName && d.id && (
                                    <a
                                      href="#" onClick={(e) => { e.preventDefault(); void viewDocument(d.id); }}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="rounded-xl border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-indigo-50/60"
                                    >
                                      View
                                    </a>
                                  )}
                                  {canReview && (
                                    <>
                                      <button
                                        disabled={busy}
                                        onClick={() => review(d.id, true)}
                                        className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                                      >
                                        Approve
                                      </button>
                                      <button
                                        disabled={busy}
                                        onClick={() =>
                                          setRejecting(
                                            rejecting === d.id ? null : d.id
                                          )
                                        }
                                        className="rounded-xl border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                                      >
                                        Send back
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>

                              {/* Only a submitted document can be sent back. A document nobody has uploaded has
                                  id null, and null === null (the idle state) used to open this box on every such row. */}
                              {canReview && rejecting !== null && rejecting === d.id && (
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <input
                                    value={reason}
                                    onChange={(e) => setReason(e.target.value)}
                                    placeholder="Why? The candidate sees this, so be specific."
                                    className="min-w-56 flex-1 rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                                  />
                                  <button
                                    disabled={busy || reason.trim() === ""}
                                    onClick={() =>
                                      review(d.id, false, reason.trim())
                                    }
                                    className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
                                  >
                                    Send back
                                  </button>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {STAGES.map((s) => {
                        const reached =
                          STAGES.findIndex(
                            (x) => x.key === c.onboardingStatus
                          ) >= STAGES.findIndex((x) => x.key === s.key);
                        return (
                          <span
                            key={s.key}
                            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                              reached
                                ? "bg-indigo-600 text-white"
                                : "bg-white text-slate-400 ring-1 ring-slate-200"
                            }`}
                          >
                            {s.label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}