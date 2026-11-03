"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { useMe } from "../layout";
import { Modal } from "../_employees/Modal";
import { useRealtime } from "@/lib/realtime";
import { HistoryModal, InviteResponse, JoinControl, ParticipationPanel, PastRecord, type TrackedFields } from "./_participation/Participation";
import HuddleOverview from "../_standup/HuddleOverview";
import { forTab, tabCounts, tabFromUrl, tabsFor, type TabKey } from "./tabs";

// ---------------------------------------------------------------------------
// TEAM HUDDLE (the Meetings page, one section for everything)
// Scheduled meetings with a link the organizer pastes (Google Meet, Teams, Zoom or any
// https link). Avatar HRMS does not create the meeting at those services.
// You see the meetings you organize or are invited to. HR/Admin also get an overview
// (title, organizer, time, head-count only) and can cancel a meeting.
// ---------------------------------------------------------------------------

type Person = { id: string; name: string; employeeCode: string | null };
type Meeting = TrackedFields & {
  id: string; title: string; description: string | null; startsAt: string; endsAt: string; state: "upcoming" | "ongoing" | "past" | "cancelled";
  status: string; cancelReason: string | null; organizer: string; organizerId: string; attendees: Person[]; meetingUrl: string | null;
  provider: string | null; isOrganizer: boolean; canEdit: boolean; canCancel: boolean; canEnd?: boolean;
};
type List = { timezone: string; canCreate: boolean; counts: { upcoming: number; past: number; cancelled: number }; meetings: Meeting[] };
type Oversight = { timezone: string; meetings: { id: string; title: string; startsAt: string; endsAt: string; status: string; organizer: string; attendeeCount: number; canCancel: boolean; participation?: { invited: number; joined: number } | null }[] };

const card = "rounded-2xl bg-white shadow-[var(--shadow-card)]";
const dayFmt = (s: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(new Date(s));
const timeFmt = (s: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(s));
const range = (m: { startsAt: string; endsAt: string }, tz: string) => `${timeFmt(m.startsAt, tz)} – ${timeFmt(m.endsAt, tz)}`;
const hhmm = (s: string, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(s));
const ymd = (s: string, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s));

function useApi<T>(path: string | null, reload: number) {
  const [res, setRes] = useState<{ path: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    apiGet<T>(path)
      .then((data) => live && setRes({ path, data }))
      .catch((e: Error) => live && setRes((prev) => ({ path, data: prev?.data, error: e.message })));
    return () => {
      live = false;
    };
  }, [path, reload]);
  return { data: res?.data ?? null, error: res && res.path === path ? (res.error ?? "") : "" };
}

