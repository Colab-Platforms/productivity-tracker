"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE, apiGet, apiPost, getToken } from "@/lib/api";

// ---------------------------------------------------------------------------
// MY DOCUMENTS: the ONE place that shows a person their own document checklist (upload, replace, preview, verification status, HR
// remarks and rejection reasons). Used by My Profile and by the Documents page, so there is no second copy of this logic. It talks to the
// same existing APIs (/documents/mine and /onboarding/me/documents); nothing about the documents or their rules changed.
// ---------------------------------------------------------------------------

export type Status = "NOT_SUBMITTED" | "SUBMITTED" | "VERIFIED" | "REJECTED";
export type Item = {
  requirementId: string; name: string; description: string | null; category: string; isMandatory: boolean; uploadedByEmployee: boolean;
  status: Status; statusLabel: string; documentId: string | null; fileName: string | null; uploadedAt: string | null;
  reviewedAt: string | null; reviewedBy: string | null; rejectionReason: string | null;
};
export type Archived = { documentId: string; name: string; fileName: string | null; uploadedAt: string | null; status: Status; statusLabel: string; reason: string };
export type Summary = { required: number; verified: number; submitted: number; rejected: number; missing: number };
export type Mine = { employmentType: string | null; items: Item[]; archived: Archived[]; summary: Summary };
const STATUS_STYLE: Record<Status, string> = { NOT_SUBMITTED: "bg-slate-100 text-slate-600", SUBMITTED: "bg-amber-50 text-amber-700", VERIFIED: "bg-emerald-50 text-emerald-700", REJECTED: "bg-red-50 text-red-600" };
export const date = (s: string | null) => (s ? new Date(s).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" }) : "");

export function useApi<T>(path: string | null, reload: number) {
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

export async function viewFile(documentId: string) {
  const res = await fetch(`${API_BASE}/onboarding/documents/${documentId}/file`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error("Could not open the file");
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(file);
  });

export const Chip = ({ s, label }: { s: Status; label: string }) => <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[s]}`}>{label}</span>;
export const card = "rounded-2xl bg-white shadow-[var(--shadow-card)]";


export function MyDocuments() {
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const mine = useApi<Mine>("/documents/mine", reload);

  async function upload(file: File | undefined) {
    const id = uploadFor;
    setUploadFor(null);
    if (!file || !id || busy) return;
    setBusy("up" + id);
    setError("");
    setNotice("");
    try {
      await apiPost("/onboarding/me/documents", { requirementId: id, fileName: file.name, data: await readFile(file), mimeType: file.type });
      setNotice("Uploaded. HR will review it.");
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-4">
      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p>}
      <input ref={picker} type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
    <section className={`${card} p-6`}>
      {mine.error && (
        <p className="mb-3 flex items-center justify-between rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          Couldn&apos;t load your documents: {mine.error}
          <button onClick={() => setReload((n) => n + 1)} className="ml-3 rounded-lg bg-white px-3 py-1 text-xs font-medium ring-1 ring-red-200">Retry</button>
        </p>
      )}
      {!mine.data && !mine.error && <div className="space-y-2" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14" />)}</div>}
      {mine.data && (
        <>
          <div className="flex flex-wrap gap-2 text-xs">
            {([["Required", mine.data.summary.required, "bg-indigo-50 text-indigo-700"], ["Verified", mine.data.summary.verified, "bg-emerald-50 text-emerald-700"], ["Waiting for HR", mine.data.summary.submitted, "bg-amber-50 text-amber-700"], ["Rejected", mine.data.summary.rejected, "bg-red-50 text-red-600"], ["Not submitted", mine.data.summary.missing, "bg-slate-100 text-slate-600"]] as const).map(([l, n, c]) => (
              <span key={l} className={`rounded-full px-3 py-1 font-medium ${c}`}>{l} {n}</span>
            ))}
          </div>
          {mine.data.items.length === 0 && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">No documents are being asked of you right now.</p>}
          <div className="mt-4 divide-y divide-indigo-100">
            {mine.data.items.map((i) => (
              <div key={i.requirementId} className="flex flex-wrap items-start justify-between gap-3 py-4">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">
                    {i.name}
                    <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${i.isMandatory ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-500"}`}>{i.isMandatory ? "Required" : "Optional"}</span>
                  </p>
                  {i.description && <p className="text-sm text-slate-500">{i.description}</p>}
                  {i.fileName && <p className="mt-0.5 text-xs text-slate-400">{i.fileName} · uploaded {date(i.uploadedAt)}</p>}
                  {i.status === "REJECTED" && i.rejectionReason && <p className="mt-1 rounded-lg bg-red-50 px-3 py-1.5 text-sm text-red-700">Rejected{i.reviewedBy ? ` by ${i.reviewedBy}` : ""}: {i.rejectionReason}</p>}
                  {i.status === "VERIFIED" && i.reviewedBy && <p className="mt-0.5 text-xs text-emerald-700">Verified by {i.reviewedBy}{i.reviewedAt ? ` on ${date(i.reviewedAt)}` : ""}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Chip s={i.status} label={i.status === "SUBMITTED" ? "Waiting for HR" : i.statusLabel} />
                  {i.documentId && i.fileName && <button onClick={() => viewFile(i.documentId as string).catch((e: Error) => setError(e.message))} className="rounded-lg border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">View</button>}
                  {i.uploadedByEmployee ? (
                    i.status !== "VERIFIED" && (
                      <button disabled={busy === "up" + i.requirementId} onClick={() => { setUploadFor(i.requirementId); picker.current?.click(); }} className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                        {i.status === "NOT_SUBMITTED" ? "Upload" : "Replace"}
                      </button>
                    )
                  ) : (
                    <span className="text-xs text-slate-400">HR uploads this</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {mine.data.archived.length > 0 && (
            <details className="mt-5 rounded-2xl border border-indigo-100 px-4 py-3 text-sm">
              <summary className="cursor-pointer text-slate-600">Documents you submitted that are no longer asked for ({mine.data.archived.length})</summary>
              <div className="mt-3 divide-y divide-indigo-100">
                {mine.data.archived.map((a) => (
                  <div key={a.documentId} className="flex items-center justify-between gap-3 py-2">
                    <span className="text-slate-700">{a.name} <span className="text-xs text-slate-400">· {a.reason}</span></span>
                    <span className="flex items-center gap-2"><Chip s={a.status} label={a.statusLabel} />{a.fileName && <button onClick={() => viewFile(a.documentId).catch((e: Error) => setError(e.message))} className="rounded-lg border border-indigo-100 px-2.5 py-1 text-xs">View</button>}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </section>

    </div>
  );
}
