"use client";

// ADMIN DASHBOARD > "My Query Desk": the department requests TAGGED to the signed-in Admin (their own account id, read by the server; nothing
// is typed or hardcoded). It reads the same call the Query Desk's "Assigned to me" filter reads (GET /queries/dept?view=TAGGED), so the
// numbers here and the list there can never disagree. Organisation-wide visibility is a different thing and stays in Query Desk > All queries.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";

type Item = {
  id: string; reference: string; title: string; priority: string; priorityLabel: string; approvalStatus: string; approvalLabel: string;
  workStatus: string | null; workLabel: string | null; department: string; raisedBy: { name: string; employeeCode: string | null };
  company?: string; project?: string | null; createdAt: string; needsYou: boolean; statusBucket?: string;
};
type Res = { ready: boolean; items: Item[]; counts?: Record<string, number> };

const PRIORITY_CHIP: Record<string, string> = { LOW: "bg-slate-100 text-slate-600", MEDIUM: "bg-sky-50 text-sky-700", HIGH: "bg-orange-50 text-orange-700", URGENT: "bg-red-50 text-red-600" };
const STATUS_CHIP: Record<string, string> = { PENDING: "bg-violet-50 text-violet-700", APPROVED: "bg-emerald-50 text-emerald-700", ON_HOLD: "bg-orange-50 text-orange-700", REJECTED: "bg-red-50 text-red-600", RESOLVED: "bg-sky-50 text-sky-700" };
const day = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(s));
const OPEN = (i: Item) => i.statusBucket !== "REJECTED" && i.statusBucket !== "RESOLVED";

// What the status badge says: the approval step while it is still being approved, then the department's work status.
export function badgeText(i: Pick<Item, "approvalStatus" | "approvalLabel" | "workLabel" | "statusBucket">): string {
  if (i.approvalStatus === "APPROVED") return i.workLabel ?? "Approved";
  return i.approvalLabel;
}

export default function MyQueryDesk({ reload }: { reload: number }) {
  const [res, setRes] = useState<{ data?: Res; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    apiGet<Res>("/queries/dept?view=TAGGED").then((data) => live && setRes({ data })).catch((e: Error) => live && setRes((p) => ({ data: p?.data, error: e.message })));
    return () => { live = false; };
  }, [reload]);

  const items = useMemo(() => res?.data?.items ?? [], [res]);
  const stats = useMemo(() => {
    const open = items.filter(OPEN);
    return {
      total: items.length,
      action: items.filter((i) => i.needsYou).length,
      pendingAdmin: items.filter((i) => i.approvalStatus === "PENDING_ADMIN").length,
      waitingManager: items.filter((i) => i.approvalStatus === "PENDING_MANAGER").length,
      awaitingDept: items.filter((i) => i.approvalStatus === "APPROVED" && (i.workStatus === "AWAITING_ACTION" || i.workStatus === "REOPENED")).length,
      withDept: items.filter((i) => i.approvalStatus === "APPROVED" && (i.workStatus === "NOT_STARTED" || i.workStatus === "IN_PROGRESS")).length,
      onHold: items.filter((i) => i.statusBucket === "ON_HOLD").length,
      closed: items.length - open.length,
    };
  }, [items]);
  // Needs action first, then the other open ones (newest first), then the closed ones; the server already sends newest first.
  const shown = useMemo(() => [...items].sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || Number(OPEN(b)) - Number(OPEN(a))).slice(0, 6), [items]);

  const tile = (label: string, value: number, tone: string, testId: string) => (
    <div className="rounded-xl bg-[#F3F7F6] px-3 py-2.5" data-testid={testId}>
      <p className={`text-xl font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="text-[11px] leading-tight text-slate-500">{label}</p>
    </div>
  );

  return (
    <section className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)] sm:p-6" aria-label="My Query Desk" data-testid="my-query-desk">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">My Query Desk</h2>
          <p className="mt-0.5 text-xs text-slate-500">Department requests tagged to you. Everything else in the organization is under Query Desk &gt; All queries.</p>
        </div>
        <Link href="/dashboard/queries?tab=dept&view=TAGGED" data-testid="mqd-view-all" className="shrink-0 text-xs font-medium text-indigo-600 hover:underline">View all my queries</Link>
      </div>

      {res?.error && !res.data && <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{res.error}</p>}
      {!res && <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-16" />)}</div>}
      {res?.data && !res.data.ready && <p className="mt-4 text-sm text-slate-500">Department requests are not switched on yet on this server.</p>}

      {res?.data?.ready && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
            {tile("Tagged to me", stats.total, "text-slate-900", "mqd-total")}
            {tile("Action required from me", stats.action, stats.action > 0 ? "text-rose-600" : "text-slate-900", "mqd-action")}
            {tile("Pending my approval", stats.pendingAdmin, "text-violet-700", "mqd-pending-admin")}
            {tile("With the manager first", stats.waitingManager, "text-amber-700", "mqd-pending-manager")}
            {tile("Approved, awaiting department", stats.awaitingDept, "text-emerald-700", "mqd-awaiting")}
            {tile("With the department / on hold", stats.withDept + stats.onHold, "text-sky-700", "mqd-with-dept")}
            {tile("Closed (resolved or rejected)", stats.closed, "text-slate-500", "mqd-closed")}
          </div>

          {items.length === 0 ? (
            <p className="mt-4 rounded-xl bg-[#F3F7F6] px-4 py-6 text-center text-sm text-slate-500" data-testid="mqd-empty">No query is tagged to you.</p>
          ) : (
            <ul className="mt-4 divide-y divide-indigo-50" data-testid="mqd-list">
              {shown.map((i) => (
                <li key={i.id}>
                  <Link href={`/dashboard/queries?tab=dept&id=${i.id}`} className="flex flex-wrap items-start justify-between gap-3 rounded-xl px-1 py-3 hover:bg-indigo-50/40 sm:px-2" data-testid="mqd-row">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span className="rounded-full bg-[#F3F7F6] px-2 py-0.5 font-medium text-slate-600">{i.department}</span>
                        <span className="tabular-nums">{i.reference}</span>
                        <span className={`rounded-full px-2 py-0.5 font-medium ${PRIORITY_CHIP[i.priority] ?? ""}`}>{i.priorityLabel}</span>
                        {i.needsYou && <span className="rounded-full bg-rose-500 px-2 py-0.5 font-medium text-white">Action required</span>}
                      </p>
                      <p className="mt-1 truncate text-sm font-medium text-slate-900">{i.title}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {i.raisedBy.name}{i.raisedBy.employeeCode ? ` (${i.raisedBy.employeeCode})` : ""} · {[i.company, i.project ? `Project: ${i.project}` : null].filter(Boolean).join(" · ")}{i.company || i.project ? " · " : ""}{day(i.createdAt)}
                      </p>
                    </div>
                    <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CHIP[i.statusBucket ?? ""] ?? "bg-slate-100 text-slate-600"}`}>{badgeText(i)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {items.length > shown.length && <p className="mt-2 text-xs text-slate-500">Showing {shown.length} of {items.length}. <Link href="/dashboard/queries?tab=dept&view=TAGGED" className="font-medium text-indigo-600 hover:underline">View all my queries</Link></p>}
        </>
      )}
    </section>
  );
}
