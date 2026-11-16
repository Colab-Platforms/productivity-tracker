// Admin setting: how many previous days an employee may add tasks for without giving a reason (per company).
// Older than that (up to the fixed 14-day limit) needs a reason; older than 14 days is never accepted.

"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPut } from "@/lib/api";

type Policy = { ready: boolean; maxDays: number; defaultDays: number; companies: { id: string; name: string; allowedDays: number }[] };

export default function LatePolicyCard({ onError, onDone }: { onError: (m: string) => void; onDone: (m: string) => void }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");

  const apply = useCallback((p: Policy) => {
    setPolicy(p);
    setDraft(Object.fromEntries(p.companies.map((c) => [c.id, String(c.allowedDays)])));
  }, []);

  // Loaded once on open (the parent passes new callbacks on every render, so they are not dependencies).
  useEffect(() => {
    apiGet<Policy>("/tasks/late-policy/all")
      .then(apply)
      .catch((e) => onError(e instanceof Error ? e.message : "Could not load the previous-day task setting"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply]);

  async function save(id: string, name: string) {
    setBusy(id);
    try {
      const p = await apiPut<Policy>("/tasks/late-policy", { companyId: id, allowedDays: Number(draft[id]) });
      apply(p);
      onDone(`Saved for ${name}.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy("");
    }
  }

  if (!policy) return null;
  return (
    <div className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
      <h3 className="text-sm font-semibold text-slate-900">Previous-day tasks</h3>
      <p className="mt-1 text-sm text-slate-500">
        How many days back an employee can add tasks without giving a reason (default {policy.defaultDays}). Older than that, up to {policy.maxDays} days, they must write a reason. Nothing older than {policy.maxDays} days is accepted. Late tasks are always marked and always reviewed by the tagged manager.
      </p>
      {!policy.ready && <p className="mt-2 text-xs text-amber-700">Not switched on yet: the database update for this feature has not been applied.</p>}
      <div className="mt-4 space-y-3">
        {policy.companies.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{c.name}</span>
            <input
              type="number"
              min={0}
              max={policy.maxDays}
              step={1}
              value={draft[c.id] ?? ""}
              disabled={!policy.ready}
              onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))}
              aria-label={`Allowed previous days for ${c.name}`}
              className="w-24 rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 disabled:opacity-50"
            />
            <span className="text-xs text-slate-400">days</span>
            <button
              type="button"
              onClick={() => void save(c.id, c.name)}
              disabled={!policy.ready || busy === c.id || draft[c.id] === String(c.allowedDays)}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              {busy === c.id ? "Saving…" : "Save"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
