"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useMe } from "../layout";
import ImportWizard from "./_hol/ImportWizard";
import EntryModal from "./_hol/EntryModal";
import YearCalendar, { Legend } from "./_hol/YearCalendar";
import { Approvals, MyOptional } from "./_hol/Requests";
import { KIND_LABEL, STATUS_LABEL, codeOf, msg, pretty, type CalendarData, type Entry } from "./_hol/model";

type Upcoming = { today: string; allowance: number; holidays: { id: string; date: string; name: string; kind: "FIXED" | "OPTIONAL"; religion: string | null; weekday: string; daysAway: number; myRequest: string | null }[]; teamAway: { date: string; holiday: string; people: string[] }[] };
type Policy = { canEdit: boolean; companies: { id: string; name: string; optionalAllowance: number; isDefault: boolean }[] };

const card = "rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]";
const btn = "h-10 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50";
const ghost = "h-10 rounded-xl border border-indigo-100 px-4 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50";

export default function HolidaysPage() {
  const me = useMe();
  const role = me?.role ?? "EMPLOYEE";
  const manage = role === "HR" || role === "ADMIN";

  const tabs = manage ? ["Calendar", "List", "Optional requests", "Imports & settings"] : role === "MANAGER" ? ["Calendar", "My optional holidays", "Team requests"] : ["Calendar", "My optional holidays"];
  const [tab, setTab] = useState(() => {
    if (typeof window === "undefined") return "Calendar";
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "requests" ? (manage ? "Optional requests" : role === "MANAGER" ? "Team requests" : "My optional holidays") : "Calendar";
  });
  const [year, setYear] = useState<number | null>(null);
  const [company, setCompany] = useState("all");
  const [data, setData] = useState<CalendarData | null>(null);
  const [upcoming, setUpcoming] = useState<Upcoming | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<Entry | "new" | null>(null);

  const load = useCallback(async (y?: number | null, c?: string) => {
    try {
      const qs = new URLSearchParams();
      if (y) qs.set("year", String(y));
      if ((c ?? company) !== "all") qs.set("companyId", c ?? company);
      const d = await apiGet<CalendarData>(`/holiday-calendar/calendar?${qs}`);
      setData(d); setYear(d.year); setError("");
    } catch (e) { setError(msg(e)); }
  }, [company]);
  useEffect(() => { load(); apiGet<Upcoming>("/holiday-calendar/upcoming").then(setUpcoming).catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const reload = () => { load(year); apiGet<Upcoming>("/holiday-calendar/upcoming").then(setUpcoming).catch(() => {}); };
  const say = (m: string) => { setNotice(m); setError(""); };

  const shown = useMemo(() => (data ? [...data.holidays, ...data.drafts] : []), [data]);
  const drafts = data?.drafts ?? [];
  const draftImport = drafts[0]?.importId ?? null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{manage ? "Holiday Management" : "Holidays"}</h1>
          <p className="text-sm text-slate-500">{manage ? "Upload, review and publish the company holiday calendar." : "Company holidays and optional holiday requests."}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="hol-year">Year</label>
          <select id="hol-year" value={year ?? ""} onChange={(e) => { setYear(Number(e.target.value)); load(Number(e.target.value)); }} className="h-10 rounded-xl border border-indigo-100 bg-white px-3 text-sm">
            {(data?.years ?? []).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          {manage && (data?.companies.length ?? 0) > 1 && (
            <select aria-label="Company" value={company} onChange={(e) => { setCompany(e.target.value); load(year, e.target.value); }} className="h-10 rounded-xl border border-indigo-100 bg-white px-3 text-sm">
              <option value="all">All my companies</option>
              {data!.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {manage && <button type="button" onClick={() => setImporting(true)} className={btn} disabled={!data?.ready}>Upload holiday sheet</button>}
          {manage && <button type="button" onClick={() => setEditing("new")} className={ghost}>Add holiday</button>}
        </div>
      </div>

      {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {notice && <p role="status" className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {data && !data.ready && manage && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">Uploading and publishing sheets is not switched on yet (a database update is pending). You can still add holidays by hand.</p>}

      <div role="tablist" aria-label="Holiday sections" className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`h-9 rounded-full border px-4 text-sm font-medium ${tab === t ? "border-indigo-600 bg-indigo-600 text-white" : "border-indigo-100 bg-white text-slate-600 hover:bg-indigo-50"}`}>{t}</button>
        ))}
      </div>

      {!data ? <p className="text-sm text-slate-500">Loading…</p> : (
        <>
          {tab === "Calendar" && (
            <div className="space-y-5">
              {manage && drafts.length > 0 && draftImport && <DraftBar count={drafts.length} year={data.year} importId={draftImport} onDone={(m) => { say(m); reload(); }} onError={setError} />}
              <section className={card} aria-label="Upcoming holidays">
                <h2 className="mb-2 text-base font-semibold text-slate-900">Upcoming holidays</h2>
                {upcoming && upcoming.holidays.length > 0 ? (
                  <ul className="divide-y divide-indigo-50" data-testid="upcoming">
                    {upcoming.holidays.slice(0, 6).map((h) => (
                      <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span className="text-sm text-slate-900">{h.name} <span className="text-xs text-slate-500">· {pretty(h.date)} · {h.weekday}</span></span>
                        <span className="flex items-center gap-2 text-xs">
                          <span className={`rounded-md px-2 py-0.5 font-medium ${h.kind === "FIXED" ? "bg-indigo-50 text-indigo-700" : "bg-amber-50 text-amber-700"}`}>{KIND_LABEL[h.kind]}</span>
                          <span className="text-slate-500">{h.daysAway === 0 ? "today" : h.daysAway === 1 ? "tomorrow" : `in ${h.daysAway} days`}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-slate-500">No published holidays in the next 90 days.</p>}
                {upcoming && upcoming.teamAway.length > 0 && (
                  <div className="mt-3 border-t border-indigo-50 pt-3">
                    <h3 className="text-sm font-semibold text-slate-900">Team availability</h3>
                    <ul className="mt-1 space-y-1 text-sm text-slate-600">{upcoming.teamAway.map((a) => <li key={a.date + a.holiday}>{pretty(a.date)} · {a.holiday}: {a.people.join(", ")} away</li>)}</ul>
                  </div>
                )}
              </section>
              <div className="flex flex-wrap items-center justify-between gap-2"><Legend /><span className="text-xs text-slate-500">{data.holidays.length} published{manage ? ` · ${drafts.length} draft` : ""}</span></div>
              <YearCalendar year={data.year} entries={shown} today={data.today} onPick={manage ? (e) => e.status === "PUBLISHED" && setEditing(e) : undefined} />
            </div>
          )}

          {tab === "List" && manage && <ListTab data={data} onEdit={setEditing} onChanged={(m) => { say(m); reload(); }} onError={setError} />}
          {tab === "Optional requests" && manage && <Approvals role={role} setNotice={say} onChange={reload} />}
          {tab === "Team requests" && <Approvals role={role} setNotice={say} onChange={reload} />}
          {tab === "My optional holidays" && <MyOptional data={data} reload={reload} setNotice={say} />}
          {tab === "Imports & settings" && manage && <SettingsTab data={data} />}
        </>
      )}

      {importing && data && <ImportWizard year={data.year} companies={data.companies} companyId={company !== "all" ? company : ""} onClose={() => setImporting(false)} onDone={(m) => { setImporting(false); say(m); setTab("Calendar"); reload(); }} />}
      {editing && data && <EntryModal entry={editing === "new" ? null : editing} companies={data.companies} today={data.today} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); say(m); reload(); }} />}
    </div>
  );
}

function DraftBar({ count, year, importId, onDone, onError }: { count: number; year: number; importId: string; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [past, setPast] = useState<number | null>(null);
  const [confirmPast, setConfirmPast] = useState(false);
  const [busy, setBusy] = useState(false);
  async function publish() {
    setBusy(true);
    try {
      const r = await apiPost<{ published: number; skipped: number }>(`/holiday-calendar/import/${importId}/publish`, { confirm: true, confirmPast });
      setOpen(false); onDone(`Published ${r.published} holiday(s)${r.skipped ? ` (${r.skipped} already existed)` : ""}. Employees were notified.`);
    } catch (e) {
      if (codeOf(e) === "PAST_CONFIRM_REQUIRED") setPast(((e as { data?: { count?: number } }).data?.count) ?? 1);
      onError(msg(e));
    } finally { setBusy(false); }
  }
  async function discard() {
    if (!window.confirm("Discard this draft calendar? Nothing published is affected.")) return;
    try { await apiPost(`/holiday-calendar/import/${importId}/discard`); onDone("Draft discarded."); } catch (e) { onError(msg(e)); }
  }
  return (
    <section className="rounded-2xl border border-dashed border-indigo-300 bg-indigo-50 p-4" aria-label="Draft calendar" data-testid="draft-bar">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-sm font-semibold text-slate-900">Draft calendar for {year}: {count} holiday(s), not yet visible to employees</p><p className="text-xs text-slate-600">Check the dashed dates below, then publish. Drafts do not affect attendance, leave or reports.</p></div>
        <div className="flex gap-2"><button type="button" onClick={discard} className={ghost}>Discard draft</button><button type="button" onClick={() => setOpen(true)} className={btn}>Publish calendar</button></div>
      </div>
      {open && (
        <div className="mt-3 space-y-2 rounded-xl bg-white p-3">
          <p className="text-sm text-slate-700">Publishing adds these holidays to the company calendar and notifies employees. Existing holidays are never replaced or deleted.</p>
          {past !== null && <label className="flex items-start gap-2 text-sm text-amber-800"><input type="checkbox" checked={confirmPast} onChange={(e) => setConfirmPast(e.target.checked)} className="mt-0.5" /> {past} date(s) are in the past. Reports for those days will change (they stop counting as working days).</label>}
          <div className="flex gap-2"><button type="button" onClick={() => setOpen(false)} className={ghost}>Not yet</button><button type="button" disabled={busy || (past !== null && !confirmPast)} onClick={publish} className={btn}>{busy ? "Publishing…" : "Yes, publish"}</button></div>
        </div>
      )}
    </section>
  );
}

function ListTab({ data, onEdit, onChanged, onError }: { data: CalendarData; onEdit: (e: Entry) => void; onChanged: (m: string) => void; onError: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const all = useMemo(() => [...data.holidays, ...data.drafts, ...data.archived].sort((a, b) => a.date.localeCompare(b.date)), [data]);
  const rows = all.filter((e) => (type === "all" || e.kind === type) && (status === "all" || e.status === status) && (!q || `${e.name} ${e.religion ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  async function act(path: string, ok: string) { try { await apiPost(path); onChanged(ok); } catch (e) { onError(msg(e)); } }
  const sel = "h-10 rounded-xl border border-indigo-100 bg-white px-3 text-sm";
  return (
    <section className={card} aria-label="Holiday list">
      <div className="mb-3 flex flex-wrap gap-2">
        <input aria-label="Search holidays" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or category" className={`${sel} w-56`} />
        <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} className={sel}><option value="all">All types</option><option value="FIXED">Fixed</option><option value="OPTIONAL">Optional</option></select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className={sel}><option value="all">All statuses</option><option value="PUBLISHED">Published</option><option value="DRAFT">Draft</option><option value="ARCHIVED">Archived</option></select>
        <span className="self-center text-xs text-slate-500">{rows.length} of {all.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Day</th><th className="py-2 pr-3">Holiday</th><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Religion / category</th><th className="py-2 pr-3">Company</th><th className="py-2 pr-3">Status</th><th className="py-2">Actions</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-slate-500">No holidays match.</td></tr>}
            {rows.map((e) => (
              <tr key={`${e.status}-${e.id}`} className="border-t border-indigo-50">
                <td className="py-2 pr-3">{pretty(e.date)}</td><td className="py-2 pr-3">{e.weekday}</td><td className="py-2 pr-3 font-medium text-slate-900">{e.name}</td>
                <td className="py-2 pr-3"><span className={`rounded-md px-2 py-0.5 text-xs font-medium ${e.kind === "FIXED" ? "bg-indigo-50 text-indigo-700" : "bg-amber-50 text-amber-700"}`}>{KIND_LABEL[e.kind]}</span></td>
                <td className="py-2 pr-3">{e.religion || "—"}</td><td className="py-2 pr-3">{e.company}</td>
                <td className="py-2 pr-3"><span className={`rounded-md px-2 py-0.5 text-xs font-medium ${e.status === "PUBLISHED" ? "bg-emerald-50 text-emerald-700" : e.status === "DRAFT" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"}`}>{STATUS_LABEL[e.status]}</span></td>
                <td className="py-2">
                  {e.status === "PUBLISHED" && !e.isPast && (
                    <span className="flex gap-2">
                      <button type="button" onClick={() => onEdit(e)} className="text-xs font-medium text-indigo-700 hover:underline">Edit</button>
                      <button type="button" onClick={() => window.confirm(`Deactivate ${e.name}? It stops counting everywhere and can be restored.`) && act(`/holiday-calendar/entry/${e.id}/archive`, "Holiday deactivated.")} className="text-xs font-medium text-rose-700 hover:underline">Deactivate</button>
                    </span>
                  )}
                  {e.status === "PUBLISHED" && e.isPast && <button type="button" onClick={() => onEdit(e)} className="text-xs font-medium text-indigo-700 hover:underline">Edit category</button>}
                  {e.status === "ARCHIVED" && <button type="button" onClick={() => act(`/holiday-calendar/archive/${e.id}/restore`, "Holiday restored.")} className="text-xs font-medium text-indigo-700 hover:underline">Restore</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SettingsTab({ data }: { data: CalendarData }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [msgText, setMsgText] = useState("");
  const load = () => apiGet<Policy>("/holiday-calendar/policy").then((p) => { setPolicy(p); setVals(Object.fromEntries(p.companies.map((c) => [c.id, String(c.optionalAllowance)]))); }).catch((e) => setMsgText(msg(e)));
  useEffect(() => { load(); }, []);
  async function save(id: string) { try { await apiPost("/holiday-calendar/policy", { companyId: id, optionalAllowance: Number(vals[id]) }); setMsgText("Allowance saved."); load(); } catch (e) { setMsgText(msg(e)); } }
  return (
    <div className="space-y-5">
      <section className={card} aria-label="Optional holiday allowance">
        <h2 className="text-base font-semibold text-slate-900">Optional holiday allowance</h2>
        <p className="mb-3 text-xs text-slate-500">How many optional holidays each person may take a year. {policy?.canEdit ? "" : "Only an Admin can change it."}</p>
        {msgText && <p role="status" className="mb-2 text-sm text-slate-700">{msgText}</p>}
        <ul className="space-y-2">
          {policy?.companies.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 text-sm"><span className="w-56 text-slate-800">{c.name}</span>
              <input type="number" min={0} max={30} aria-label={`Allowance for ${c.name}`} disabled={!policy.canEdit} value={vals[c.id] ?? ""} onChange={(e) => setVals({ ...vals, [c.id]: e.target.value })} className="h-9 w-20 rounded-lg border border-indigo-100 px-2" />
              {policy.canEdit && <button type="button" onClick={() => save(c.id)} className={ghost}>Save</button>}{c.isDefault && <span className="text-xs text-slate-500">default</span>}
            </li>
          ))}
        </ul>
      </section>
      <section className={card} aria-label="Import history">
        <h2 className="mb-2 text-base font-semibold text-slate-900">Import history · {data.year}</h2>
        {data.imports.length === 0 ? <p className="text-sm text-slate-500">No sheets uploaded for this year.</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm">
            <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-3">File</th><th className="py-2 pr-3">Uploaded</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Rows</th><th className="py-2 pr-3">Imported</th><th className="py-2 pr-3">Skipped</th><th className="py-2">Failed</th></tr></thead>
            <tbody>{data.imports.map((i) => <tr key={i.id} className="border-t border-indigo-50"><td className="py-2 pr-3">{i.fileName}</td><td className="py-2 pr-3">{new Date(i.createdAt).toLocaleString()}</td><td className="py-2 pr-3">{i.status === "DRAFT" ? "Draft" : i.status === "PUBLISHED" ? "Published" : "Discarded"}</td><td className="py-2 pr-3">{i.totalRows}</td><td className="py-2 pr-3">{i.importedRows}</td><td className="py-2 pr-3">{i.skippedRows}</td><td className="py-2">{i.failedRows}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
