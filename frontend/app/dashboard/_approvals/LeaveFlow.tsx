"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// LEAVE FLOW (shared pieces for the Leave page): the single status shown for a request, who it was sent to, its projects and its approval
// history. The server decides every rule; these only show what it sends.
// ---------------------------------------------------------------------------

export type Stage = "PENDING_MANAGER" | "PENDING_ADMIN" | "PENDING_HR" | "APPROVED" | "REJECTED" | "CANCELLED";
export type HistoryItem = { at: string; actor: string; role: string; step: string; action: string; comment: string | null };
export type FlowFields = {
  stage?: Stage;
  stageLabel?: string;
  requesterRole?: string;
  tagged?: string | null;
  projects?: { id: string; name: string }[];
  history?: HistoryItem[];
};

const STAGE_STYLE: Record<Stage, string> = {
  PENDING_MANAGER: "bg-amber-50 text-amber-700",
  PENDING_ADMIN: "bg-amber-50 text-amber-700",
  PENDING_HR: "bg-sky-50 text-sky-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-red-50 text-red-600",
  CANCELLED: "bg-slate-100 text-slate-500",
};

export function StageBadge({ stage, label }: { stage: Stage; label?: string }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STAGE_STYLE[stage]}`}>{label ?? stage}</span>;
}

const ROLE_WORD: Record<string, string> = { MANAGER: "Manager", ADMIN: "Admin", HR: "HR", EMPLOYEE: "Employee", SYSTEM: "System" };
const ACTION_WORD: Record<string, string> = { SUBMITTED: "Submitted", APPROVED: "Approved", REJECTED: "Rejected", CANCELLED: "Cancelled", AUTO_APPROVED: "Approved automatically" };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Who the request was sent to and which projects it names, in one quiet line. */
export function FlowLine({ r }: { r: FlowFields }) {
  const bits: string[] = [];
  if (r.tagged && (r.stage === "PENDING_MANAGER" || r.stage === "PENDING_ADMIN")) bits.push(`Waiting for ${r.tagged}`);
  else if (r.tagged) bits.push(`Sent to ${r.tagged}`);
  if (r.projects && r.projects.length > 0) bits.push(`Projects: ${r.projects.map((p) => p.name).join(", ")}`);
  if (bits.length === 0) return null;
  return <p className="mt-1 text-xs text-slate-500">{bits.join(" · ")}</p>;
}

/** The approval history of a request: every submit, approval and rejection with who, in what role, when and why. Collapsed until opened. */
export function History({ items }: { items?: HistoryItem[] }) {
  const [open, setOpen] = useState(false);
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-1.5">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-xs font-medium text-indigo-600 hover:underline">
        {open ? "Hide approval history" : `Approval history (${items.length})`}
      </button>
      {open && (
        <ol className="mt-2 space-y-1.5 border-l-2 border-indigo-100 pl-3">
          {items.map((h, i) => (
            <li key={i} className="text-xs text-slate-600">
              <span className="font-medium text-slate-800">{ACTION_WORD[h.action] ?? h.action}</span> by {h.actor}
              <span className="text-slate-400"> ({ROLE_WORD[h.role] ?? h.role})</span> · {when(h.at)}
              {h.comment && <span className="block text-slate-500">“{h.comment}”</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
