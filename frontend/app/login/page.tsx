// ===========================================================================
// LOGIN
//
// This is the only page that works without a token. Everything else in the
// app redirects here when getToken() comes back empty.
//
// The server deliberately returns the same error for "no such email" and
// "wrong password". Telling them apart would let someone discover which
// email addresses exist — that's called email enumeration.
// ===========================================================================

"use client";

import { useEffect, useState } from "react";
import { homeFor } from "@/lib/roleHome";
import { getDemoInfo, type DemoInfo } from "@/lib/demo";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, getToken, setToken, LOGIN_NOTICE_KEY } from "@/lib/api";

const WRONG = "Email or password is incorrect";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false); // hidden by default; only changes how it is displayed
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [failures, setFailures] = useState(0); // wrong-password answers in this visit, only to decide how much help to show
  const [capsOn, setCapsOn] = useState(false);
  const [help, setHelp] = useState(false);
  const [demo, setDemo] = useState<DemoInfo | null>(null);
  useEffect(() => { void getDemoInfo().then(setDemo); }, []);

  // Already signed in? Don't make them log in again.
  useEffect(() => {
    if (getToken()) router.replace("/dashboard");
  }, [router]);

  // A session that was refused because of the network it came from leaves its message here (see lib/api.ts).
  useEffect(() => {
    try {
      const notice = sessionStorage.getItem(LOGIN_NOTICE_KEY);
      if (notice) {
        sessionStorage.removeItem(LOGIN_NOTICE_KEY);
        setError(notice);
      }
    } catch { /* nothing to show */ }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // The ID or email is trimmed (a pasted trailing space is never meant). The password is sent EXACTLY as typed: it may legitimately contain spaces.
      const result = await apiPost<{ token: string }>(demo ? "/demo/login" : "/auth/login", {
        email: email.trim(),
        password,
      });
      setToken(result.token);
      // The role comes from the server (never from the form); each role has its own home address.
      let home = "/dashboard";
      try {
        const me = await apiGet<{ role: string; supervisor?: boolean }>("/auth/me");
        home = homeFor(me.role, me.supervisor);
      } catch {
        // /dashboard works too: it sends the person to their own home once the page knows who they are
      }
      router.push(home);
    } catch (err) {
      const wrong = err instanceof Error && err.message === WRONG;
      if (wrong) setFailures((n) => n + 1);
      setError(err instanceof Error ? err.message : "Could not sign in");
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--background)] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Brand mark */}
        <div className="mb-8">
          <div className="h-11 w-11 rounded-xl bg-indigo-600 flex items-center justify-center mb-5">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-5 w-5"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Avatar HRMS
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Sign in to start your day
          </p>
          {demo && (
            <p data-testid="demo-login-note" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <b>DEMO MODE.</b> Every record is fictional. Sign in with the demo username and password you were given, then switch between Admin, HR, Manager and Employee from the bar at the bottom.
            </p>
          )}
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl bg-white p-6 shadow-[var(--shadow-card)] space-y-4"
        >
                   <div>
            <label
              htmlFor="email"
              className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1.5"
            >
              Username, employee ID or email
            </label>
            <input
              id="email"
              // NOT type="email" — the browser would reject "AWL-01" before
              // the form ever submits, and nobody in the group has a work
              // email address. The server decides: anything containing "@"
              // is treated as an email, anything else as an employee ID.
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              autoCorrect="off"
              placeholder="AWL-03, yourname_avatar or name@company.com"
              className="w-full rounded-xl border border-indigo-200 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            />
            <p className="mt-1.5 text-xs text-slate-400">
              Use the username your company gave you, or your employee ID.
            </p>
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1.5"
            >
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                // phones must not capitalise or "correct" a password
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onKeyUp={(e) => setCapsOn(e.getModifierState?.("CapsLock") ?? false)}
                onBlur={() => setCapsOn(false)}
                aria-describedby={capsOn ? "caps-warning" : undefined}
                className="w-full rounded-xl border border-indigo-200 py-2.5 pl-3 pr-11 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                aria-controls="password"
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-slate-400 transition hover:text-slate-600 focus:outline-none focus-visible:text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500/30"
              >
                {showPassword ? (
                  /* Eye off */
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
                    <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
                    <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
                    <path d="m2 2 20 20" />
                  </svg>
                ) : (
                  /* Eye */
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            {capsOn && (
              <p id="caps-warning" className="mt-1.5 text-xs font-medium text-amber-700">Caps Lock is on.</p>
            )}
          </div>

          {error && (
            <div role="alert" aria-live="assertive" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
              {error}
              {error === WRONG && (
                <span className="mt-1 block text-xs text-rose-600">
                  Check your employee ID and password. If you changed your temporary password, use the new one.
                  {password !== password.trim() ? " Your password has a space at the start or end: remove it." : ""}
                  {failures >= 2 ? " Still stuck? Ask HR to reset your password." : ""}
                </span>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-slate-500">
          <button type="button" onClick={() => setHelp((v) => !v)} aria-expanded={help} className="font-medium text-indigo-600 hover:underline">
            Forgot your password or can&apos;t sign in?
          </button>
          {help && (
            <div className="mt-3 rounded-xl bg-white p-4 text-left shadow-[var(--shadow-card)]" data-testid="signin-help">
              <p className="font-medium text-slate-700">How to get back in</p>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                <li>Type your employee ID exactly as HR gave it (for example AWL-03). Capitals and spaces around it do not matter.</li>
                <li>If HR gave you a temporary password and you already changed it, use the NEW one: the temporary one stops working.</li>
                <li>Passwords are case-sensitive. Use the eye icon to check what you typed.</li>
                <li>Forgotten it? Ask HR to reset your password. You will be asked to choose a new one when you sign in.</li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}