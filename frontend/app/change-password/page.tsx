"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, clearToken, getToken } from "@/lib/api";

// Outside /dashboard on purpose: somebody who must change their password
// should not see the app behind this screen.
export default function ChangePasswordPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  // true = HR/the system made them come here (no way out until they choose a password); false = they opened it themselves.
  const [forced, setForced] = useState(true);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    apiGet<{ firstName: string; mustChangePassword?: boolean }>("/auth/me")
      .then((m) => {
        setName(m.firstName);
        setForced(m.mustChangePassword !== false);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (next.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("The two new passwords don't match.");
      return;
    }
    if (next === current) {
      setError("Choose something different from the temporary one.");
      return;
    }

    setBusy(true);
    try {
      // A superset body — the endpoint reads the field names it expects and
      // ignores the rest.
      await apiPost("/onboarding/me/password", {
        currentPassword: current,
        oldPassword: current,
        newPassword: next,
        confirmPassword: confirm,
      });
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change it");
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F3F7F6] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-7">
          {!forced && (
            <button
              type="button"
              onClick={() => router.push("/dashboard")}
              aria-label="Cancel and go back"
              className="float-right -mr-1 rounded-full p-1.5 text-slate-400 transition hover:bg-indigo-50 hover:text-slate-700"
            >
              <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="m5 5 10 10M15 5 5 15" strokeLinecap="round" />
              </svg>
            </button>
          )}
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600">
            <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" className="h-5 w-5">
              <rect x="4" y="10" width="16" height="10" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            {forced ? (name ? `Welcome, ${name}` : "Set your password") : "Change your password"}
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">
            {forced
              ? "Choose your own password before you start. The temporary one stops working straight away, so nobody else can use it."
              : "Enter your current password, then choose a new one."}
          </p>
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-2xl bg-white p-6 shadow-[var(--shadow-card)]"
        >
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
              {forced ? "Temporary password" : "Current password"}
            </label>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoFocus
              autoComplete="current-password"
              className="w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
              New password
            </label>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              autoComplete="new-password"
              className="w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
            <p className="mt-1.5 text-xs text-slate-400">At least 8 characters.</p>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-500">
              Repeat it
            </label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
              className="w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500"
            />
          </div>

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !current || !next || !confirm}
            className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            {busy ? "Saving..." : forced ? "Set password and continue" : "Change password"}
          </button>
          {!forced && (
            <button
              type="button"
              onClick={() => router.push("/dashboard")}
              className="w-full rounded-xl border border-indigo-100 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          )}
        </form>

        {forced && (
          <button
            onClick={() => {
              clearToken();
              router.replace("/login");
            }}
            className="mt-5 w-full text-center text-xs text-slate-400 hover:text-slate-600"
          >
            Sign out
          </button>
        )}
      </div>
    </main>
  );
}