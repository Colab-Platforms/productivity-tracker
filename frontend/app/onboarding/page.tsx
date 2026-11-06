// ===========================================================================
// ONBOARDING — what a new hire sees before the tracker unlocks
//
// Deliberately outside /dashboard. Someone mid-onboarding gets this page and
// nothing else: no sidebar, no clock-in button they can't use, no half-empty
// dashboard. One screen, one job.
//
// Every status is visible, including why a document was sent back. Most
// onboarding frustration is not knowing what is happening.
// ===========================================================================

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { clearToken, getToken , API_BASE } from "@/lib/api";

const API = API_BASE;

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${
        typeof window === "undefined" ? "" : localStorage.getItem("token") ?? ""
      }`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "That didn't work");
  return data as T;
}

type ChecklistItem = {
  requirementId: string;
  label: string;
  helpText: string | null;
  category: string;
  isMandatory: boolean;
  status: string;
  fileName: string | null;
  uploadedAt: string | null;
  rejectionReason: string | null;
  documentId: string | null;
};

type Onboarding = {
  user: {
    name: string;
    email: string;
    employeeCode: string | null;
    designation: string | null;
    dateOfJoining: string | null;
    platform: string | null;
  };
  onboardingStatus: string;
  trackerAccessEnabled: boolean;
  mustChangePassword: boolean;
  progress: { done: number; total: number };
  waitingOnHrSince: string | null;
  checklist: ChecklistItem[];
};

const STAGE_COPY: Record<string, { title: string; body: string }> = {
  OFFER_SENT: {
    title: "Welcome — let's get you set up",
    body: "Upload the documents below. Once they're in, HR takes it from here.",
  },
  DOCUMENTS_PENDING: {
    title: "Nearly there",
    body: "A few documents are still missing. Upload them and you're done with your part.",
  },
  DOCUMENTS_SUBMITTED: {
    title: "Everything's in — thank you",
    body: "HR is reviewing your documents now. You'll get access as soon as that's finished.",
  },
  AWAITING_RESUME: {
    title: "Approved — one last step on our side",
    body: "Your documents are approved. HR is finishing your file, and then you're in.",
  },
  ACTIVE: {
    title: "You're all set",
    body: "Your account is active and the tracker is unlocked.",
  },
};

const STATUS_CHIP: Record<string, string> = {
  REQUESTED: "bg-[#EEF0FD] text-slate-500",
  SUBMITTED: "bg-sky-50 text-sky-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-rose-50 text-rose-700",
};

const STATUS_WORD: Record<string, string> = {
  REQUESTED: "not uploaded",
  SUBMITTED: "with HR",
  APPROVED: "approved",
  REJECTED: "needs re-upload",
};

export default function OnboardingPage() {
  const router = useRouter();
  const [data, setData] = useState<Onboarding | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await call<Onboarding>("/onboarding/me"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your onboarding");
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    void load();
  }, [load, router]);

  // While HR is reviewing there is nothing to do but wait, so the page
  // checks back on its own rather than asking them to refresh.
  useEffect(() => {
    if (!data || data.onboardingStatus === "ACTIVE") return;
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [data, load]);

  async function upload(item: ChecklistItem, file: File) {
    if (file.size > 10 * 1024 * 1024) {
      setError("That file is over the 10 MB limit.");
      return;
    }

    setBusyId(item.requirementId);
    setError("");

    try {
      // FileReader gives us "data:application/pdf;base64,..." which the
      // server splits apart. No multipart, no extra dependency.
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read that file"));
        reader.readAsDataURL(file);
      });

      await call("/onboarding/me/documents", "POST", {
        requirementId: item.requirementId,
        fileName: file.name,
        data: dataUrl,
        mimeType: file.type,
      });

      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload that");
    } finally {
      setBusyId(null);
    }
  }

  function signOut() {
    clearToken();
    router.replace("/login");
  }

  if (!data) {
    return (
      <main className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <p className="text-sm text-slate-400">{error || "Loading…"}</p>
      </main>
    );
  }

  if (data.mustChangePassword) {
    return <PasswordGate onDone={load} name={data.user.name} />;
  }

  // Active but HR has switched "Tracker access" off: the dashboard sends this person here, so saying "you're all set" with a button back
  // to the dashboard would just loop. Say what is actually wrong and who can fix it.
  const accessOff = data.onboardingStatus === "ACTIVE" && !data.trackerAccessEnabled;
  const stage = accessOff
    ? { title: "Tracker access is switched off", body: "Your account is active, but the tracker has not been switched on for you." }
    : (STAGE_COPY[data.onboardingStatus] ?? STAGE_COPY.OFFER_SENT!);
  const pct =
    data.progress.total > 0
      ? Math.round((data.progress.done / data.progress.total) * 100)
      : 0;

  return (
    <main className="min-h-screen bg-[var(--background)] px-4 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        {/* header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-slate-500">{data.user.platform}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
              {stage.title}
            </h1>
            <p className="mt-1 text-sm text-slate-600">{stage.body}</p>
          </div>
          <button
            onClick={signOut}
            className="shrink-0 text-sm text-slate-500 underline hover:text-slate-900"
          >
            Sign out
          </button>
        </div>

        {/* identity card */}
        <div className="rounded-2xl bg-white shadow-[var(--shadow-card)] p-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <Detail label="Name" value={data.user.name} />
            <Detail label="Employee ID" value={data.user.employeeCode ?? "—"} />
            <Detail label="Role" value={data.user.designation ?? "—"} />
          </div>
        </div>

        {accessOff ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center">
            <p className="text-sm text-amber-800">
              Please ask HR to switch on Tracker access for you (Employees, then Edit, then Tracker access). Once they do, sign in again and your dashboard will open.
            </p>
          </div>
        ) : data.onboardingStatus === "ACTIVE" ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
            <p className="text-sm text-emerald-800">
              Your account is active. The tracker, your offer letter and the company
              documents are all waiting for you.
            </p>
            <button
              onClick={() => router.push("/dashboard")}
              className="mt-4 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Go to my dashboard
            </button>
          </div>
        ) : (
          <>
            {/* progress */}
            <div className="rounded-2xl bg-white shadow-[var(--shadow-card)] p-5">
              <div className="flex items-end justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Your documents
                </p>
                <p className="text-sm text-slate-600">
                  {data.progress.done} of {data.progress.total} uploaded
                </p>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#EEF0FD]">
                <div
                  className="h-full bg-indigo-600 transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>

            {data.waitingOnHrSince && (
              <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
                Everything you need to provide is in. HR has been reviewing since{" "}
                {new Date(data.waitingOnHrSince).toLocaleString("en-IN", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                .
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                {error}
              </div>
            )}

            {/* checklist */}
            <div className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
              <ul className="divide-y divide-indigo-50">
                {data.checklist.map((item) => (
                  <ChecklistRow
                    key={item.requirementId}
                    item={item}
                    busy={busyId === item.requirementId}
                    onPick={(file) => upload(item, file)}
                  />
                ))}
              </ul>
            </div>

            <p className="text-center text-xs text-slate-400">
              PDF, JPG, PNG or Word. Up to 10 MB each. Your documents are visible only
              to you and HR.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function ChecklistRow({
  item,
  busy,
  onPick,
}: {
  item: ChecklistItem;
  busy: boolean;
  onPick: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const done = item.status === "APPROVED" || item.status === "SUBMITTED";

  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-4">
      <div
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
          item.status === "APPROVED"
            ? "bg-emerald-500 text-white"
            : item.status === "REJECTED"
              ? "bg-rose-500 text-white"
              : done
                ? "bg-sky-500 text-white"
                : "border border-indigo-200 text-slate-300"
        }`}
      >
        {item.status === "APPROVED" ? "✓" : item.status === "REJECTED" ? "!" : ""}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-900">
          {item.label}
          {!item.isMandatory && (
            <span className="ml-2 text-xs font-normal text-slate-400">optional</span>
          )}
        </p>
        {item.helpText && <p className="text-xs text-slate-500">{item.helpText}</p>}

        {item.fileName && (
          <p className="mt-0.5 truncate text-xs text-slate-400">{item.fileName}</p>
        )}

        {item.rejectionReason && (
          <p className="mt-1 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700">
            Sent back: {item.rejectionReason}
          </p>
        )}
      </div>

      <span
        className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${
          STATUS_CHIP[item.status] ?? "bg-[#EEF0FD] text-slate-500"
        }`}
      >
        {STATUS_WORD[item.status] ?? item.status.toLowerCase()}
      </span>

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          e.target.value = "";
        }}
      />

      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy || item.status === "APPROVED"}
        className="shrink-0 rounded-xl border border-indigo-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:border-slate-400 disabled:opacity-40"
      >
        {busy ? "Uploading…" : item.status === "REQUESTED" ? "Upload" : "Replace"}
      </button>
    </li>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-0.5 text-sm text-slate-900">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blocks everything until the temporary password HR chose is replaced.
// ---------------------------------------------------------------------------

function PasswordGate({ onDone, name }: { onDone: () => void; name: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setError("The two new passwords don't match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await call("/onboarding/me/password", "POST", {
        currentPassword: current,
        newPassword: next,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change it");
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--background)] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Welcome, {name.split(" ")[0]}
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          HR chose your current password, so they know it. Set your own before you
          go any further.
        </p>

        <form
          onSubmit={submit}
          className="mt-6 space-y-4 rounded-2xl bg-white shadow-[var(--shadow-card)] p-6"
        >
          <Field label="Current password">
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoFocus
              className="w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-500"
            />
          </Field>
          <Field label="New password">
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-500"
            />
          </Field>
          <Field label="Confirm new password">
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-500"
            />
          </Field>

          {error && (
            <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || next.length < 8}
            className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Set my password"}
          </button>
        </form>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </label>
      {children}
    </div>
  );
}