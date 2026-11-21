"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";

// Daily task targets: HR/Admin only. One number per scope; the most specific one wins (person > team > company).
// Data: GET/POST /team-attendance/targets. Managers never see this panel and the server refuses them anyway.

type Targets = {
  ready: boolean;
  companyId?: string;
  companies?: { id: string; name: string }[];
  company: number | null;
  teams: { teamId: string; name: string; tasksPerDay: number | null }[];
  people: { userId: string; name: string; employeeCode: string | null; tasksPerDay: number | null }[];
};

const input = "rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-700";

export default function TargetsPanel({ onChanged }: { onChanged: () => void }) {
  const [t, setT] = useState<Targets | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<"company" | "team" | "user">("company");
  const [target, setTarget] = useState("");
  const [value, setValue] = useState("");
  // HR / Admin who act on several companies choose which company's targets they are setting (the server checks the access)
  const [company, setCompany] = useState("");

  const load = useCallback(async () => {
    try {
      setT(await apiGet<Targets>(`/team-attendance/targets${company ? `?companyId=${company}` : ""}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [company]);
  useEffect(() => { const x = setTimeout(() => void load(), 0); return () => clearTimeout(x); }, [load]);

  async function save(remove: boolean) {
    if (busy) return;
    setError("");
    setNotice("");
    if (scope !== "company" && !target) { setError("Choose who the target is for."); return; }
    const n = Number(value);
    if (!remove && (!Number.isInteger(n) || n < 1 || n > 1000)) { setError("Enter a whole number from 1 to 1000."); return; }
    setBusy(true);
    try {
      setT(await apiPost<Targets>("/team-attendance/targets", { scope, id: scope === "company" ? undefined : target, tasksPerDay: remove ? null : n, companyId: t?.companyId }));
      setNotice(remove ? "Target removed." : "Target saved.");
      setValue("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const teamsWith = t?.teams.filter((x) => x.tasksPerDay !== null) ?? [];
  const peopleWith = t?.people.filter((x) => x.tasksPerDay !== null) ?? [];

  return (
    <section className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]">
      <h2 className="text-lg font-semibold text-slate-900">Daily task targets</h2>
      <p className="mt-0.5 text-sm text-slate-500">How many tasks should be finished per day. A person&apos;s own target beats their team&apos;s, which beats the company default.</p>

      {t && !t.ready && <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Daily targets are not set up on this server yet. Saving is switched off until the database update is applied.</p>}
      {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {(t?.companies?.length ?? 0) > 1 && (
          <select value={t?.companyId ?? ""} onChange={(e) => { setCompany(e.target.value); setTarget(""); }} className={input} aria-label="Company">
            {t!.companies!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <select value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); setTarget(""); }} className={input} aria-label="Applies to">
          <option value="company">Company default</option>
          <option value="team">A team</option>
          <option value="user">A person</option>
        </select>
        {scope === "team" && (
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={input} aria-label="Team">
            <option value="">Choose a team</option>
            {t?.teams.map((x) => <option key={x.teamId} value={x.teamId}>{x.name}{x.tasksPerDay ? ` (${x.tasksPerDay}/day)` : ""}</option>)}
          </select>
        )}
        {scope === "user" && (
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={input} aria-label="Person">
            <option value="">Choose a person</option>
            {t?.people.map((x) => <option key={x.userId} value={x.userId}>{x.name}{x.employeeCode ? ` (${x.employeeCode})` : ""}{x.tasksPerDay ? ` — ${x.tasksPerDay}/day` : ""}</option>)}
          </select>
        )}
        <input type="number" min={1} max={1000} step={1} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Tasks per day" className={`${input} w-36`} aria-label="Tasks per day" />
        <button disabled={busy || !t?.ready} onClick={() => void save(false)} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Save</button>
        <button disabled={busy || !t?.ready} onClick={() => void save(true)} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Remove this target</button>
      </div>

      <div className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Company default</p>
          <p className="mt-1 text-slate-900">{t?.company ? `${t.company} tasks/day` : <span className="text-slate-400">Target not configured</span>}</p>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Teams</p>
          {teamsWith.length === 0 ? <p className="mt-1 text-slate-400">None set</p> : teamsWith.map((x) => <p key={x.teamId} className="mt-1 text-slate-900">{x.name}: {x.tasksPerDay}/day</p>)}
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">People</p>
          {peopleWith.length === 0 ? <p className="mt-1 text-slate-400">None set</p> : peopleWith.map((x) => <p key={x.userId} className="mt-1 text-slate-900">{x.name}: {x.tasksPerDay}/day</p>)}
        </div>
      </div>
    </section>
  );
}
