"use client";

// Admin setting: how many similar submissions, within how many days, and how alike two tasks must read, before a repetitive-task flag is raised.
// One setting for the whole organisation. "Scan now" checks everyone's recent tasks once (used for the first run or after changing the threshold).
import { useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "@/lib/api";

type Settings = { enabled: boolean; minCount: number; windowDays: number; similarityPct: number };

export default function RepetitionSettingsCard({ onError, onDone }: { onError: (m: string) => void; onDone: (m: string) => void }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [minCount, setMinCount] = useState("3");
  const [windowDays, setWindowDays] = useState("7");
  const [similarityPct, setSimilarityPct] = useState("60");
  const [busy, setBusy] = useState(false);

  function apply(s: Settings) {
    setSaved(s); setEnabled(s.enabled); setMinCount(String(s.minCount)); setWindowDays(String(s.windowDays)); setSimilarityPct(String(s.similarityPct));
  }
  useEffect(() => {
    apiGet<{ ready: boolean; settings: Settings }>("/tasks/repetition/settings").then((r) => { setReady(r.ready); apply(r.settings); }).catch(() => setReady(null));
  }, []);

  async function save() {
    setBusy(true);
    try {
      const r = await apiPut<{ settings: Settings }>("/tasks/repetition/settings", { enabled, minCount: Number(minCount), windowDays: Number(windowDays), similarityPct: Number(similarityPct) });
      apply(r.settings);
      onDone("Repetitive task detection settings saved. New submissions use them straight away.");
    } catch (e) { onError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  async function scan() {
    setBusy(true);
    try {
      const r = await apiPost<{ checked: number; raised: number }>("/tasks/repetition/scan");
      onDone(`Checked ${r.checked} ${r.checked === 1 ? "person" : "people"} with enough recent tasks; ${r.raised} new ${r.raised === 1 ? "flag" : "flags"} raised.`);
    } catch (e) { onError(e instanceof Error ? e.message : "Could not scan"); } finally { setBusy(false); }
  }

  if (ready === null || !saved) return null;
  const changed = enabled !== saved.enabled || Number(minCount) !== saved.minCount || Number(windowDays) !== saved.windowDays || Number(similarityPct) !== saved.similarityPct;
  const field = "mt-1 block w-28 rounded-xl border border-indigo-200 px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 disabled:opacity-50";
  return (
    <div className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]" data-testid="repetition-settings">
      <h3 className="text-sm font-semibold text-slate-900">Repetitive task detection</h3>
      <p className="mt-1 text-sm text-slate-500">
        When an employee submits the same or very similar task several times within a few days, a flag is raised for their manager to review. It only asks a person to
        look: it never changes a rating, salary, attendance or productivity score. Tasks assigned by managers and deleted tasks are never compared. One setting for every company.
      </p>
      {!ready && <p className="mt-2 text-xs text-amber-700">Not available yet: the database update for this feature has not been applied.</p>}
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm text-slate-800">
          <input type="checkbox" checked={enabled} disabled={!ready} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-indigo-600" />
          Switch on
        </label>
        <label className="text-xs text-slate-500"><span className="block">Similar submissions</span>
          <input type="number" min={2} max={20} value={minCount} disabled={!ready} onChange={(e) => setMinCount(e.target.value)} aria-label="Similar submissions needed" className={field} /></label>
        <label className="text-xs text-slate-500"><span className="block">Within (days)</span>
          <input type="number" min={1} max={60} value={windowDays} disabled={!ready} onChange={(e) => setWindowDays(e.target.value)} aria-label="Within this many days" className={field} /></label>
        <label className="text-xs text-slate-500"><span className="block">Similarity (%)</span>
          <input type="number" min={30} max={100} value={similarityPct} disabled={!ready} onChange={(e) => setSimilarityPct(e.target.value)} aria-label="How alike two tasks must read, in percent" className={field} /></label>
        <button type="button" onClick={() => void save()} disabled={busy || !ready || !changed} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">Save</button>
        <button type="button" onClick={() => void scan()} disabled={busy || !ready} className="rounded-xl border border-indigo-200 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-40">Scan now</button>
      </div>
      <p className="mt-2 text-xs text-slate-400">Starts at 3 similar submissions within 7 days at 60% similarity. A lower similarity flags more wording variations; a higher one needs near-identical text.</p>
    </div>
  );
}
