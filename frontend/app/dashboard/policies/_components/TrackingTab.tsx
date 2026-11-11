"use client";

import Link from "next/link";
import { useState } from "react";
import { downloadCsv } from "../../reports/_team/format";
import { card, field, fmtDateTime, useApi, useCompany, withCompany, type Tracking } from "../_lib";

// HR / Admin: who has confirmed which policy, who has opened it but not confirmed, and who has not opened it.
// One row per person per published policy. Filters narrow the list; the CSV is exactly the rows on screen.

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className={`rounded-xl border p-4 ${tone ?? "border-indigo-100 bg-white"}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

export default function TrackingTab({ reload }: { reload: number }) {
  const co = useCompany();
  const [policyId, setPolicyId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [userId, setUserId] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");

  const qs = new URLSearchParams();
  if (policyId) qs.set("policyId", policyId);
  if (teamId) qs.set("teamId", teamId);
  if (userId) qs.set("userId", userId);
  if (status) qs.set("status", status);
  if (search.trim()) qs.set("search", search.trim());
  const { data, error } = useApi<Tracking>(withCompany(`/policies/tracking?${qs.toString()}`, co), reload);

  function exportCsv() {
    if (!data) return;
    downloadCsv(
      `policy-acknowledgments-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Employee name", "Employee ID", "Department", "Policy name", "Acknowledgment status", "Acknowledged on"],
      data.rows.map((r) => [r.name, r.employeeCode, r.team, r.policyTitle, r.status === "ACKNOWLEDGED" ? "Acknowledged" : "Pending", r.acknowledgedAt ?? ""])
    );
  }

  const s = data?.summary;
  const employees = data ? new Set(data.rows.map((r) => r.userId)).size : null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Employees" value={employees ?? "—"} />
        <Stat label="Acknowledgments due" value={s?.total ?? "—"} />
        <Stat label="Acknowledged" value={s?.acknowledged ?? "—"} tone="border-emerald-100 bg-emerald-50/60" />
        <Stat label="Pending" value={s ? s.pending : "—"} tone="border-orange-100 bg-orange-50/60" />
        <Stat label="Completion" value={s?.completionPercent == null ? "—" : `${s.completionPercent}%`} tone="border-violet-100 bg-violet-50/60" />
      </div>

      <section className={card}>
        <div className="flex flex-wrap items-end gap-3 px-5 py-4">
          <label className="block w-52 text-xs text-slate-500">Policy
            <select value={policyId} onChange={(e) => setPolicyId(e.target.value)} className={`${field} mt-1`}><option value="">All policies</option>{data?.policies.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
          <label className="block w-44 text-xs text-slate-500">Department (team)
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className={`${field} mt-1`}><option value="">All teams</option>{data?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label className="block w-48 text-xs text-slate-500">Employee
            <select value={userId} onChange={(e) => setUserId(e.target.value)} className={`${field} mt-1`}><option value="">All employees</option>{data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.employeeCode ? ` (${p.employeeCode})` : ""}</option>)}</select></label>
          <label className="block w-48 text-xs text-slate-500">Status
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${field} mt-1`}><option value="">All</option><option value="ACKNOWLEDGED">Acknowledged</option><option value="PENDING">Pending</option></select></label>
          <label className="block w-48 text-xs text-slate-500">Search
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or employee ID" className={`${field} mt-1`} /></label>
          <button onClick={exportCsv} disabled={!data || data.rows.length === 0} className="ml-auto rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Export CSV</button>
        </div>

        {error && !data && <p className="mx-5 mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Couldn&apos;t load the report: {error}</p>}
        <div className="overflow-x-auto border-t border-indigo-50">
          {!data && !error ? (
            <div className="space-y-2 p-6" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10" />)}</div>
          ) : data && data.rows.length === 0 ? (
            <p className="px-6 py-12 text-center text-sm text-slate-500">Nothing to show. Publish a policy, or change the filters.</p>
          ) : data ? (
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-50"><tr className="text-left text-xs font-medium text-slate-500">
                <th className="px-4 py-3">Employee name</th><th className="px-4 py-3">Employee ID</th><th className="px-4 py-3">Department</th><th className="px-4 py-3">Policy name</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Acknowledged on</th><th className="px-4 py-3">Action</th>
              </tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.userId}|${r.policyId}`} className="border-t border-indigo-50">
                    <td className="px-4 py-2.5 font-medium text-slate-900">{r.name}</td>
                    <td className="px-4 py-2.5 text-slate-600">{r.employeeCode ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-600">{r.team ?? "—"}</td>
                    <td className="px-4 py-2.5 text-slate-800">{r.policyTitle}{r.inAudience === false && <span className="ml-2 text-xs text-slate-400">not in audience</span>}</td>
                    <td className="px-4 py-2.5"><span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${r.status === "ACKNOWLEDGED" ? "bg-emerald-50 text-emerald-700" : "bg-orange-50 text-orange-700"}`}>{r.status === "ACKNOWLEDGED" ? "Acknowledged" : "Pending"}</span></td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{fmtDateTime(r.acknowledgedAt)}</td>
                    <td className="px-4 py-2.5"><Link href={withCompany(`/dashboard/policies/${r.policyId}`, co)} className="text-xs font-medium text-indigo-600 hover:underline">View details</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
        {data?.truncated && <p className="px-5 py-3 text-xs text-amber-700">Showing the first 10,000 rows. Narrow the filters to see the rest.</p>}
      </section>
    </div>
  );
}
