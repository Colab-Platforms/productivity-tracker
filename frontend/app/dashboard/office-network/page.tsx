"use client";

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "@/lib/api";
import { useRoleGate } from "../_routing/useRoleGate";

type Entry = { id: string; cidr: string; label: string; createdAt: string };
type Data = { entries: Entry[]; yourIp: string | null };

const card = "rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]";
const input = "h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-indigo-400";
const btn = "h-10 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50";

// OFFICE NETWORK: the addresses people may clock in from. Login works from anywhere; only clock-in checks this list.
// An empty list means no restriction (anyone can clock in from anywhere).
export default function OfficeNetworkPage() {
  const { allowed } = useRoleGate(["ADMIN", "HR"]);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Data>("/admin/office-ips"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  async function add(body: { cidr?: string; label?: string }) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiPost("/admin/office-ips", body);
      setCidr("");
      setLabel("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: Entry) {
    if (busy) return;
    const last = data?.entries.length === 1;
    const msg = last
      ? `Remove ${e.cidr}? The list will be empty, so ANYONE will be able to clock in from anywhere.`
      : `Remove ${e.cidr}${e.label ? ` (${e.label})` : ""}? People on that network will no longer be able to clock in.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    setError("");
    try {
      await apiDelete(`/admin/office-ips/${e.id}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) return null;
  const entries = data?.entries ?? [];
  const mine = data?.yourIp ?? "";
  const mineListed = entries.some((x) => x.cidr === mine);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Office network</h1>
        <p className="text-sm text-slate-500">People can sign in from anywhere, but can only clock in from these addresses.</p>
      </header>

      {data && entries.length === 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No office address is set, so clock-in is <b>not restricted</b>. Add your office address below to turn the restriction on.
        </div>
      )}
      {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      <section className={card}>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Add an address</h2>
        <p className="mb-3 text-sm text-slate-600">
          The address this computer is using right now: <b>{mine || "unknown"}</b>
          {mineListed && <span className="ml-2 text-emerald-700">(already on the list)</span>}
        </p>
        <div className="flex flex-wrap gap-2">
          <button className={btn} disabled={busy || !mine || mineListed} onClick={() => add({ label: label || "Office" })}>
            Add my current IP
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <input className={`${input} w-56`} placeholder="206.84.235.169 or 192.168.1.0/24" value={cidr} onChange={(e) => setCidr(e.target.value)} aria-label="IP address or range" />
          <input className={`${input} w-48`} placeholder="Label (e.g. Head office)" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} aria-label="Label" />
          <button className={btn} disabled={busy || !cidr.trim()} onClick={() => add({ cidr: cidr.trim(), label })}>
            Add
          </button>
        </div>
      </section>

      <section className={card}>
        <h2 className="mb-3 text-sm font-semibold text-slate-800">Allowed addresses ({entries.length})</h2>
        {entries.length === 0 ? (
          <p className="text-sm text-slate-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span>
                  <span className="font-medium text-slate-900">{e.cidr}</span>
                  {e.label && <span className="ml-2 text-slate-500">{e.label}</span>}
                  {e.cidr === mine && <span className="ml-2 text-emerald-700">(this computer)</span>}
                </span>
                <button className="text-rose-600 hover:underline disabled:opacity-50" disabled={busy} onClick={() => remove(e)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