function MeetingsInner() {
  const me = useMe();
  const isHr = me?.role === "HR" || me?.role === "ADMIN";
  const params = useSearchParams();
  const linked = params.get("id");
  // A link like /dashboard/meetings?tab=participation opens that tab (if this person has it). Clicking a tab wins until the link changes.
  const urlTab = tabFromUrl(params.get("tab"), me?.role);
  const [picked, setPicked] = useState<{ tab: TabKey; forUrl: TabKey | null } | null>(null);
  const tab: TabKey = picked && picked.forUrl === urlTab ? picked.tab : (urlTab ?? "upcoming");
  const setTab = (k: TabKey) => setPicked({ tab: k, forUrl: urlTab });
  const [historyKind, setHistoryKind] = useState<"past" | "cancelled">("past");
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  // A link like /dashboard/meetings?id=... (from a notification) opens that meeting, even if you are already on this page.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [closedLink, setClosedLink] = useState<string | null>(null);
  const openId = chosenId ?? (linked && linked !== closedLink ? linked : null);
  const setOpenId = (id: string | null) => {
    setChosenId(id);
    if (id === null) setClosedLink(linked);
  };
  const [editing, setEditing] = useState<Meeting | "new" | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  // Somebody joined or ended an in-person meeting, or a record was corrected: refresh by itself.
  useRealtime(["meetings:changed"], () => setReload((n) => n + 1));

  // Upcoming, Ongoing and Invitations are filters over the "upcoming" list the server already sends; History is the past (or cancelled) list.
  const noList = tab === "participation" || tab === "overview";
  const scope = tab === "history" ? historyKind : "upcoming";
  const list = useApi<List>(noList ? null : `/meetings?scope=${scope}${dq ? `&q=${encodeURIComponent(dq)}` : ""}`, reload);
  const counts = useApi<List>("/meetings?scope=upcoming", reload);
  const [overScope, setOverScope] = useState<"upcoming" | "past" | "cancelled">("upcoming");
  const over = useApi<Oversight>(tab === "overview" && isHr ? `/meetings/oversight?scope=${overScope}` : null, reload);
  const tz = list.data?.timezone ?? counts.data?.timezone ?? over.data?.timezone ?? "Asia/Kolkata";
  const c = counts.data?.counts;
  const tc = counts.data ? tabCounts(counts.data.meetings) : null;
  const tabLabels: Record<TabKey, string> = {
    upcoming: `Upcoming${tc ? ` (${tc.upcoming})` : ""}`,
    ongoing: `Ongoing${tc ? ` (${tc.ongoing})` : ""}`,
    invitations: `Invitations${tc ? ` (${tc.invitations})` : ""}`,
    history: `History${c ? ` (${c.past})` : ""}`,
    participation: "Participation",
    overview: "Company overview",
  };
  const tabs = tabsFor(me?.role).map((k) => [k, tabLabels[k]] as [TabKey, string]);
  const shown = list.data ? (tab === "history" ? list.data.meetings : forTab(list.data.meetings, tab)) : null;
  const canCreate = counts.data?.canCreate ?? false;

  return (
    <div className="page-fluid space-y-6 p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Team Huddle</h1>
          <p className="mt-1 text-sm text-slate-500">Meetings and huddles you organize or are invited to: invitations, joining, who attended and for how long.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setShowHistory(true)} className="rounded-xl border border-indigo-100 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50" title="Your record in in-person meetings">My participation history</button>
          {canCreate && <button onClick={() => setEditing("new")} className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">Schedule meeting</button>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => { setTab(k); setNotice(""); }} className={`rounded-xl px-4 py-2 text-sm font-medium ${tab === k ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-indigo-50"}`}>{label}</button>
        ))}
        {!noList && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title" aria-label="Search meetings" className="ml-auto w-56 rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm" />}
      </div>

      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

      {tab === "history" && (
        <div className="flex gap-2" role="group" aria-label="History filter">
          {([["past", "Completed"], ["cancelled", "Cancelled"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setHistoryKind(k)} aria-pressed={historyKind === k} className={`rounded-full px-3.5 py-1.5 text-xs font-medium ${historyKind === k ? "bg-indigo-100 text-indigo-700" : "bg-white text-slate-500 hover:bg-indigo-50"}`}>{label}{c ? ` (${k === "past" ? c.past : c.cancelled})` : ""}</button>
          ))}
        </div>
      )}

      {tab === "participation" && me?.role === "MANAGER" && <HuddleOverview />}

      {!noList && (
        <section className={`${card} p-5`}>
          {list.error && <p className="mb-3 flex items-center justify-between rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Couldn&apos;t load meetings: {list.error}<button onClick={() => setReload((n) => n + 1)} className="ml-3 rounded-lg bg-white px-3 py-1 text-xs font-medium ring-1 ring-red-200">Retry</button></p>}
          {!list.data && !list.error && <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-20" />)}</div>}
          {shown && shown.length === 0 && (
            <p className="rounded-xl bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">{dq ? "No meetings match your search." : tab === "upcoming" ? "No upcoming meetings." : tab === "ongoing" ? "Nothing is happening right now." : tab === "invitations" ? "No invitations waiting for your answer." : historyKind === "cancelled" ? "No cancelled meetings." : "No past meetings yet."}</p>
          )}
          <div className="divide-y divide-indigo-100">
            {shown?.map((m) => (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div className="flex min-w-0 items-center gap-4">
                  <div className="w-14 shrink-0 rounded-xl bg-indigo-50 py-2 text-center">
                    <p className="text-[11px] font-medium uppercase text-indigo-500">{new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short" }).format(new Date(m.startsAt))}</p>
                    <p className="text-lg font-semibold leading-none text-indigo-700">{new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "2-digit" }).format(new Date(m.startsAt))}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">
                      {m.title}
                      {m.state === "ongoing" && <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Happening now</span>}
                      {m.state === "cancelled" && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-600">Cancelled</span>}
                    </p>
                    <p className="text-sm text-slate-500">{dayFmt(m.startsAt, tz)} · {range(m, tz)}</p>
                    <p className="text-xs text-slate-400">{m.isOrganizer ? "You are organizing" : `Organized by ${m.organizer}`} · {m.attendees.length} invited{m.provider ? ` · ${m.provider}` : ""}{m.tracked ? " · in person" : ""}{m.tracked && m.isOrganizer ? ` · ${m.joinedCount ?? 0} of ${m.attendees.length} joined` : ""}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {m.meetingUrl && (m.state === "upcoming" || m.state === "ongoing") && (
                    <a href={m.meetingUrl} target="_blank" rel="noopener noreferrer" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Join meeting</a>
                  )}
                  {m.canEnd && <EndInline id={m.id} onDone={() => { setNotice("Meeting ended. It now shows under History."); setReload((n) => n + 1); }} />}
                  <button onClick={() => setOpenId(m.id)} className="rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Details</button>
                </div>
                {m.myStatus && m.state !== "cancelled" && m.state !== "past" && (
                  <div className="w-full">
                    <InviteResponse meetingId={m.id} f={m} compact onChanged={() => setReload((n) => n + 1)} />
                  </div>
                )}
                {m.tracked && m.state !== "cancelled" && (
                  <div className="w-full">
                    {m.state === "past" && m.me?.state !== "IN_MEETING" ? <PastRecord f={m} tz={tz} /> : <JoinControl meetingId={m.id} endsAt={m.endsAt} tz={tz} f={m} compact onChanged={() => setReload((n) => n + 1)} />}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === "overview" && isHr && (
        <section className={`${card} p-5`}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-slate-500">Every meeting in your company, with only the title, organizer, time and head-count. Descriptions, links and who is invited stay private to the organizer and attendees.</p>
            <select aria-label="Overview scope" value={overScope} onChange={(e) => setOverScope(e.target.value as typeof overScope)} className="rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm">
              <option value="upcoming">Upcoming</option><option value="past">Past</option><option value="cancelled">Cancelled</option>
            </select>
          </div>
          {over.error && <p className="mt-3 text-sm text-red-600">{over.error}</p>}
          {!over.data && !over.error && <div className="mt-4 space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-12" />)}</div>}
          {over.data && over.data.meetings.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">No meetings.</p>}
          {over.data && over.data.meetings.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead><tr className="text-xs text-slate-400"><th className="py-2 font-medium">Meeting</th><th className="py-2 font-medium">When</th><th className="py-2 font-medium">Organizer</th><th className="py-2 text-right font-medium">Invited</th><th className="py-2 text-right font-medium" title="In-person meetings: how many declared joining (counts only)">Joined</th><th className="py-2" /></tr></thead>
                <tbody className="divide-y divide-indigo-100">
                  {over.data.meetings.map((m) => (
                    <tr key={m.id}>
                      <td className="py-3 font-medium text-slate-900">{m.title}</td>
                      <td className="py-3 text-slate-600">{dayFmt(m.startsAt, tz)} · {range(m, tz)}</td>
                      <td className="py-3 text-slate-600">{m.organizer}</td>
                      <td className="py-3 text-right tabular-nums text-slate-600">{m.attendeeCount}</td>
                      <td className="py-3 text-right tabular-nums text-slate-600">{m.participation ? `${m.participation.joined} of ${m.participation.invited}` : "—"}</td>
                      <td className="py-3 text-right">{m.canCancel && <CancelInline id={m.id} onDone={() => { setNotice("Meeting cancelled. The people invited were notified."); setReload((n) => n + 1); }} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {showHistory && <HistoryModal onClose={() => setShowHistory(false)} />}
      {openId && <DetailsModal id={openId} tz={tz} onClose={() => setOpenId(null)} onEdit={(m) => { setOpenId(null); setEditing(m); }} onChanged={(t) => { setOpenId(null); setNotice(t); setReload((n) => n + 1); }} />}
      {editing && <EditModal meeting={editing === "new" ? null : editing} tz={tz} onClose={() => setEditing(null)} onDone={(t) => { setEditing(null); setNotice(t); setReload((n) => n + 1); }} />}
    </div>
  );
}

// Closes a meeting that is happening now for everyone (it moves to Past; people still in it are ended). Asks once, so a stray click does not end it.
function EndInline({ id, onDone }: { id: string; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!asking) return <button onClick={() => setAsking(true)} className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50">End meeting</button>;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      <span className="text-xs text-slate-500">End it now for everyone? Anyone still in the meeting is ended too.</span>
      <button disabled={busy} onClick={async () => { setBusy(true); setErr(""); try { await apiPost(`/meetings/${id}/end`); onDone(); } catch (e) { setErr((e as Error).message); setBusy(false); } }} className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">Yes, end</button>
      <button onClick={() => setAsking(false)} className="text-xs text-slate-500">Back</button>
      {err && <span className="w-full text-xs text-red-600">{err}</span>}
    </span>
  );
}

function CancelInline({ id, onDone }: { id: string; onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!asking) return <button onClick={() => setAsking(true)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">Cancel meeting</button>;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Reason (optional)" className="w-44 rounded-lg border border-indigo-100 px-2 py-1 text-xs" />
      <button disabled={busy} onClick={async () => { setBusy(true); setErr(""); try { await apiPost(`/meetings/${id}/cancel`, { reason }); onDone(); } catch (e) { setErr((e as Error).message); setBusy(false); } }} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">Confirm</button>
      <button onClick={() => setAsking(false)} className="text-xs text-slate-500">Back</button>
      {err && <span className="w-full text-xs text-red-600">{err}</span>}
    </span>
  );
}

function DetailsModal({ id, tz, onClose, onEdit, onChanged }: { id: string; tz: string; onClose: () => void; onEdit: (m: Meeting) => void; onChanged: (t: string) => void }) {
  const [rl, setRl] = useState(0);
  const { data: m, error } = useApi<Meeting & { timezone: string }>(`/meetings/${id}`, rl);
  useRealtime(["meetings:changed"], () => setRl((n) => n + 1));
  return (
    <Modal title={m?.title ?? "Meeting"} subtitle={m ? `${dayFmt(m.startsAt, tz)} · ${range(m, tz)}` : undefined} onClose={onClose} width={m?.tracked && m.isOrganizer ? "max-w-3xl" : "max-w-lg"}>
      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {!m && !error && <div className="skeleton h-32" aria-busy="true" />}
      {m && (
        <div className="space-y-4 text-sm">
          {m.state === "cancelled" && <p className="rounded-xl bg-red-50 px-4 py-3 text-red-700">This meeting was cancelled{m.cancelReason ? `: ${m.cancelReason}` : "."}</p>}
          <dl className="divide-y divide-indigo-100 rounded-2xl border border-indigo-100">
            <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-slate-500">Organizer</dt><dd className="font-medium text-slate-900">{m.organizer}</dd></div>
            {m.provider && <div className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-slate-500">Link</dt><dd className="font-medium text-slate-900">{m.provider}</dd></div>}
          </dl>
          {m.myStatus && m.state !== "cancelled" && m.state !== "past" && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Your invitation</p>
              <InviteResponse meetingId={m.id} f={m} onChanged={() => setRl((n) => n + 1)} />
            </div>
          )}
          {m.tracked && !m.isOrganizer && m.state !== "cancelled" && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Team Huddle</p>
              {m.state === "past" && m.me?.state !== "IN_MEETING" ? <PastRecord f={m} tz={tz} /> : <JoinControl meetingId={m.id} endsAt={m.endsAt} tz={tz} f={m} onChanged={() => setRl((n) => n + 1)} />}
            </div>
          )}
          {m.tracked && m.isOrganizer && m.state !== "cancelled" && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">You, as the organizer</p>
              {m.state === "past" && m.me?.state !== "IN_MEETING" ? <PastRecord f={m} tz={tz} /> : <JoinControl meetingId={m.id} endsAt={m.endsAt} tz={tz} f={m} onChanged={() => setRl((n) => n + 1)} />}
              <p className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-slate-400">Who joined (live)</p>
              <ParticipationPanel meetingId={m.id} />
            </div>
          )}
          {m.description && <div><p className="text-xs font-medium uppercase tracking-wide text-slate-400">{m.tracked ? "Agenda" : "About"}</p><p className="mt-1 whitespace-pre-wrap text-slate-700">{m.description}</p></div>}
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Invited ({m.attendees.length})</p>
            <div className="mt-1 flex flex-wrap gap-1.5">{m.attendees.map((a) => <span key={a.id} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">{a.name}</span>)}</div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {m.canEdit && <button onClick={() => onEdit(m)} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Edit</button>}
            {m.canEnd && <EndInline id={m.id} onDone={() => onChanged("Meeting ended. It now shows under Past.")} />}
            {m.canCancel && !m.canEnd && <CancelInline id={m.id} onDone={() => onChanged("Meeting cancelled. The people invited were notified.")} />}
            {m.meetingUrl && (m.state === "upcoming" || m.state === "ongoing") && <a href={m.meetingUrl} target="_blank" rel="noopener noreferrer" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700">Join meeting</a>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function EditModal({ meeting, tz, onClose, onDone }: { meeting: Meeting | null; tz: string; onClose: () => void; onDone: (t: string) => void }) {
  const people = useApi<{ people: (Person & { designation: string | null })[] }>("/meetings/people", 0);
  const [title, setTitle] = useState(meeting?.title ?? "");
  const [description, setDescription] = useState(meeting?.description ?? "");
  const [date, setDate] = useState(meeting ? ymd(meeting.startsAt, tz) : "");
  const [start, setStart] = useState(meeting ? hhmm(meeting.startsAt, tz) : "10:00");
  const [end, setEnd] = useState(meeting ? hhmm(meeting.endsAt, tz) : "11:00");
  const [url, setUrl] = useState(meeting?.meetingUrl ?? "");
  // An in-person stand-up: no link; people press "Join Huddle". Chosen when scheduling and not changed afterwards.
  const [inPerson, setInPerson] = useState(false);
  const [lateAfter, setLateAfter] = useState("5");
  const inPersonOn = meeting?.tracked ? true : inPerson;
  const [picked, setPicked] = useState<string[]>(meeting?.attendees.map((a) => a.id) ?? []);
  const [find, setFind] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [oneToOne, setOneToOne] = useState(false); // one-to-one = exactly one person
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const all = people.data?.people ?? [];
  const needle = find.trim().toLowerCase();
  const shown = all
    .filter((p) => !picked.includes(p.id) && (!needle || p.name.toLowerCase().includes(needle) || (p.employeeCode ?? "").toLowerCase().includes(needle) || (p.designation ?? "").toLowerCase().includes(needle)))
    .slice(0, 50);
  const choose = (id: string) => {
    setPicked((s) => (oneToOne ? [id] : s.includes(id) ? s : [...s, id]));
    setFind("");
    setListOpen(oneToOne ? false : true);
  };
  const remove = (id: string) => setPicked((s) => s.filter((x) => x !== id));
  const setMode = (one: boolean) => {
    setOneToOne(one);
    if (one) setPicked((s) => s.slice(0, 1)); // switching to one-to-one keeps only the first person
  };
  const nameOf = (id: string) => all.find((p) => p.id === id)?.name ?? meeting?.attendees.find((a) => a.id === id)?.name ?? "Unknown";
  const lateOk = !inPerson || (/^\d+$/.test(lateAfter) && Number(lateAfter) <= 120);
  const invalid = title.trim().length < 2 || !date || !start || !end || end <= start || picked.length === 0 || !lateOk;

  async function save() {
    if (busy || invalid) return;
    setBusy(true);
    setError("");
    const body = { title, description, date, startTime: start, endTime: end, meetingUrl: inPersonOn ? "" : url, attendeeIds: picked, ...(!meeting?.tracked && inPerson ? { inPerson: true, lateAfterMinutes: Number(lateAfter) } : {}) };
    try {
      if (meeting) await apiPatch(`/meetings/${meeting.id}`, body);
      else await apiPost("/meetings", body);
      onDone(meeting ? "Meeting updated. The people invited were notified." : "Meeting scheduled. The people invited were notified.");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const input = "mt-1 w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800";
  return (
    <Modal title={meeting ? "Edit meeting" : "New meeting"} subtitle={inPersonOn ? "A face-to-face meeting. Invited people press “Join Huddle” when they are in the room, and you see who joined." : "Paste an existing Google Meet, Teams or Zoom link. Avatar HRMS does not create the meeting for you."} onClose={onClose} width="max-w-xl"
      footer={<div className="flex justify-end gap-2"><button onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Close</button><button disabled={busy || invalid} onClick={save} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? "Saving…" : meeting ? "Save changes" : "Schedule"}</button></div>}>
      <div className="space-y-4">
        {!meeting?.tracked && (
          <div className="rounded-xl bg-[#F6F7FE] p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input type="checkbox" checked={inPerson} onChange={(e) => setInPerson(e.target.checked)} /> In-person stand-up (track who joins)
            </label>
            {inPerson && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <span>Counts as late when someone joins more than</span>
                <input value={lateAfter} onChange={(e) => setLateAfter(e.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" aria-label="Late after minutes" className="w-16 rounded-lg border border-indigo-100 bg-white px-2 py-1 text-center text-sm" />
                <span>minutes after the start.</span>
                {!lateOk && <span className="w-full text-xs text-red-600">Enter 0 to 120.</span>}
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">Self-reported: people declare when they join and leave. It doesn&apos;t prove presence and it is separate from attendance and working hours.{meeting ? " Turning this on removes the link, tells the invited people, and can't be switched off again." : ""}</p>
          </div>
        )}
        {meeting?.tracked && <p className="rounded-xl bg-[#F6F7FE] px-3 py-2 text-xs text-slate-600">In-person stand-up. Participation is tracked; this can&apos;t be switched off after scheduling.</p>}
        <label className="block text-sm text-slate-600">Title<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} className={input} /></label>
        <label className="block text-sm text-slate-600">{inPersonOn ? "Agenda (optional)" : "Description (optional)"}<textarea value={description} maxLength={1000} rows={2} onChange={(e) => setDescription(e.target.value)} className={input} /></label>
        <div className="grid grid-cols-3 gap-3">
          <label className="block text-sm text-slate-600">Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} /></label>
          <label className="block text-sm text-slate-600">Starts<input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={input} /></label>
          <label className="block text-sm text-slate-600">Ends<input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={input} /></label>
        </div>
        <p className="-mt-2 text-xs text-slate-400">Times are in your company&apos;s timezone ({tz}).</p>
        {!inPersonOn && <label className="block text-sm text-slate-600">Meeting link (optional)<input value={url} maxLength={500} onChange={(e) => setUrl(e.target.value)} placeholder="https://meet.google.com/..." className={input} /></label>}
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-slate-600">{oneToOne ? "Meet with" : "Invite people"} <span className="text-slate-400">({picked.length} chosen)</span></p>
            <div role="group" aria-label="Meeting type" className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs">
              <button type="button" onClick={() => setMode(false)} aria-pressed={!oneToOne} className={"rounded-md px-3 py-1 font-medium " + (!oneToOne ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500")}>Group</button>
              <button type="button" onClick={() => setMode(true)} aria-pressed={oneToOne} className={"rounded-md px-3 py-1 font-medium " + (oneToOne ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500")}>One-to-one</button>
            </div>
          </div>
          {picked.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {picked.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-1 pl-2.5 pr-1 text-xs text-indigo-700">
                  {nameOf(id)}
                  <button type="button" onClick={() => remove(id)} aria-label={`Remove ${nameOf(id)}`} className="rounded-full p-0.5 hover:bg-indigo-100">
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="m5 5 10 10M15 5 5 15" /></svg>
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="relative">
            <input
              value={find}
              onChange={(e) => { setFind(e.target.value); setListOpen(true); }}
              onFocus={() => setListOpen(true)}
              onBlur={() => setListOpen(false)}
              placeholder={oneToOne ? "Search and pick one person" : "Search name, ID or role to add people"}
              role="combobox"
              aria-expanded={listOpen}
              aria-controls="meeting-people"
              autoComplete="off"
              className={input}
            />
            {listOpen && (
              <ul id="meeting-people" role="listbox" className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-xl bg-white py-1 shadow-[var(--shadow-lift)] ring-1 ring-indigo-100">
                {!people.data && !people.error && <li className="px-3 py-3 text-sm text-slate-400">Loading people…</li>}
                {people.error && <li className="px-3 py-3 text-sm text-red-600">{people.error}</li>}
                {people.data && shown.length === 0 && <li className="px-3 py-3 text-sm text-slate-400">{needle ? "No one matches that." : "Everyone available is already chosen."}</li>}
                {shown.map((p) => (
                  <li key={p.id} role="option" aria-selected={false}>
                    {/* mouse-down (not click) so the input does not lose focus and close the list first */}
                    <button type="button" onMouseDown={(e) => { e.preventDefault(); choose(p.id); }} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-indigo-50">
                      <span className="text-slate-800">{p.name}</span>
                      <span className="shrink-0 text-xs text-slate-400">{p.employeeCode}{p.designation ? ` · ${p.designation}` : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

export default function MeetingsPage() {
  return (
    <Suspense fallback={null}>
      <MeetingsInner />
    </Suspense>
  );
}
