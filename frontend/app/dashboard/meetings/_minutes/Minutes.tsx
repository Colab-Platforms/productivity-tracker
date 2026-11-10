"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost, apiPostFile, apiPut } from "@/lib/api";

// ---------------------------------------------------------------------------
// MEETING MINUTES (MOM), shown inside the meeting's details.
// Organizer: Record (or upload a recording) -> the app drafts the minutes -> he checks and publishes. Nothing is published by itself.
// Invitees: read the minutes once they are published. The recording is never stored; the transcript is deleted when the minutes are published.
// ---------------------------------------------------------------------------

type Item = { task: string; owner: string | null; due: string | null };
type Topic = { topic: string; points: string[] };
type Header = { title: string; company: string | null; startsAt: string; endsAt: string; timezone: string; mode: string; provider: string | null; preparedBy: string; notJoined: string[] };
type Minutes = {
  id: string; status: "DRAFT" | "PUBLISHED"; version: number; summary: string; agenda: string[]; discussion: Topic[]; nextMeeting: string | null; decisions: string[]; actionItems: Item[];
  attendees: string[]; attendeeBasis: "JOINED" | "INVITED"; language: string | null; publishedAt: string | null; transcript?: string | null;
};
type Res = { ready: boolean; configured: boolean; canEdit: boolean; minutes: Minutes | null; header?: Header | null };

const MAX_RECORD_SECONDS = 110 * 60; // stays under the upload limit at the low bitrate used
const LANGS: [string, string][] = [["", "Detect automatically"], ["mr", "Marathi"], ["hi", "Hindi"], ["en", "English"]];
const pickMime = () => {
  if (typeof MediaRecorder === "undefined") return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
};
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const btn = "rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-50";
const primary = `${btn} bg-indigo-600 text-white hover:bg-indigo-700`;
const ghost = `${btn} border border-indigo-100 text-slate-700 hover:bg-slate-50`;

