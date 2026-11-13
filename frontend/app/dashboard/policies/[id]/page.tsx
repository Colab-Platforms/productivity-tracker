"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { usePolicyRealtime } from "@/lib/realtime";
import { useMe } from "../../layout";
import { Modal } from "../../_employees/Modal";
import PolicyForm from "../_components/PolicyForm";
import { card, downloadFile, fetchBlobUrl, field, fmtDate, fmtDateTime, STATUS_CHIP, STATUS_LABEL, useApi, useFallbackPoll, CompanyContext, useCompany, withCompany, type Detail, type Manage, type Note } from "../_lib";

// One policy: read it, then confirm. HR/Admin also see its status, versions, review notes and can publish.

type View = { kind: "docx" | "pdf" | "image" | "other"; html: string | null; fileName: string; versionLabel: string };

// A picture held in memory (a blob: address), which the Next image optimiser cannot fetch.
function BlobImage({ src, alt }: { src: string; alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className="mx-auto max-h-[80vh] rounded-xl border border-indigo-100" />;
}

// The readable document. Word files arrive as cleaned HTML; PDFs and images are shown from the private file.
function Viewer({ id, version, onViewed }: { id: string; version?: number; onViewed: () => void }) {
  const [view, setView] = useState<View | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState("");
  const told = useRef("");
  const co = useCompany();
  const qs = withCompany(version === undefined ? "" : `?version=${version}`, co);

  useEffect(() => {
    let live = true;
    let url: string | null = null;
    (async () => {
      try {
        const v = await apiGet<View>(`/policies/${id}/view${qs}`);
        if (!live) return;
        setView(v);
        setError("");
        if (v.kind === "pdf" || v.kind === "image") {
          url = await fetchBlobUrl(`/policies/${id}/file${qs}`);
          if (live) setSrc(url);
        } else {
          setSrc(null);
        }
        if (told.current !== qs) {
          told.current = qs;
          onViewed(); // opening it was recorded by the server; refresh the status
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, qs]);

  if (error) return <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Couldn&apos;t open the document: {error}</p>;
  if (!view) return <div className="skeleton h-96 rounded-2xl" aria-busy="true" />;
  if (view.kind === "docx")
    return (
      <article
        className="max-w-none rounded-xl border border-indigo-100 bg-white px-5 py-6 text-[15px] leading-relaxed text-slate-800 sm:px-8 [&_a]:text-indigo-600 [&_a]:underline [&_h1]:mt-6 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:font-semibold [&_li]:mt-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mt-3 [&_table]:my-4 [&_table]:w-full [&_td]:border [&_td]:border-indigo-100 [&_td]:p-2 [&_th]:border [&_th]:border-indigo-100 [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-6"
        // The server converts and cleans the Word file (only a fixed set of tags, no scripts, no event attributes).
        dangerouslySetInnerHTML={{ __html: view.html ?? "" }}
      />
    );
  if (view.kind === "pdf") return src ? <iframe title={view.fileName} src={src} className="h-[75vh] w-full rounded-xl border border-indigo-100 bg-white" /> : <div className="skeleton h-96 rounded-2xl" />;
  if (view.kind === "image") return src ? <BlobImage src={src} alt={view.fileName} /> : <div className="skeleton h-96 rounded-2xl" />;
  return <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">This file type cannot be shown in the page. Use Download to open it.</p>;
}

// An owner HR/Admin opening another company's policy arrives with ?company=<id>; every request on this page then carries it.
export default function PolicyPage() {
  const company = useSearchParams().get("company");
  return (
    <CompanyContext.Provider value={company}>
      <PolicyPageInner />
    </CompanyContext.Provider>
  );
}

function PolicyPageInner() {
  const { id } = useParams<{ id: string }>();
  const co = useCompany();
  const me = useMe();
  const isHr = me?.role === "HR" || me?.role === "ADMIN";
  const [reload, setReload] = useState(0);
  const bump = useCallback(() => setReload((n) => n + 1), []);
  const { data: p, error } = useApi<Detail>(withCompany(`/policies/${id}`, co), reload);
  const manage = useApi<Manage>(isHr ? withCompany("/policies/manage", co) : null, reload);
  const { connected } = usePolicyRealtime(bump);
  useFallbackPoll(connected, bump);

  const [picked, setPicked] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [editing, setEditing] = useState<null | "edit" | "version">(null);
  const [publishing, setPublishing] = useState(false);

  async function run(fn: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setErr("");
    setNotice("");
    try {
      await fn();
      setNotice(done);
      bump();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !p) return <div className="mx-auto page-3xl p-8"><p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p><Link href="/dashboard/policies" className="mt-4 inline-block text-sm font-medium text-indigo-600">← Back to policies</Link></div>;
  if (!p) return <div className="mx-auto page-4xl space-y-4 p-8" aria-busy="true"><div className="skeleton h-10 w-72" /><div className="skeleton h-96 rounded-2xl" /></div>;

  const hr = p.hr;
  const draftVersion = hr?.versions.find((v) => v.status === "DRAFT");
  const shownVersion = picked ?? draftVersion?.number; // HR sees the unpublished version first, if there is one
  const shown = hr?.versions.find((v) => v.number === shownVersion);
  const canDownload = p.allowDownload || isHr;
  const dl = shownVersion === undefined ? "" : `&version=${shownVersion}`;

  return (
    <div className="space-y-5">
      <Link href="/dashboard/policies" className="text-sm font-medium text-indigo-600 hover:underline">← Policies &amp; induction</Link>

      <header className={`${card} p-5 sm:p-6`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-indigo-600">{p.category}</p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">{p.title}</h1>
            {p.description && <p className="mt-1 text-sm text-slate-500">{p.description}</p>}
          </div>
          <span className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${STATUS_CHIP[p.status]}`}>{STATUS_LABEL[p.status]}</span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-slate-400">Version</dt><dd className="font-medium text-slate-800">{p.versionLabel}</dd></div>
          <div><dt className="text-xs text-slate-400">Published</dt><dd className="font-medium text-slate-800">{fmtDate(p.publishedAt)}</dd></div>
          <div><dt className="text-xs text-slate-400">Effective</dt><dd className="font-medium text-slate-800">{fmtDate(p.effectiveDate)}</dd></div>
          <div><dt className="text-xs text-slate-400">Acknowledgment</dt><dd className="font-medium text-slate-800">{p.isMandatory ? "Mandatory" : "Optional"}</dd></div>
        </dl>
      </header>

      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700" role="status">{notice}</p>}
      {err && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{err}</p>}

      {isHr && p.status === "DRAFT" && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">This is a <b>draft</b>. Employees cannot see it. Review it, deal with any review notes, then publish it.</p>
      )}
      {isHr && hr && p.status === "PUBLISHED" && draftVersion && (
        <p className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-800">Version <b>{draftVersion.label}</b> is prepared but <b>not published</b>. Employees still see version {p.versionLabel}. You are previewing the new one below.</p>
      )}

      {/* the document */}
      <section className={`${card} p-4 sm:p-5`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">{isHr && shown ? `Document, version ${shown.label}` : "Document"}</h2>
          <div className="flex flex-wrap items-center gap-2">
            {isHr && hr && hr.versions.length > 1 && (
              <select aria-label="Version shown" value={shownVersion ?? ""} onChange={(e) => setPicked(e.target.value ? Number(e.target.value) : null)} className={`${field} w-auto py-1.5`}>
                {hr.versions.map((v) => <option key={v.id} value={v.number}>Version {v.label} ({STATUS_LABEL[v.status]})</option>)}
              </select>
            )}
            {canDownload ? (
              <button onClick={() => downloadFile(withCompany(`/policies/${id}/file?download=1${dl}`, co), shown?.fileName ?? p.fileName).catch((e: Error) => setErr(e.message))} className="rounded-xl border border-indigo-100 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Download original</button>
            ) : (
              <span className="text-xs text-slate-400">Download is switched off for this policy</span>
            )}
          </div>
        </div>
        <Viewer id={id} version={shownVersion} onViewed={bump} />
      </section>

      {/* employee acknowledgment */}
      {p.my.applies ? (
        <section className={`${card} p-5 sm:p-6`} aria-labelledby="ack">
          <h2 id="ack" className="text-base font-semibold text-slate-900">Your acknowledgment</h2>
          {p.my.status === "ACKNOWLEDGED" ? (
            <div className="mt-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              You confirmed this policy on <b>{fmtDateTime(p.my.acknowledgedAt)}</b>. Your acknowledgment has been recorded.
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {!p.my.opened && <p className="text-sm text-slate-500">Read the document above. The confirmation unlocks once it has been opened.</p>}
              <label className={`flex items-start gap-3 text-sm ${p.my.opened ? "text-slate-800" : "text-slate-400"}`}>
                <input type="checkbox" checked={confirmed} disabled={!p.my.opened || busy} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 h-4 w-4" />
                I confirm that I have read and understood this policy.
              </label>
              <button
                disabled={!confirmed || !p.my.opened || busy}
                onClick={() => run(async () => { await apiPost(withCompany(`/policies/${id}/acknowledge`, co), { confirmed: true }); setConfirmed(false); }, "Your acknowledgment has been recorded successfully.")}
                className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Saving…" : "Confirm Acknowledgment"}
              </button>
              {!p.isMandatory && <p className="text-xs text-slate-400">Confirmation is optional for this policy.</p>}
            </div>
          )}
          {p.my.history.length > 0 && (
            <div className="mt-5 border-t border-indigo-50 pt-4">
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Your earlier confirmations of this policy</h3>
              <ul className="mt-2 space-y-1 text-sm text-slate-600">{p.my.history.map((h, i) => <li key={i}>Version {h.versionLabel}, confirmed {fmtDateTime(h.acknowledgedAt)}</li>)}</ul>
            </div>
          )}
        </section>
      ) : (
        isHr && <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">This policy is not addressed to you, so you are viewing it as HR. Your own confirmation is not requested.</p>
      )}

      {/* HR / Admin */}
      {isHr && hr && (
        <>
          <section className={`${card} p-5 sm:p-6`}>
            <h2 className="text-base font-semibold text-slate-900">Manage this policy</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {p.status === "DRAFT" && <button onClick={() => setEditing("edit")} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Edit draft</button>}
              {(p.status === "DRAFT" || (p.status === "PUBLISHED" && draftVersion)) && <button onClick={() => setPublishing(true)} disabled={busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Publish{draftVersion ? ` version ${draftVersion.label}` : ""}</button>}
              {p.status === "PUBLISHED" && !draftVersion && <button onClick={() => setEditing("version")} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Upload a new version</button>}
              {p.status === "ARCHIVED" ? (
                <button disabled={busy} onClick={() => run(() => apiPost(withCompany(`/policies/${id}/restore`, co)), "Policy restored.")} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Restore</button>
              ) : (
                <button disabled={busy} onClick={() => run(() => apiPost(withCompany(`/policies/${id}/archive`, co)), "Policy archived. It stays on record for HR.")} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Archive</button>
              )}
            </div>
            <dl className="mt-5 grid grid-cols-3 gap-3 text-sm">
              <div className="rounded-xl bg-slate-50 p-3"><dt className="text-xs text-slate-400">People it is for</dt><dd className="text-xl font-semibold tabular-nums text-slate-900">{hr.counts.required}</dd></div>
              <div className="rounded-xl bg-emerald-50 p-3"><dt className="text-xs text-slate-500">Confirmed</dt><dd className="text-xl font-semibold tabular-nums text-slate-900">{hr.counts.acknowledged}</dd></div>
              <div className="rounded-xl bg-amber-50 p-3"><dt className="text-xs text-slate-500">Pending</dt><dd className="text-xl font-semibold tabular-nums text-slate-900">{hr.counts.pending}</dd></div>
            </dl>
          </section>

          <section className={`${card} p-5 sm:p-6`}>
            <div className="flex items-center justify-between"><h2 className="text-base font-semibold text-slate-900">HR review notes</h2><span className="text-xs text-slate-500">{hr.openNotes} open</span></div>
            <p className="mt-1 text-xs text-slate-500">Things to check before publishing. They never change the document: it stays exactly as it was provided.</p>
            {hr.notes.length === 0 && <p className="mt-3 text-sm text-slate-500">No review notes.</p>}
            <ul className="mt-3 space-y-3">{hr.notes.map((n) => <NoteItem key={n.id} n={n} policyId={id} disabled={busy} onChanged={(m) => { setNotice(m); bump(); }} onError={setErr} />)}</ul>
          </section>

          <section className={`${card} p-5 sm:p-6`}>
            <h2 className="text-base font-semibold text-slate-900">Version history</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead><tr className="text-left text-xs font-medium text-slate-500"><th className="py-2 pr-3">Version</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">Created by</th><th className="py-2 pr-3">Published</th><th className="py-2 pr-3">Confirm again?</th><th className="py-2 pr-3">Confirmed</th><th className="py-2" /></tr></thead>
                <tbody>
                  {[...hr.versions].reverse().map((v) => (
                    <tr key={v.id} className="border-t border-indigo-50 align-top">
                      <td className="py-2.5 pr-3 font-medium tabular-nums text-slate-900">{v.label}{v.changeNote && <span className="block text-xs font-normal text-slate-400">{v.changeNote}</span>}</td>
                      <td className="py-2.5 pr-3"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[v.status]}`}>{STATUS_LABEL[v.status]}</span></td>
                      <td className="py-2.5 pr-3 text-slate-600">{v.createdBy ?? "—"}<span className="block text-xs text-slate-400">{fmtDate(v.createdAt)}</span></td>
                      <td className="py-2.5 pr-3 text-slate-600">{fmtDate(v.publishedAt)}</td>
                      <td className="py-2.5 pr-3 text-slate-600">{v.requiresAck ? "Yes" : "No"}</td>
                      <td className="py-2.5 pr-3 tabular-nums text-slate-600">{v.acknowledged}</td>
                      <td className="py-2.5 text-right"><button onClick={() => { setPicked(v.number); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="rounded-lg border border-indigo-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {editing && manage.data && <PolicyForm mode={editing} setup={manage.data} policy={p} onClose={() => setEditing(null)} onDone={(_i, m) => { setEditing(null); setNotice(m); setPicked(null); bump(); }} />}
      {publishing && hr && (
        <PublishDialog p={p} onClose={() => setPublishing(false)} onDone={(m) => { setPublishing(false); setNotice(m); setPicked(null); bump(); }} />
      )}
    </div>
  );
}

function NoteItem({ n, policyId, disabled, onChanged, onError }: { n: Note; policyId: string; disabled: boolean; onChanged: (m: string) => void; onError: (m: string) => void }) {
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const co = useCompany();
  async function set(status: "RESOLVED" | "DISMISSED" | "OPEN", note?: string) {
    try {
      await apiPost(withCompany(`/policies/${policyId}/notes/${n.id}`, co), { status, note });
      setDismissing(false);
      onChanged(status === "OPEN" ? "Note re-opened." : status === "RESOLVED" ? "Note marked as resolved." : "Note dismissed.");
    } catch (e) {
      onError((e as Error).message);
    }
  }
  const tone = n.status === "OPEN" ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-slate-50";
  return (
    <li className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-medium text-slate-900">{n.title}</p>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${n.status === "OPEN" ? "bg-amber-100 text-amber-800" : "bg-slate-200 text-slate-600"}`}>{n.status === "OPEN" ? "Open" : n.status === "RESOLVED" ? "Resolved" : "Dismissed"}</span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{n.detail}</p>
      {n.resolutionNote && <p className="mt-1.5 text-xs text-slate-500">Reason: {n.resolutionNote}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {n.status === "OPEN" ? (
          <>
            <button disabled={disabled} onClick={() => set("RESOLVED")} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Mark resolved</button>
            <button disabled={disabled} onClick={() => setDismissing((d) => !d)} className="rounded-lg border border-indigo-100 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Dismiss…</button>
          </>
        ) : (
          <button disabled={disabled} onClick={() => set("OPEN")} className="rounded-lg border border-indigo-100 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Re-open</button>
        )}
      </div>
      {dismissing && (
        <div className="mt-3 flex flex-wrap gap-2">
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Why is this not an issue? (required)" className={`${field} min-w-56 flex-1`} />
          <button disabled={disabled || reason.trim().length < 3} onClick={() => set("DISMISSED", reason)} className="rounded-lg bg-slate-700 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50">Confirm dismiss</button>
        </div>
      )}
    </li>
  );
}

// Publishing is explicit: HR confirms what will happen, and acknowledges any review notes still open.
function PublishDialog({ p, onClose, onDone }: { p: Detail; onClose: () => void; onDone: (m: string) => void }) {
  const hr = p.hr!;
  const draft = hr.versions.find((v) => v.status === "DRAFT")!;
  const first = p.status === "DRAFT";
  const [effective, setEffective] = useState(p.effectiveDate ?? "");
  const [again, setAgain] = useState(draft.requiresAck);
  const [reviewed, setReviewed] = useState(false);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const co = useCompany();

  async function go() {
    setBusy(true);
    setError("");
    try {
      const r = await apiPost<{ version: string; notified: number }>(withCompany(`/policies/${p.id}/publish`, co), { confirm: true, acknowledgeNotes: reviewed, effectiveDate: effective || undefined, ...(first ? {} : { requiresAck: again }) });
      onDone(`Published version ${r.version}. ${r.notified} ${r.notified === 1 ? "person was" : "people were"} notified.`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const blocked = (hr.openNotes > 0 && !reviewed) || !sure;
  return (
    <Modal title={`Publish version ${draft.label}?`} subtitle={`${p.title}`} onClose={onClose} width="max-w-lg" footer={
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
        <button onClick={go} disabled={blocked || busy} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Publishing…" : "Publish"}</button>
      </div>
    }>
      <div className="space-y-4 text-sm text-slate-700">
        {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-red-700">{error}</p>}
        <p>It becomes visible to <b>{hr.audience.size}</b> {hr.audience.size === 1 ? "person" : "people"} straight away, and they are notified.{first ? "" : " The previous version stays on record, with everybody's earlier confirmations."}</p>
        <label className="block">Effective date
          <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} className={`${field} mt-1`} />
          <span className="mt-1 block text-xs text-slate-400">Leave empty to use today.</span>
        </label>
        {!first && <label className="flex items-start gap-2"><input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} className="mt-0.5" /> Employees must read and confirm this version again</label>}
        {hr.openNotes > 0 && (
          <label className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-amber-900">
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} className="mt-0.5" />
            <span>There {hr.openNotes === 1 ? "is 1 review note" : `are ${hr.openNotes} review notes`} still open. I have reviewed {hr.openNotes === 1 ? "it" : "them"} and want to publish anyway.</span>
          </label>
        )}
        <label className="flex items-start gap-2"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="mt-0.5" /> I approve this document for publication.</label>
      </div>
    </Modal>
  );
}
