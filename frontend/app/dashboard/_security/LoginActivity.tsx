"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { Modal } from "../_employees/Modal";
import { useMe } from "../layout";

// ---------------------------------------------------------------------------
// LOGIN ACTIVITY. One table for two uses:
//   mode "mine"  the signed-in person's OWN history (My Profile). The server decides who they are; nothing here can ask for someone else's.
//   mode "org"   Admin and HR: the people of the companies they act on, with search and filters. The server limits every row; HR gets no analysis.
// Approximate location is only ever shown as approximate and says so when there is none. Browser / system / device are what the browser reported:
// they are never presented as proof of which computer it was.
// ---------------------------------------------------------------------------

type Session = { state: "ACTIVE" | "LOGGED_OUT" | "EXPIRED" | "NOT_TRACKED"; lastActiveAt: string | null; loggedOutAt: string | null; expiresAt: string | null; minutes: number | null };
type Item = {
  id: string; at: string; result: "SUCCESS" | "FAILED" | "BLOCKED"; reason: string | null; reasonText: string | null; offNetwork: boolean;
  employee: { id: string; name: string; employeeCode: string | null; company: string } | null; username: string | null;
  ip: string | null; location: string | null; deviceType: string | null; browser: string | null; os: string | null; session: Session | null; flags?: string[];
};
type Detail = Item & { userAgent: string | null; mode: string | null; attemptsFromThisAddressWithin24Hours?: number; notes: { location: string; device: string } };
type Page = { ready: boolean; admin?: boolean; timezone?: string; total: number; page: number; pageSize: number; pages: number; summary?: { last24Hours: { success: number; failed: number; blocked: number } } | null; items: Item[] };

const FLAG_TEXT: Record<string, string> = {
  BLOCKED: "Blocked: network not authorised",
  MANY_FAILURES: "3 or more failed attempts within an hour",
  NEW_ADDRESS: "First sign-in from this address for this person",
  OFF_NETWORK: "Signed in from outside the authorised network",
};
const FLAG_SHORT: Record<string, string> = { BLOCKED: "Blocked", MANY_FAILURES: "Repeated failures", NEW_ADDRESS: "New address", OFF_NETWORK: "Outside network" };

const RESULT_LABEL = { SUCCESS: "Success", FAILED: "Failed", BLOCKED: "Blocked" } as const;
const RESULT_CHIP = { SUCCESS: "bg-emerald-50 text-emerald-700", FAILED: "bg-amber-50 text-amber-700", BLOCKED: "bg-red-50 text-red-700" } as const;

const field = "h-9 rounded-xl border border-indigo-100 bg-white px-3 text-sm text-slate-800 outline-none focus:border-indigo-400";
const NOT_AVAILABLE = "Location not available";

