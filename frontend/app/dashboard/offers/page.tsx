"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { useMe } from "../layout";

// ---------------------------------------------------------------------------
// OFFER LETTERS — HR
// Edit the template once; every offer is that template with the candidate's
// details filled in. The letter is snapshotted when created, so editing the
// template later never changes a letter somebody has already accepted.
// ---------------------------------------------------------------------------

type Template = {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
  emailIntro: string | null;
  isDefault: boolean;
  version: number;
};

type Candidate = {
  id: string;
  name: string;
  email: string;
  employeeCode: string | null;
  designation: string | null;
  onboardingStatus: string;
};

type Preview = {
  id: string;
  status: string;
  roleTitle: string;
  joiningDate: string;
  html: string;
  candidate: { firstName: string; lastName: string; email: string };
};

const MESSAGES: Record<string, string> = {
  MISSING_FIELDS: "Fill in the name, subject and body.",
  BAD_DATE: "Pick a joining date.",
  OFFER_ALREADY_OPEN: "That person already has an offer in progress.",
  NO_REAL_EMAIL:
    "That person has no real email address, so nothing can be sent. Add one in Admin first.",
  ALREADY_SENT: "This offer has already gone out.",
  NOT_ALLOWED: "Only HR and Admin can send offers.",
};

const say = (e: unknown) => {
  const c = e instanceof Error ? e.message : "UNKNOWN";
  return MESSAGES[c] ?? "Something went wrong.";
};