export default function MinutesSection({ meetingId, state, isOrganizer, tz }: { meetingId: string; state: string; isOrganizer: boolean; tz: string }) {
  const [res, setRes] = useState<Res | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState(false);
  const [lang, setLang] = useState("");
  const [output, setOutput] = useState<"english" | "original">("english");
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; mime: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setRes(await apiGet<Res>(`/meetings/${meetingId}/minutes`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [meetingId]);
  useEffect(() => {
    void load();
  }, [load]);

  // never leave the microphone on if the dialog closes mid-recording
  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    rec.current?.stream.getTracks().forEach((t) => t.stop());
  }, []);
  useEffect(() => () => {
    release();
    if (rec.current?.mr.state === "recording") rec.current.mr.stop();
  }, [release]);
  useEffect(() => {
    if (!recording) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recording]);

  const query = () => `?${new URLSearchParams({ ...(lang ? { language: lang } : {}), output }).toString()}`;

  async function upload(blob: Blob, mime: string) {
    setBusy("Making the minutes from the recording. This can take a minute…");
    setError("");
    try {
      await apiPostFile(`/meetings/${meetingId}/minutes/audio${query()}`, blob, mime || "audio/webm");
      setNotice("Draft ready. Check it, correct anything wrong, then publish.");
      setEditing(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function start() {
    setError("");
    setNotice("");
    const mime = pickMime();
    if (!navigator.mediaDevices?.getUserMedia || !mime) {
      setError("This browser can't record audio. Use Chrome or Edge, or upload a recording instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      // the people invited are told BEFORE anything is captured
      await apiPost(`/meetings/${meetingId}/minutes/recording`);
      const mr = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 24000 });
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      mr.start(5000);
      rec.current = { mr, stream, chunks, mime };
      setSecs(0);
      setRecording(true);
      timer.current = setInterval(() => setSecs((s) => s + 1), 1000);
    } catch (e) {
      const m = (e as Error).message;
      setError(/denied|permission|notallowed/i.test(m) ? "The microphone is blocked. Allow it in the browser's address bar and try again." : m);
    }
  }

  function stop() {
    const r = rec.current;
    if (!r) return;
    r.mr.onstop = () => {
      release();
      setRecording(false);
      const blob = new Blob(r.chunks, { type: r.mime.split(";")[0] });
      rec.current = null;
      void upload(blob, r.mime.split(";")[0]);
    };
    r.mr.stop();
  }
  useEffect(() => {
    if (recording && secs >= MAX_RECORD_SECONDS) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secs, recording]);

  async function publish() {
    if (!confirm("Publish these minutes? Everyone invited can read them, and the transcript is deleted.")) return;
    setBusy("Publishing…");
    setError("");
    try {
      await apiPost(`/meetings/${meetingId}/minutes/publish`);
      setNotice("Published. The people invited have been told.");
      setEditing(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (!res) return error ? <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null;
  if (!res.ready) return isOrganizer && state !== "upcoming" ? <Box><p className="text-sm text-slate-500">Meeting minutes are not switched on for this system yet.</p></Box> : null;
  // upcoming or cancelled meetings have no minutes; invitees see the section only once minutes are published
  if (state === "upcoming" || state === "cancelled") return null;
  if (!isOrganizer && !res.minutes) return null;

  const m = res.minutes;
  return (
    <Box>
      {error && <p className="mb-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="mb-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}
      {busy && <p aria-busy="true" className="mb-3 rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-700">{busy}</p>}

      {m && !editing && <Read m={m} h={res.header ?? null} tz={tz} />}
      {m && editing && isOrganizer && <Editor meetingId={meetingId} m={m} onSaved={async (t) => { setNotice(t); await load(); }} onClose={() => setEditing(false)} onPublish={publish} disabled={!!busy} setError={setError} />}

      {isOrganizer && res.canEdit && !editing && !recording && !busy && (
        <div className="mt-3 space-y-3">
          {m?.status === "DRAFT" && (
            <div className="flex flex-wrap gap-2">
              <button className={primary} onClick={() => setEditing(true)}>Review draft</button>
              <button className={ghost} onClick={publish}>Publish as is</button>
            </div>
          )}
          {m?.status === "PUBLISHED" && <button className={ghost} onClick={() => setEditing(true)}>Edit minutes</button>}
          {m?.status !== "PUBLISHED" && (
            <>
              {!res.configured && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">Automatic minutes need a speech service key (set by your administrator). Until then you can write the minutes by hand.</p>}
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs text-slate-500">
                  Language spoken
                  <select value={lang} onChange={(e) => setLang(e.target.value)} className="mt-1 block rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800">
                    {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
                <label className="text-xs text-slate-500">
                  Write the minutes in
                  <select value={output} onChange={(e) => setOutput(e.target.value as "english" | "original")} className="mt-1 block rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800">
                    <option value="english">English</option>
                    <option value="original">The language spoken</option>
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className={primary} disabled={!res.configured} onClick={start}>● Record the meeting</button>
                <label className={`${ghost} cursor-pointer ${res.configured ? "" : "pointer-events-none opacity-50"}`}>
                  Upload a recording
                  <input type="file" accept="audio/*" className="sr-only" disabled={!res.configured} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f, f.type); }} />
                </label>
                {!m && <button className={ghost} onClick={() => setEditing(true)}>Write by hand</button>}
              </div>
              <p className="text-xs text-slate-400">The people invited are told before recording starts. The recording is not kept; only the minutes you publish are.</p>
            </>
          )}
        </div>
      )}

      {recording && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-red-50 px-4 py-3">
          <span className="flex items-center gap-2 text-sm font-medium text-red-700"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-600" />Recording {clock(secs)}</span>
          <button className={`${btn} bg-red-600 text-white hover:bg-red-700`} onClick={stop}>Stop and make minutes</button>
          <span className="text-xs text-red-700/80">Keep this window open while recording.</span>
        </div>
      )}
    </Box>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Minutes of meeting</p>
      <div className="rounded-2xl border border-indigo-100 p-4">{children}</div>
    </div>
  );
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const fmtDate = (s: string, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(new Date(s));
const fmtTime = (s: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(s));

/** The facts at the top: from the system (meeting record and join records), never from the AI. */
function factsOf(m: Minutes, h: Header | null, tz: string): [string, string][] {
  if (!h) return [];
  const zone = h.timezone || tz;
  const rows: [string, string][] = [
    ["Date", fmtDate(h.startsAt, zone)],
    ["Time", `${fmtTime(h.startsAt, zone)} to ${fmtTime(h.endsAt, zone)}`],
    ["Mode", h.mode + (h.provider ? ` (${h.provider})` : "")],
    ["Prepared by", h.preparedBy],
    [m.attendeeBasis === "JOINED" ? "Present" : "Invited", m.attendees.join(", ") || "-"],
  ];
  if (h.notJoined.length) rows.push(["Invited, did not join", h.notJoined.join(", ")]);
  return rows;
}

/** A clean, printable copy (the browser's "Save as PDF" turns it into a file). Built here so no library is needed. */
function printMinutes(m: Minutes, h: Header | null, tz: string) {
  const list = (a: string[]) => (a.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Minutes of Meeting - ${esc(h?.title ?? "")}</title>
<style>body{font:14px/1.55 Arial,sans-serif;color:#111;margin:32px auto;max-width:800px;padding:0 24px}h1{font-size:20px;margin:0}h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #ccc;padding-bottom:4px;margin:22px 0 8px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f2f2f2}.k{width:28%;background:#f7f7f7;font-weight:bold}.sub{color:#555;margin:2px 0 14px}ul{margin:4px 0 4px 18px;padding:0}@media print{body{margin:0}}</style></head><body>
<h1>Minutes of Meeting</h1><p class="sub">${esc(h?.company ?? "")}${h?.company ? " · " : ""}${esc(h?.title ?? "")}${m.status === "PUBLISHED" ? ` · version ${m.version}` : " · DRAFT"}</p>
<table>${factsOf(m, h, tz).map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
${m.summary ? `<h2>Overview</h2><p>${esc(m.summary).replace(/\n/g, "<br>")}</p>` : ""}
${m.agenda.length ? `<h2>Agenda</h2><ol>${m.agenda.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>` : ""}
${m.discussion.length ? `<h2>Discussion</h2>${m.discussion.map((t) => `<p><b>${esc(t.topic)}</b></p>${list(t.points)}`).join("")}` : ""}
${m.decisions.length ? `<h2>Decisions</h2>${list(m.decisions)}` : ""}
${m.actionItems.length ? `<h2>Action items</h2><table><tr><th>#</th><th>Action</th><th>Owner</th><th>Due</th></tr>${m.actionItems.map((a, i) => `<tr><td>${i + 1}</td><td>${esc(a.task)}</td><td>${esc(a.owner ?? "Not named")}</td><td>${esc(a.due ?? "Not stated")}</td></tr>`).join("")}</table>` : ""}
${m.nextMeeting ? `<h2>Next meeting</h2><p>${esc(m.nextMeeting)}</p>` : ""}
<script>window.onload=function(){window.print()}</script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

const H = ({ children }: { children: React.ReactNode }) => <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{children}</p>;

function Read({ m, h, tz }: { m: Minutes; h: Header | null; tz: string }) {
  const zone = h?.timezone ?? tz;
  const facts = factsOf(m, h, tz);
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${m.status === "PUBLISHED" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}`}>
            {m.status === "PUBLISHED" ? `Published · version ${m.version}` : "Draft: only you can see this"}
          </span>
          {m.publishedAt && <span className="text-xs text-slate-400">{new Intl.DateTimeFormat("en-US", { timeZone: zone, day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(m.publishedAt))}</span>}
        </div>
        <button type="button" onClick={() => printMinutes(m, h, tz)} className="rounded-xl border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Print / Save as PDF</button>
      </div>
      {facts.length > 0 && (
        <dl className="divide-y divide-indigo-100 rounded-xl border border-indigo-100">
          {facts.map(([k, v]) => <div key={k} className="grid grid-cols-[9rem_1fr] gap-3 px-3 py-2"><dt className="text-slate-500">{k}</dt><dd className="text-slate-900">{v}</dd></div>)}
        </dl>
      )}
      {m.summary && <div><H>Overview</H><p className="mt-1 whitespace-pre-wrap text-slate-800">{m.summary}</p></div>}
      {m.agenda.length > 0 && <div><H>Agenda</H><ol className="mt-1 list-decimal space-y-1 pl-5 text-slate-800">{m.agenda.map((a, i) => <li key={i}>{a}</li>)}</ol></div>}
      {m.discussion.length > 0 && (
        <div>
          <H>Discussion</H>
          <div className="mt-1 space-y-3">
            {m.discussion.map((t, i) => (
              <div key={i}>
                <p className="font-medium text-slate-900">{t.topic}</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-slate-700">{t.points.map((p, j) => <li key={j}>{p}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      )}
      {m.decisions.length > 0 && <div><H>Decisions</H><ul className="mt-1 list-disc space-y-1 pl-5 text-slate-800">{m.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></div>}
      {m.actionItems.length > 0 && (
        <div>
          <H>Action items</H>
          <div className="mt-1 overflow-x-auto rounded-xl border border-indigo-100">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2 font-medium">#</th><th className="px-3 py-2 font-medium">Action</th><th className="px-3 py-2 font-medium">Owner</th><th className="px-3 py-2 font-medium">Due</th></tr></thead>
              <tbody className="divide-y divide-indigo-50 text-slate-800">
                {m.actionItems.map((a, i) => <tr key={i}><td className="px-3 py-2 text-slate-400">{i + 1}</td><td className="px-3 py-2">{a.task}</td><td className="px-3 py-2">{a.owner ?? <span className="text-slate-400">Not named</span>}</td><td className="px-3 py-2">{a.due ?? <span className="text-slate-400">Not stated</span>}</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {m.nextMeeting && <div><H>Next meeting</H><p className="mt-1 text-slate-800">{m.nextMeeting}</p></div>}
    </div>
  );
}

function Editor({ meetingId, m, onSaved, onClose, onPublish, disabled, setError }: { meetingId: string; m: Minutes; onSaved: (t: string) => Promise<void>; onClose: () => void; onPublish: () => void; disabled: boolean; setError: (s: string) => void }) {
  const [summary, setSummary] = useState(m.summary);
  const [agenda, setAgenda] = useState(m.agenda.join("\n"));
  const [topics, setTopics] = useState<{ topic: string; points: string }[]>(m.discussion.map((t) => ({ topic: t.topic, points: t.points.join("\n") })));
  const [decisions, setDecisions] = useState(m.decisions.join("\n"));
  const [items, setItems] = useState<Item[]>(m.actionItems.length ? m.actionItems : []);
  const [next, setNext] = useState(m.nextMeeting ?? "");
  const [saving, setSaving] = useState(false);
  const field = "w-full rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800";
  const lines = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean);

  async function save(thenPublish: boolean) {
    setSaving(true);
    setError("");
    try {
      await apiPut(`/meetings/${meetingId}/minutes`, {
        summary, agenda: lines(agenda), decisions: lines(decisions), nextMeeting: next,
        discussion: topics.map((t) => ({ topic: t.topic, points: lines(t.points) })).filter((t) => t.topic.trim() || t.points.length),
        actionItems: items.filter((i) => i.task.trim()),
      });
      await onSaved(m.status === "PUBLISHED" ? "Saved. The people invited were told the minutes changed." : "Draft saved.");
      if (thenPublish) onPublish();
      else onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const set = (i: number, patch: Partial<Item>) => setItems((a) => a.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setT = (i: number, patch: Partial<{ topic: string; points: string }>) => setTopics((a) => a.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-slate-500">{m.status === "PUBLISHED" ? "You are editing published minutes. Earlier versions are kept." : "Check what the AI wrote against what was said and fix anything wrong before publishing. The date, time, place and attendance at the top are filled in by the system."}</p>
      <label className="block text-xs text-slate-500">Overview<textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} maxLength={4000} className={`${field} mt-1 break-words`} /></label>
      <label className="block text-xs text-slate-500">Agenda (one item per line)<textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} rows={3} className={`${field} mt-1 break-words`} /></label>
      <div>
        <p className="text-xs text-slate-500">Discussion, by topic</p>
        <div className="mt-1 space-y-2">
          {topics.map((t, i) => (
            <div key={i} className="space-y-1.5 rounded-xl border border-indigo-100 p-2.5">
              <div className="flex gap-2">
                <input value={t.topic} onChange={(e) => setT(i, { topic: e.target.value })} placeholder="Topic" maxLength={200} className={field} />
                <button type="button" onClick={() => setTopics((x) => x.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-600">Remove</button>
              </div>
              <textarea value={t.points} onChange={(e) => setT(i, { points: e.target.value })} rows={3} placeholder="Points discussed (one per line)" className={`${field} break-words`} />
            </div>
          ))}
          <button type="button" onClick={() => setTopics((x) => [...x, { topic: "", points: "" }])} className="text-xs font-medium text-indigo-600 hover:underline">+ Add topic</button>
        </div>
      </div>
      <label className="block text-xs text-slate-500">Decisions (one per line)<textarea value={decisions} onChange={(e) => setDecisions(e.target.value)} rows={3} className={`${field} mt-1 break-words`} /></label>
      <div>
        <p className="text-xs text-slate-500">Action items</p>
        <div className="mt-1 space-y-2">
          {items.map((a, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_9rem_8rem_auto]">
              <input value={a.task} onChange={(e) => set(i, { task: e.target.value })} placeholder="What needs doing" maxLength={300} className={field} />
              <input value={a.owner ?? ""} onChange={(e) => set(i, { owner: e.target.value || null })} placeholder="Who" maxLength={100} className={field} />
              <input value={a.due ?? ""} onChange={(e) => set(i, { due: e.target.value || null })} placeholder="By when" maxLength={40} className={field} />
              <button type="button" onClick={() => setItems((x) => x.filter((_, j) => j !== i))} className="text-xs text-slate-400 hover:text-red-600">Remove</button>
            </div>
          ))}
          <button type="button" onClick={() => setItems((x) => [...x, { task: "", owner: null, due: null }])} className="text-xs font-medium text-indigo-600 hover:underline">+ Add action item</button>
        </div>
      </div>
      <label className="block text-xs text-slate-500">Next meeting (only if one was fixed)<input value={next} onChange={(e) => setNext(e.target.value)} maxLength={300} className={`${field} mt-1`} /></label>
      {m.transcript && (
        <details className="rounded-xl bg-slate-50 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">What was heard (transcript, deleted when you publish)</summary>
          <p className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs text-slate-600">{m.transcript}</p>
        </details>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button className={ghost} onClick={onClose} disabled={saving}>Close</button>
        <button className={ghost} onClick={() => void save(false)} disabled={saving || disabled}>{m.status === "PUBLISHED" ? "Save changes" : "Save draft"}</button>
        {m.status !== "PUBLISHED" && <button className={primary} onClick={() => void save(true)} disabled={saving || disabled}>Save and publish</button>}
      </div>
    </div>
  );
}