function when(iso: string | null | undefined, tz: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso));
}
const dur = (m: number | null) => (m === null ? null : m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

function sessionLine(s: Session, tz: string): string {
  if (s.state === "LOGGED_OUT") return `Signed out ${when(s.loggedOutAt, tz)}`;
  if (s.state === "EXPIRED") return `Session expired ${when(s.expiresAt, tz)}`;
  if (s.state === "ACTIVE") return `Signed in, valid until ${when(s.expiresAt, tz)}`;
  return "Session not tracked (signed in before tracking began)";
}

function StatusChip({ it }: { it: Item }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${RESULT_CHIP[it.result]}`}>{RESULT_LABEL[it.result]}</span>
      {it.offNetwork && <span className="rounded-md bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700" title={FLAG_TEXT.OFF_NETWORK}>Outside network</span>}
    </span>
  );
}

export default function LoginActivity({ mode }: { mode: "mine" | "org" }) {
  const me = useMe();
  const org = mode === "org";
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [device, setDevice] = useState("");
  const [ip, setIp] = useState("");
  const [location, setLocation] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Item | null>(null);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (org) {
      if (q.trim()) p.set("q", q.trim());
      if (device) p.set("device", device);
      if (ip.trim()) p.set("ip", ip.trim());
      if (location.trim()) p.set("location", location.trim());
      if (from) p.set("from", from);
      if (to) p.set("to", to);
    }
    if (status) p.set(org ? "status" : "result", status);
    p.set("page", String(page));
    p.set("pageSize", String(pageSize));
    return p.toString();
  }, [org, q, status, device, ip, location, from, to, page, pageSize]);

  const path = org ? "/login-activity" : "/login-activity/mine";
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      apiGet<Page>(`${path}?${query}`)
        .then((d) => { if (live) { setData(d); setError(""); } })
        .catch((e: Error) => live && setError(e.message));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [path, query]);

  // any filter change goes back to the first page
  const set = useCallback(<T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPage(1); }, []);
  const filtering = !!(q || status || device || ip || location || from || to);
  const clear = () => { setQ(""); setStatus(""); setDevice(""); setIp(""); setLocation(""); setFrom(""); setTo(""); setPage(1); };
  const tz = data?.timezone ?? me?.platform?.timezone ?? "Asia/Kolkata";
  const items = data?.items ?? [];

  return (
    <div className="space-y-4" data-testid="login-activity">
      {org && data?.ready && data.summary && (
        <section aria-label="Last 24 hours" className="grid grid-cols-3 gap-3">
          {[
            ["Successful sign-ins", data.summary.last24Hours.success, "text-emerald-700"],
            ["Failed attempts", data.summary.last24Hours.failed, data.summary.last24Hours.failed ? "text-amber-700" : "text-slate-900"],
            ["Blocked (network)", data.summary.last24Hours.blocked, data.summary.last24Hours.blocked ? "text-red-700" : "text-slate-900"],
          ].map(([label, n, tone]) => (
            <div key={String(label)} className="rounded-2xl bg-white p-3.5 shadow-[var(--shadow-card)]">
              <p className="text-[11px] font-medium text-[var(--text-secondary)]">{label} · last 24 hours</p>
              <p className={`mt-1 text-2xl font-bold tabular-nums ${tone}`}>{n as number}</p>
            </div>
          ))}
        </section>
      )}

      <section className="rounded-2xl bg-white p-3 shadow-[var(--shadow-card)] sm:p-4" aria-label="Filters">
        <div className="flex flex-wrap items-end gap-2.5">
          {org && (
            <label className="min-w-[13rem] flex-1 text-xs text-slate-500">Search
              <input id="la-q" value={q} onChange={(e) => set(setQ)(e.target.value)} placeholder="Name, employee ID or username" className={`mt-1 block w-full ${field}`} />
            </label>
          )}
          <label className="text-xs text-slate-500">{org ? "Status" : "Show"}
            <select id="la-status" value={status} onChange={(e) => set(setStatus)(e.target.value)} className={`mt-1 block ${field}`}>
              <option value="">All</option>
              <option value="SUCCESS">Successful</option>
              <option value="FAILED">Failed</option>
              <option value="BLOCKED">Blocked</option>
              {org && <option value="NOT_SUCCESS">Failed or blocked</option>}
            </select>
          </label>
          {org && (
            <>
              <label className="text-xs text-slate-500">Device
                <select id="la-device" value={device} onChange={(e) => set(setDevice)(e.target.value)} className={`mt-1 block ${field}`}>
                  <option value="">All</option><option>Desktop</option><option>Mobile</option><option>Tablet</option><option>Bot</option><option>Unknown</option>
                </select>
              </label>
              <label className="text-xs text-slate-500">IP address<input id="la-ip" value={ip} onChange={(e) => set(setIp)(e.target.value)} placeholder="e.g. 206.84" className={`mt-1 block w-36 ${field}`} /></label>
              <label className="text-xs text-slate-500">Location<input id="la-location" value={location} onChange={(e) => set(setLocation)(e.target.value)} placeholder="City or country" className={`mt-1 block w-36 ${field}`} /></label>
              <label className="text-xs text-slate-500">From<input id="la-from" type="date" value={from} onChange={(e) => set(setFrom)(e.target.value)} className={`mt-1 block ${field}`} /></label>
              <label className="text-xs text-slate-500">To<input id="la-to" type="date" value={to} min={from || undefined} onChange={(e) => set(setTo)(e.target.value)} className={`mt-1 block ${field}`} /></label>
            </>
          )}
          {filtering && <button type="button" onClick={clear} className="h-9 rounded-xl px-3 text-sm font-medium text-indigo-600 hover:bg-indigo-50">Clear filters</button>}
        </div>
      </section>

      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {data && !data.ready && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Login history is not switched on yet on this server. Ask an administrator to finish the database update.</p>}
      {!data && !error && <div className="skeleton h-48" aria-busy="true" />}

      {data?.ready && (
        <section className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]" aria-label="Login activity">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="bg-[#F3F7F6] text-xs text-slate-500">
                <tr>
                  {org && <th className="px-3 py-2 font-medium">Employee</th>}
                  <th className="px-3 py-2 font-medium">Login date &amp; time</th>
                  <th className="px-3 py-2 font-medium">IP address</th>
                  <th className="px-3 py-2 font-medium" title="Worked out from the IP address only. Not a verified physical location.">Approximate location</th>
                  <th className="px-3 py-2 font-medium">Device</th>
                  <th className="px-3 py-2 font-medium">Browser</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-indigo-50">
                {items.length === 0 && <tr><td colSpan={org ? 7 : 6} className="px-3 py-10 text-center text-sm text-slate-400">{filtering ? "Nothing matches these filters." : "No login activity yet."}</td></tr>}
                {items.map((it) => (
                  <tr key={it.id} data-testid="activity-row" tabIndex={0} role="button" aria-label={`Open details: ${it.employee?.name ?? it.username ?? "unknown"}, ${RESULT_LABEL[it.result]}`}
                    onClick={() => setOpen(it)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(it); } }}
                    className="cursor-pointer hover:bg-indigo-50/40 focus:bg-indigo-50/40 focus:outline-none">
                    {org && (
                      <td className="px-3 py-2.5 align-top">
                        <p className="font-medium text-slate-900">{it.employee?.name ?? it.username ?? "—"}</p>
                        <p className="text-xs text-slate-400">{it.employee ? `${it.employee.employeeCode ?? ""}${it.employee.company ? ` · ${it.employee.company}` : ""}` : "No matching account"}</p>
                      </td>
                    )}
                    <td className="whitespace-nowrap px-3 py-2.5 align-top tabular-nums text-slate-700">{when(it.at, tz)}</td>
                    <td className="px-3 py-2.5 align-top tabular-nums text-slate-700">{it.ip ?? "—"}</td>
                    <td className={`px-3 py-2.5 align-top ${it.location ? "text-slate-700" : "text-slate-400"}`}>{it.location ?? NOT_AVAILABLE}</td>
                    <td className="px-3 py-2.5 align-top text-slate-700">{it.deviceType ?? "—"}{it.os ? <span className="block text-xs text-slate-400">{it.os}</span> : null}</td>
                    <td className="px-3 py-2.5 align-top text-slate-700">{it.browser ?? "—"}</td>
                    <td className="px-3 py-2.5 align-top">
                      <StatusChip it={it} />
                      {it.result !== "SUCCESS" && it.reasonText && <span className="mt-0.5 block text-xs text-slate-400">{it.reasonText}</span>}
                      {org && it.flags && it.flags.filter((x) => x !== "BLOCKED" && x !== "OFF_NETWORK").length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">{it.flags.filter((x) => x !== "BLOCKED" && x !== "OFF_NETWORK").map((f) => <span key={f} title={FLAG_TEXT[f]} className="rounded-md bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-700">{FLAG_SHORT[f] ?? f}</span>)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-indigo-50 px-3 py-2 text-sm text-slate-600">
            <span aria-live="polite">{data.total === 0 ? "0 records" : `Showing ${(data.page - 1) * data.pageSize + 1}–${Math.min(data.total, data.page * data.pageSize)} of ${data.total}`}</span>
            <span className="flex flex-wrap items-center gap-2">
              <select aria-label="Rows per page" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className={field}>
                {[25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
              </select>
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-indigo-100 px-3 py-1 disabled:opacity-40">Previous</button>
              <button type="button" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-indigo-100 px-3 py-1 disabled:opacity-40">Next</button>
            </span>
          </div>
        </section>
      )}

      {!org && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900" data-testid="not-you-note">
          <b>Don&apos;t recognise a sign-in?</b> Someone else may be using your ID. <a href="/change-password" className="font-medium underline">Change your password now</a> and tell HR.
        </p>
      )}
      <p className="text-xs leading-relaxed text-slate-500">
        Approximate location is worked out from the IP address only; it is not a verified physical location. Browser, system and device are what the browser reported; they do not identify one particular computer.
      </p>

      {open && <DetailDialog item={open} org={org} tz={tz} onClose={() => setOpen(null)} />}
    </div>
  );
}

function DetailDialog({ item, org, tz, onClose }: { item: Item; org: boolean; tz: string; onClose: () => void }) {
  const [full, setFull] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!org) return; // the person's own rows already carry everything
    let live = true;
    apiGet<Detail>(`/login-activity/${item.id}`).then((d) => live && setFull(d)).catch((e: Error) => live && setErr(e.message));
    return () => { live = false; };
  }, [org, item.id]);
  const d: Item & Partial<Detail> = full ?? item;
  const rows: [string, React.ReactNode][] = [
    ["Employee", d.employee ? `${d.employee.name}${d.employee.employeeCode ? ` (${d.employee.employeeCode})` : ""}${d.employee.company ? ` · ${d.employee.company}` : ""}` : "No matching account"],
    ["Username typed", d.username ?? "—"],
    ["Date & time", `${when(d.at, tz)} (${tz})`],
    ["Result", <StatusChip key="s" it={d} />],
    ...(d.result !== "SUCCESS" ? ([["Reason", d.reasonText ?? "—"]] as [string, React.ReactNode][]) : []),
    ["IP address", d.ip ?? "—"],
    ["Approximate location", d.location ?? NOT_AVAILABLE],
    ["Device type", d.deviceType ?? "—"],
    ["Browser", d.browser ?? "—"],
    ["Operating system", d.os ?? "—"],
    ...(d.session ? ([
      ["Session", sessionLine(d.session, tz)],
      ["Last activity", when(d.session.lastActiveAt, tz)],
      ["Time signed in", dur(d.session.minutes) ?? "—"],
    ] as [string, React.ReactNode][]) : []),
    ...(org && full?.userAgent ? ([["Browser text (as sent)", <span key="ua" className="break-all text-xs text-slate-500">{full.userAgent}</span>]] as [string, React.ReactNode][]) : []),
    ...(org && full?.attemptsFromThisAddressWithin24Hours !== undefined ? ([["Attempts from this address within 24 hours", String(full.attemptsFromThisAddressWithin24Hours)]] as [string, React.ReactNode][]) : []),
  ];
  return (
    <Modal title="Login details" subtitle={d.employee?.name ?? d.username ?? undefined} onClose={onClose} width="max-w-xl">
      <div className="space-y-4" data-testid="activity-detail">
        {err && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}
        {org && d.flags && d.flags.length > 0 && (
          <div className="rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
            <p className="font-medium">Needs attention</p>
            <ul className="mt-1 list-disc pl-5">{d.flags.map((f) => <li key={f}>{FLAG_TEXT[f] ?? f}</li>)}</ul>
          </div>
        )}
        <dl className="divide-y divide-indigo-50 rounded-xl border border-indigo-100">
          {rows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-3 gap-3 px-3 py-2 text-sm">
              <dt className="text-slate-500">{k}</dt>
              <dd className="col-span-2 break-words text-slate-900">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="rounded-xl bg-[#F3F7F6] px-3 py-2 text-xs leading-relaxed text-slate-500">
          {full?.notes.location ?? "Location is approximate and comes from the IP address only. It is not a verified physical location."} {full?.notes.device ?? "Browser, system and device type are what the browser reported. They do not identify one particular computer."}
        </p>
      </div>
    </Modal>
  );
}