export default function OffersPage() {
  const me = useMe();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [placeholders, setPlaceholders] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);

  const [editing, setEditing] = useState<Template | null>(null);
  const [tab, setTab] = useState<"send" | "template">("send");

  const [form, setForm] = useState({
    candidateId: "",
    roleTitle: "",
    joiningDate: "",
    ctcAnnual: "",
    reportingTo: "",
    expiresAt: "",
  });

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        apiGet<{ templates: Template[]; placeholders: string[] }>(
          "/offers/templates"
        ),
        apiGet<Candidate[]>("/onboarding/candidates").catch(() => []),
      ]);
      setTemplates(t.templates ?? []);
      setPlaceholders(t.placeholders ?? []);
      setCandidates(Array.isArray(c) ? c : []);
      setEditing((e) => e ?? t.templates?.[0] ?? null);
      setError("");
    } catch (err) {
      setError(say(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createOffer() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await apiPost<{ offerId: string; html: string }>("/offers", {
        candidateId: form.candidateId,
        roleTitle: form.roleTitle.trim(),
        joiningDate: form.joiningDate,
        ctcAnnual: form.ctcAnnual || null,
        reportingTo: form.reportingTo.trim() || null,
        expiresAt: form.expiresAt || null,
        templateId: templates.find((t) => t.isDefault)?.id ?? templates[0]?.id,
      });
      setPreview(await apiGet<Preview>(`/offers/${res.offerId}`));
      setNotice("Draft ready — read it before sending.");
    } catch (err) {
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!preview) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await apiPost<{
        sent: boolean;
        to: string;
        temporaryPassword: string | null;
        reason: string | null;
      }>(`/offers/${preview.id}/send`);

      if (res.sent) {
        setNotice(`Sent to ${res.to}.`);
      } else {
        // Email isn't configured yet, so hand HR the password rather than
        // leaving the candidate unable to sign in.
        setNotice(
          `Email could not be sent (${res.reason}). Give them this by hand — login ${res.to}, password ${res.temporaryPassword}`
        );
      }
      setPreview(await apiGet<Preview>(`/offers/${preview.id}`));
      await load();
    } catch (err) {
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate() {
    if (!editing) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await apiPost<{ templates: Template[] }>("/offers/templates", {
        id: editing.id,
        name: editing.name,
        subject: editing.subject,
        bodyHtml: editing.bodyHtml,
        emailIntro: editing.emailIntro,
      });
      setTemplates(res.templates ?? []);
      setNotice("Template saved. Offers already sent keep their own copy.");
    } catch (err) {
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  if (!me) return null;

  const canCreate =
    form.candidateId !== "" &&
    form.roleTitle.trim() !== "" &&
    form.joiningDate !== "";

  return (
    <div>
      <header className="mb-6">
        <p className="text-sm text-slate-400">HR</p>
        <h1 className="mt-0.5 text-2xl font-semibold text-slate-900">
          Offer letters
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Write the template once. Each offer fills it in with the
          candidate&apos;s details and keeps its own copy, so editing the
          template later never changes a letter someone has already accepted.
        </p>
      </header>

      <div className="mb-6 flex gap-1 rounded-xl border border-indigo-100 bg-white p-1">
        {(["send", "template"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium ${
              tab === t
                ? "bg-indigo-600 text-white"
                : "text-slate-500 hover:text-slate-900"
            }`}
          >
            {t === "send" ? "Send an offer" : "Edit the template"}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      {tab === "send" && (
        <>
          <section className="mb-6 rounded-2xl bg-white shadow-[var(--shadow-card)] p-5">
            <h2 className="mb-4 text-sm font-medium text-slate-900">
              Who is it for?
            </h2>

            {candidates.length === 0 ? (
              <p className="text-sm text-slate-500">
                No candidates yet. Create one in <strong>Admin → People</strong>{" "}
                without ticking &ldquo;existing employee&rdquo;, and they appear
                here.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="mb-1.5 block text-xs text-slate-500">
                    Candidate
                  </label>
                  <select
                    value={form.candidateId}
                    onChange={(e) =>
                      setForm({ ...form, candidateId: e.target.value })
                    }
                    className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900"
                  >
                    <option value="">Choose…</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.email}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs text-slate-500">
                    Position
                  </label>
                  <input
                    value={form.roleTitle}
                    onChange={(e) =>
                      setForm({ ...form, roleTitle: e.target.value })
                    }
                    placeholder="Graphic Designer"
                    className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs text-slate-500">
                    Joining date
                  </label>
                  <input
                    type="date"
                    value={form.joiningDate}
                    onChange={(e) =>
                      setForm({ ...form, joiningDate: e.target.value })
                    }
                    className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs text-slate-500">
                    Annual CTC (optional)
                  </label>
                  <input
                    value={form.ctcAnnual}
                    onChange={(e) =>
                      setForm({ ...form, ctcAnnual: e.target.value })
                    }
                    placeholder="480000"
                    inputMode="numeric"
                    className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs text-slate-500">
                    Reporting to (optional)
                  </label>
                  <input
                    value={form.reportingTo}
                    onChange={(e) =>
                      setForm({ ...form, reportingTo: e.target.value })
                    }
                    placeholder="Roshan Sharma"
                    className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400"
                  />
                </div>

                <div className="sm:col-span-2">
                  <button
                    disabled={busy || !canCreate}
                    onClick={createOffer}
                    className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
                  >
                    {busy ? "Working…" : "Prepare the letter"}
                  </button>
                </div>
              </div>
            )}
          </section>

          {preview && (
            <section className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-50 px-5 py-3.5">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    {preview.candidate.firstName} {preview.candidate.lastName}
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {preview.roleTitle} · joining {preview.joiningDate} ·{" "}
                    {preview.candidate.email}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      preview.status === "ACCEPTED"
                        ? "bg-emerald-50 text-emerald-700"
                        : preview.status === "SENT"
                        ? "bg-sky-50 text-sky-700"
                        : "bg-[#E7F6F1] text-slate-600"
                    }`}
                  >
                    {preview.status.toLowerCase()}
                  </span>
                  {preview.status === "DRAFT" && (
                    <button
                      disabled={busy}
                      onClick={send}
                      className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
                    >
                      Send it
                    </button>
                  )}
                </div>
              </div>

              <div
                className="prose prose-sm max-w-none px-7 py-6 text-slate-800 [&_p]:mb-3"
                dangerouslySetInnerHTML={{ __html: preview.html }}
              />

              {preview.status === "DRAFT" && (
                <p className="border-t border-indigo-50 px-5 py-3 text-xs text-slate-400">
                  Sending issues them a fresh temporary password and emails it
                  with this letter. Read it first — once sent, this copy is
                  fixed.
                </p>
              )}
            </section>
          )}
        </>
      )}

      {tab === "template" && editing && (
        <section className="rounded-2xl bg-white shadow-[var(--shadow-card)] p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-slate-900">
              {editing.name}{" "}
              <span className="text-xs font-normal text-slate-400">
                version {editing.version}
              </span>
            </h2>
            <button
              disabled={busy}
              onClick={saveTemplate}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              Save
            </button>
          </div>

          <div className="mb-4 rounded-xl bg-[#F3F7F6] px-4 py-3">
            <p className="mb-2 text-xs font-medium text-slate-700">
              Drop any of these into the letter and they fill themselves in:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {placeholders.map((p) => (
                <code
                  key={p}
                  className="rounded bg-white px-2 py-0.5 text-[11px] text-indigo-700 ring-1 ring-slate-200"
                >
                  {`{{${p}}}`}
                </code>
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs text-slate-500">
                Email subject
              </label>
              <input
                value={editing.subject}
                onChange={(e) =>
                  setEditing({ ...editing, subject: e.target.value })
                }
                className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-slate-500">
                Covering note in the email
              </label>
              <input
                value={editing.emailIntro ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, emailIntro: e.target.value })
                }
                className="w-full rounded-xl border border-indigo-100 px-3 py-2 text-sm text-slate-900"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs text-slate-500">
                The letter itself — basic HTML
              </label>
              <textarea
                value={editing.bodyHtml}
                onChange={(e) =>
                  setEditing({ ...editing, bodyHtml: e.target.value })
                }
                rows={14}
                spellCheck={false}
                className="w-full rounded-xl border border-indigo-100 px-3 py-2 font-mono text-xs leading-relaxed text-slate-900"
              />
            </div>
          </div>
        </section>
      )}
    </div>
  );
}