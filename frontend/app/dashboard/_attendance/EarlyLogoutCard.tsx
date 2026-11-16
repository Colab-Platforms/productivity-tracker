// Admin setting: the 2nd and 4th Saturday early logout policy (one setting for the whole organisation).
// It is a shorter working day, not a week-off or a holiday. Days before the start date are never changed.

"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPut } from "@/lib/api";

type Policy = { ready: boolean; enabled: boolean; logoutTime: string; startDate: string | null; targetHours: number | null; saturdays: number[]; label: string; updatedAt: string | null };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function EarlyLogoutCard({ onError, onDone }: { onError: (m: string) => void; onDone: (m: string) => void }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState("16:00");
  const [start, setStart] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  function apply(p: Policy) {
    setPolicy(p);
    setEnabled(p.enabled);
    setTime(p.logoutTime);
    setStart(p.startDate ?? "");
    setTarget(p.targetHours === null ? "" : String(p.targetHours));
  }

  // Loaded once on open (the parent passes new callbacks on every render, so they are not dependencies).
  useEffect(() => {
    apiGet<Policy>("/admin/early-logout-policy")
      .then(apply)
      .catch((e) => onError(e instanceof Error ? e.message : "Could not load the early logout setting"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setBusy(true);
    try {
      const p = await apiPut<Policy>("/admin/early-logout-policy", { enabled, logoutTime: time, startDate: start || null, targetHours: target === "" ? null : Number(target) });
      apply(p);
      onDone(p.enabled ? `Early logout policy is on from ${p.startDate}.` : "Early logout policy is off.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!policy) return null;
  const changed = enabled !== policy.enabled || time !== policy.logoutTime || (start || null) !== policy.startDate || target !== (policy.targetHours === null ? "" : String(policy.targetHours));
  return (
    <div className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]" data-testid="early-logout-card">
      <h3 className="text-sm font-semibold text-slate-900">Early logout policy</h3>
      <p className="mt-1 text-sm text-slate-500">
        On the 2nd and 4th Saturday of every month the working day ends early. Logging out at that time or later counts as a full day, with no early-logout flag and no half-day.
        It is a shorter day, not a weekly off or a holiday. Actual login and logout times are always kept, and days before the start date are never changed.
        This is one setting for every company.
      </p>
      {!policy.ready && <p className="mt-2 text-xs text-amber-700">Not available yet: the database update for this feature has not been applied.</p>}
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" checked={enabled} disabled={!policy.ready} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-indigo-600" />
          Switch on
        </label>
        <label className="text-xs text-slate-500">
          <span className="block">Applicable Saturdays</span>
          <span className="mt-1 block rounded-xl border border-indigo-100 bg-slate-50 px-3 py-2 text-sm text-slate-700">Second and fourth</span>
        </label>
        <label className="text-xs text-slate-500">
          <span className="block">Logout time</span>
          <input
            type="time"
            value={time}
            disabled={!policy.ready}
            onChange={(e) => setTime(e.target.value)}
            aria-label="Early logout time"
            className="mt-1 block rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 disabled:opacity-50"
          />
        </label>
        <label className="text-xs text-slate-500">
          <span className="block">Applies from</span>
          <input
            type="date"
            value={start}
            min={enabled && !policy.enabled ? today() : undefined}
            disabled={!policy.ready}
            onChange={(e) => setStart(e.target.value)}
            aria-label="First day the policy applies"
            className="mt-1 block rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 disabled:opacity-50"
          />
        </label>
        <label className="text-xs text-slate-500">
          <span className="block">Expected productive hours</span>
          <input
            type="number"
            min={1}
            max={12}
            step={0.25}
            value={target}
            placeholder="From shift"
            disabled={!policy.ready}
            onChange={(e) => setTarget(e.target.value)}
            aria-label="Expected productive hours on those Saturdays"
            className="mt-1 block w-32 rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 disabled:opacity-50"
          />
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!policy.ready || busy || !changed || (enabled && !start)}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="mt-2 text-xs text-slate-400">Expected productive hours is the target Reports and low-productivity alerts use on those Saturdays (for example 5.25). Leave it blank to scale the normal target by each person's shift; people with no shift then keep the normal target. It never changes who is Present.</p>
      {enabled && !start && <p className="mt-2 text-xs text-amber-700">Choose the first day the policy applies.</p>}
    </div>
  );
}
