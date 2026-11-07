"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, getToken } from "@/lib/api";

type Offer = {
  id: string;
  status: string;
  roleTitle: string;
  joiningDate: string;
  html: string;
  expiresAt: string | null;
  respondedAt: string | null;
};

export default function OfferPage() {
  const router = useRouter();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ offer: Offer | null }>("/offers/me");
      setOffer(res?.offer ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your offer");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    load();
  }, [router, load]);

  async function respond(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await apiPost<{ offer: Offer | null }>(
        `/offers/me/${offer!.id}/respond`,
        { accept, reason: accept ? undefined : reason.trim() }
      );
      setOffer(res?.offer ?? null);
      if (accept) setTimeout(() => router.replace("/onboarding"), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that");
    } finally {
      setBusy(false);
      setDeclining(false);
    }
  }

  if (!loaded) {
    return (
      <main className="min-h-screen bg-[var(--background)] p-8">
        <div className="mx-auto max-w-2xl">
          <div className="skeleton h-8 w-48" />
          <div className="skeleton mt-6 h-96" />
        </div>
      </main>
    );
  }

  if (!offer) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#F3F7F6] px-4">
        <div className="max-w-sm text-center">
          <p className="text-sm text-slate-600">
            There&apos;s no offer waiting for you.
          </p>
          <a
            href="/dashboard"
            className="mt-4 inline-block text-sm text-indigo-600 hover:underline"
          >
            Go to the tracker
          </a>
        </div>
      </main>
    );
  }

  const answered = offer.status !== "SENT";

  return (
    <main className="min-h-screen bg-[var(--background)] px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6">
          <p className="text-sm text-slate-400">Your offer</p>
          <h1 className="mt-0.5 text-2xl font-semibold text-slate-900">
            {offer.roleTitle}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Starting {offer.joiningDate}
            {offer.expiresAt
              ? ` · please reply by ${offer.expiresAt.slice(0, 10)}`
              : ""}
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
            {error}
          </div>
        )}

        {offer.status === "ACCEPTED" && (
          <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <strong>Accepted.</strong> Taking you to your document checklist…
          </div>
        )}
        {offer.status === "DECLINED" && (
          <div className="mb-4 rounded-xl border border-indigo-100 bg-white px-4 py-3 text-sm text-slate-600">
            You declined this offer.
          </div>
        )}

        <article className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
          <div
            className="prose prose-sm max-w-none px-8 py-7 text-slate-800 [&_p]:mb-3 [&_strong]:text-slate-900"
            dangerouslySetInnerHTML={{ __html: offer.html }}
          />
        </article>

        {!answered && (
          <div className="mt-6 rounded-2xl bg-white shadow-[var(--shadow-card)] p-5">
            {!declining ? (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  disabled={busy}
                  onClick={() => respond(true)}
                  className="rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  Accept this offer
                </button>
                <button
                  disabled={busy}
                  onClick={() => setDeclining(true)}
                  className="rounded-xl border border-indigo-100 px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-indigo-50/60 disabled:opacity-40"
                >
                  Decline
                </button>
                <p className="w-full text-xs text-slate-400">
                  Accepting records the date and time, and opens your document
                  checklist.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-slate-700">
                  Sorry to hear it. Would you tell us why?
                </p>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Optional"
                  className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                />
                <div className="flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() => respond(false)}
                    className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
                  >
                    Confirm decline
                  </button>
                  <button
                    onClick={() => setDeclining(false)}
                    className="rounded-xl px-4 py-2 text-sm text-slate-500 hover:text-slate-900"
                  >
                    Go back
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <button
          onClick={() => window.print()}
          className="mt-5 text-xs text-slate-400 hover:text-slate-700"
        >
          Save as PDF
        </button>
      </div>
    </main>
  );
}