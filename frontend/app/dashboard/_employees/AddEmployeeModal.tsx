"use client";

// ===========================================================================
// ADD EMPLOYEE
//
// One person at a time, through the SAME validation and the SAME transaction
// as the spreadsheet import (/admin/employees/preview then /commit), so the
// form can never accept something the import would refuse. The screen checks
// the obvious things instantly; the backend has the final say and its answers
// are shown against the field they belong to.
// ===========================================================================

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Modal } from "./Modal";
import { PendingPhotoPicker, savePendingPhoto } from "../_photos/Avatar";
import { SearchSelect, type Opt } from "./SearchSelect";
import { credentialsCsv, download } from "./files";
import { DAYS, FIELDS, type CommitResult, type Field as FieldName, type Lookups, type Preview } from "./types";

type Form = {
  fullName: string;
  employeeId: string;
  email: string;
  noEmail: boolean;
  mobile: string;
  companyId: string;
  designation: string;
  teamId: string;
  dateOfJoining: string;
  role: string;
  managerId: string;
  projectIds: string[];
  shiftMode: "none" | "existing" | "custom";
  shiftId: string;
  start: string;
  end: string;
  days: number[];
  createShift: boolean;
  onboarding: "EXISTING" | "NEW_JOINER";
};

type ErrKey =
  | "fullName" | "employeeId" | "email" | "mobile" | "companyId" | "designation" | "teamId"
  | "dateOfJoining" | "role" | "managerId" | "projects" | "schedule" | "form";
type Errors = Partial<Record<ErrKey, string>>;

const EMPTY: Form = {
  fullName: "", employeeId: "", email: "", noEmail: false, mobile: "", companyId: "", designation: "",
  teamId: "", dateOfJoining: "", role: "EMPLOYEE", managerId: "", projectIds: [], shiftMode: "none",
  shiftId: "", start: "10:00", end: "19:00", days: [1, 2, 3, 4, 5, 6], createShift: true, onboarding: "NEW_JOINER",
};

import { ROLE_LABEL } from "@/lib/roles";
const ROLE_HELP: Record<string, string> = {
  EMPLOYEE: "Records their own time and proposes daily tasks.",
  MANAGER: "Also approves tasks and sees their team's attendance.",
  HR: "Also adds joiners, collects documents, marks leave and issues payslips.",
  ADMIN: "Full access, including settings and thresholds.",
};

// server field name -> form field the message belongs under
const FIELD_TO_ERR: Partial<Record<FieldName | "row", ErrKey>> = {
  company: "companyId", fullName: "fullName", employeeId: "employeeId", email: "email", mobile: "mobile",
  designation: "designation", team: "teamId", projects: "projects", role: "role", reportsToName: "managerId",
  reportsToId: "managerId", dateOfJoining: "dateOfJoining", shiftStart: "schedule", shiftEnd: "schedule",
  workingDays: "schedule", row: "form",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function Label({ htmlFor, required, children }: { htmlFor?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
      {required && (
        <span className="ml-1 text-rose-500" title="Required" aria-hidden>
          *
        </span>
      )}
    </label>
  );
}

const inputCls = (bad?: boolean) =>
  `w-full rounded-xl border bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:ring-2 focus:ring-[var(--ring)] ${
    bad ? "border-rose-300" : "border-indigo-200 focus:border-indigo-500"
  }`;

function Field({ error, hint, children }: { error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      {children}
      {error ? (
        <p className="mt-1.5 text-xs text-rose-600">{error}</p>
      ) : (
        hint && <p className="mt-1.5 text-xs text-slate-400">{hint}</p>
      )}
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-indigo-100 p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export default function AddEmployeeModal({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoNote, setPhotoNote] = useState("");
  const [result, setResult] = useState<CommitResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    apiGet<Lookups>("/admin/employees/lookups")
      .then((l) => live && setLookups(l))
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, []);

  // Editing a field clears that field's message straight away, so a corrected
  // value is never left sitting under a stale error.
  const ERR_OF: Partial<Record<keyof Form, ErrKey>> = {
    fullName: "fullName", employeeId: "employeeId", email: "email", noEmail: "email", mobile: "mobile",
    companyId: "companyId", designation: "designation", teamId: "teamId", dateOfJoining: "dateOfJoining",
    role: "role", managerId: "managerId", projectIds: "projects", shiftMode: "schedule", shiftId: "schedule",
    start: "schedule", end: "schedule", days: "schedule",
  };
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    const errKey = ERR_OF[key];
    if (errKey) setErrors((e) => (e[errKey] || e.form ? { ...e, [errKey]: undefined, form: undefined } : e));
  };

  const companyId = form.companyId || lookups?.defaultCompanyId || "";
  const company = lookups?.companies.find((c) => c.id === companyId);
  // This company's own list of job titles, when it has one.
  const designationList = (lookups?.designations ?? []).filter((d) => d.platformId === companyId).map((d) => d.name);
  // Every other title used anywhere, so a role set up in one company can be chosen in another. This company's own come first.
  const ownLower = new Set(designationList.map((d) => d.toLowerCase()));
  const otherDesignations = (lookups?.allDesignations ?? []).filter((d) => !ownLower.has(d.toLowerCase()));
  // One fixed list for every company (an enum on the server). Search it; nothing can be typed in that is not on it.
  const designationOpts: Opt[] = [...designationList, ...otherDesignations].map((d) => ({ value: d, label: d }));

  const teams = useMemo(() => (lookups?.teams ?? []).filter((t) => t.platformId === companyId), [lookups, companyId]);
  // A manager may sit in another company, so this list is not filtered by it.
  const managers = useMemo(() => lookups?.managers ?? [], [lookups]);
  const shifts = useMemo(() => (lookups?.shifts ?? []).filter((s) => s.platformId === companyId), [lookups, companyId]);
  const manager = managers.find((m) => m.id === form.managerId);

  const teamOpts: Opt[] = teams.map((t) => ({ value: t.id, label: t.name }));
  const projectOpts: Opt[] = teams.filter((t) => t.id !== form.teamId && !form.projectIds.includes(t.id)).map((t) => ({ value: t.id, label: t.name }));
  const managerOpts: Opt[] = managers.map((m) => ({ value: m.id, label: m.name, sub: [m.employeeCode, ROLE_LABEL[m.role]].filter(Boolean).join(" · ") }));
  const shiftOpts: Opt[] = shifts.map((s) => ({ value: s.id, label: s.name, sub: `${s.startTime}–${s.endTime}` }));
  const companyOpts: Opt[] = (lookups?.companies ?? []).map((c) => ({ value: c.id, label: c.name }));

  // The next ID for the chosen company, shown as soon as it is chosen. Only a preview: the real number is handed out when
  // the person is saved (so two people adding at once never clash).
  const [nextId, setNextId] = useState("");
  useEffect(() => {
    if (!companyId) return;
    let live = true;
    setNextId("");
    apiGet<{ code: string }>(`/admin/employees/next-id?companyId=${companyId}`)
      .then((r) => live && setNextId(r.code))
      .catch(() => live && setNextId(""));
    return () => {
      live = false;
    };
  }, [companyId]);
  // Only an Admin may type an ID by hand (the server enforces it); everyone else sees the generated one, read-only.
  const canTypeId = lookups?.roles.includes("ADMIN") ?? false;

  function changeCompany(id: string) {
    // Teams, managers and shifts belong to a company, so they cannot carry over.
    setForm((f) => ({ ...f, companyId: id, teamId: "", managerId: "", projectIds: [], shiftId: "" }));
    setErrors({});
  }

  // ---- instant checks (the backend repeats and extends all of these) ----------
  function localErrors(): Errors {
    const e: Errors = {};
    if (!form.fullName.trim()) e.fullName = "Full name is required.";
    // A blank ID is fine: the company's next ID is generated when saved.
    if (form.employeeId.trim() && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(form.employeeId.trim())) e.employeeId = "Use letters, numbers, dot, dash or underscore, with no spaces.";
    if (!companyId) e.companyId = "Choose a company.";
    if (!form.designation.trim()) e.designation = "Designation is required.";
    if (!form.email.trim() && !form.noEmail) e.email = "Enter a work email, or tick “No work email”.";
    if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) e.email = "That doesn't look like an email address.";
    if (form.mobile.trim() && !/^\+?\d{10,15}$/.test(form.mobile.replace(/[\s\-().]/g, ""))) e.mobile = "Enter 10 to 15 digits, with an optional +.";
    if (form.shiftMode === "custom") {
      if (!form.start || !form.end) e.schedule = "Set both the start and end time.";
      else if (form.end <= form.start) e.schedule = "The shift must end after it starts.";
      else if (form.days.length === 0) e.schedule = "Pick at least one working day.";
    }
    if (form.shiftMode === "existing" && !form.shiftId) e.schedule = "Choose a shift, or pick “No shift”.";
    return e;
  }

  function buildRequest() {
    const roleName = ROLE_LABEL[form.role] ?? form.role;
    const picked = shifts.find((s) => s.id === form.shiftId);
    const start = form.shiftMode === "existing" ? picked?.startTime : form.shiftMode === "custom" ? form.start : "";
    const end = form.shiftMode === "existing" ? picked?.endTime : form.shiftMode === "custom" ? form.end : "";
    const days =
      form.shiftMode === "existing"
        ? (picked?.workingDays ?? [])
        : form.shiftMode === "custom"
          ? form.days
          : [];
    const dayNames = DAYS.filter((d) => days.includes(d.n)).map((d) => d.short).join(", ");

    const cells = [
      company?.name ?? "",
      form.fullName.trim(),
      form.employeeId.trim(),
      form.email.trim(),
      form.mobile.trim(),
      form.designation.trim(),
      teams.find((t) => t.id === form.teamId)?.name ?? "",
      form.projectIds.map((id) => teams.find((t) => t.id === id)?.name ?? "").filter(Boolean).join(", "),
      roleName,
      manager ? manager.name : "NONE",
      manager ? (manager.employeeCode ?? "") : "NONE",
      form.dateOfJoining, // YYYY-MM-DD from the date picker
      start ?? "",
      end ?? "",
      dayNames,
    ];
    const mapping = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
    return {
      rows: [{ rowNumber: 1, cells }],
      mapping,
      options: {
        // The form says what each blank means, so these are visible choices:
        blankEmailUsesPlaceholder: form.noEmail,
        blankIdIsGenerated: !form.employeeId.trim(),
        blankTeamIsNone: true, // "Team" is optional here
        createMissingShifts: form.shiftMode === "custom" && form.createShift,
        onboarding: form.onboarding,
      },
    };
  }

  async function save() {
    const local = localErrors();
    setErrors(local);
    if (Object.keys(local).length > 0) return;

    setSaving(true);
    try {
      const req = buildRequest();
      const preview = await apiPost<Preview>("/admin/employees/preview", req);
      const row = preview.rows[0];

      if (row.status === "ALREADY_EXISTS") {
        setErrors({ employeeId: "Someone with this employee ID, company and name already exists." });
        return;
      }
      if (row.status !== "VALID") {
        const next: Errors = {};
        for (const issue of row.issues.filter((i) => i.severity === "error")) {
          const key = FIELD_TO_ERR[issue.field] ?? "form";
          next[key] = next[key] ? `${next[key]} ${issue.message}` : issue.message;
        }
        setErrors(next);
        return;
      }

      const done = await apiPost<CommitResult>("/admin/employees/commit", { ...req, confirm: true, expectedValid: 1 });
      setResult(done);
      // The photo is saved against the new person right after they are created. If that fails the person still exists; they can add it from Edit.
      const note = await savePendingPhoto(done.credentials[0]?.userId, photo);
      setPhotoNote(note ? `The employee was added, but the photo was not saved: ${note} You can add it from Edit employee.` : "");
      onDone(`Added ${form.fullName.trim()}`);
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : "Could not add the employee." });
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // success: the one-time credentials
  // ---------------------------------------------------------------------------
  if (result) {
    const c = result.credentials[0];
    return (
      <Modal
        title="Employee added"
        subtitle={`${c.name} is in ${c.company}.${photoNote ? ` ${photoNote}` : ""}`}
        onClose={onClose}
        width="max-w-xl"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <button
              onClick={() => download(`credentials-${c.employeeId}.csv`, credentialsCsv(result.credentials))}
              className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-indigo-50"
            >
              Download
            </button>
            <button
              onClick={() => {
                setForm({ ...EMPTY, companyId: form.companyId });
                setResult(null);
                setErrors({});
              }}
              className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
            >
              Add another
            </button>
            <button onClick={onClose} className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700">
              Done
            </button>
          </div>
        }
      >
        <div className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800">
          Their account is ready. They must change this temporary password the first time they sign in.
        </div>

        <dl className="mt-5 divide-y divide-indigo-50 rounded-2xl border border-indigo-100 text-sm">
          {[
            ["Employee ID", c.employeeId],
            ["Sign in with", c.signInWith],
            ["Temporary password", c.temporaryPassword],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 px-4 py-3">
              <dt className="text-slate-500">{k}</dt>
              <dd className={`font-medium text-slate-900 ${k === "Temporary password" ? "font-mono tracking-wide" : ""}`}>{v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-4 flex items-start justify-between gap-3 rounded-2xl bg-amber-50 p-4 text-xs leading-relaxed text-amber-800">
          <p>
            This is the only time the password is shown. Only a scrambled copy is stored, so it cannot be looked up
            later. Give it to the employee privately.
            {result.mail.sent > 0 && " A welcome email with these details was also sent."}
            {result.mail.failed > 0 && " The welcome email could not be sent, so give them this by hand."}
            {result.mail.noEmail > 0 && " They have no real email address, so nothing was emailed."}
          </p>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(c.temporaryPassword).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              });
            }}
            className="shrink-0 rounded-lg bg-white px-3 py-1.5 font-medium text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100"
          >
            {copied ? "Copied" : "Copy password"}
          </button>
        </div>
      </Modal>
    );
  }

  // ---------------------------------------------------------------------------
  // the form
  // ---------------------------------------------------------------------------
  return (
    <Modal
      title="Add employee"
      subtitle="Fields marked * are required. Everything is checked again on the server before anything is saved."
      onClose={onClose}
      dismissible={!saving}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">{errors.form ?? ""}</p>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={saving} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-indigo-50 disabled:opacity-50">
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving || !lookups}
              className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white shadow-md shadow-indigo-600/25 transition hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Add employee"}
            </button>
          </div>
        </div>
      }
    >
      {loadError && <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">Couldn&apos;t load the form options: {loadError}</div>}
      {!lookups && !loadError && (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-12" />
          ))}
        </div>
      )}

      {lookups && (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          noValidate
        >
          {errors.form && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{errors.form}</div>}

          <Section title="Profile photo (optional)">
            <PendingPhotoPicker file={photo} onFile={setPhoto} />
          </Section>
          <Section title="Personal and employment details">
            <Field error={errors.fullName}>
              <Label htmlFor="ae-name" required>Full name</Label>
              <input id="ae-name" value={form.fullName} onChange={(e) => set("fullName", e.target.value)} className={inputCls(!!errors.fullName)} placeholder="e.g. Priya Nair" autoComplete="off" />
            </Field>
            <Field error={errors.employeeId} hint={form.employeeId.trim() ? "Typed exactly as given. It is never renumbered." : nextId ? `Next ID${company?.name ? ` for ${company.name}` : ""}: ${nextId}. It is assigned automatically when you save${canTypeId ? " (you can type a different one)" : ""}.` : `The next ID${company?.name ? ` for ${company.name}` : ""} is generated automatically when you save.`}>
              <Label htmlFor="ae-id">Employee ID</Label>
              <input id="ae-id" value={canTypeId ? form.employeeId : form.employeeId || nextId} readOnly={!canTypeId} onChange={(e) => set("employeeId", e.target.value)} className={`${inputCls(!!errors.employeeId)} ${canTypeId ? "" : "bg-slate-50 text-slate-600"}`} placeholder={nextId || "Generated automatically"} autoComplete="off" />
            </Field>
            <Field error={errors.email} hint={form.noEmail ? "They will sign in with their employee ID." : undefined}>
              <Label htmlFor="ae-email" required={!form.noEmail}>Work email</Label>
              <input id="ae-email" type="email" value={form.email} disabled={form.noEmail} onChange={(e) => set("email", e.target.value)} className={`${inputCls(!!errors.email)} disabled:bg-slate-50`} placeholder="name@company.com" autoComplete="off" />
              <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={form.noEmail} onChange={(e) => { set("noEmail", e.target.checked); if (e.target.checked) set("email", ""); }} className="h-4 w-4 rounded border-indigo-300 text-indigo-600" />
                No work email: sign in with the employee ID
              </label>
            </Field>
            <Field error={errors.mobile}>
              <Label htmlFor="ae-mobile">Mobile number</Label>
              <input id="ae-mobile" inputMode="tel" value={form.mobile} onChange={(e) => set("mobile", e.target.value)} className={inputCls(!!errors.mobile)} placeholder="98765 43210" autoComplete="off" />
            </Field>
            <Field error={errors.companyId} hint={lookups.companies.length === 1 ? "You can add people to your own company." : undefined}>
              <Label htmlFor="ae-company" required>Company</Label>
              <SearchSelect id="ae-company" options={companyOpts} value={companyId} onChange={changeCompany} disabled={lookups.companies.length === 1} invalid={!!errors.companyId} placeholder="Search companies…" />
            </Field>
            <Field error={errors.designation}>
              <Label htmlFor="ae-designation" required>Designation</Label>
              <SearchSelect id="ae-designation" options={designationOpts} value={form.designation} onChange={(v) => set("designation", v)} invalid={!!errors.designation} placeholder="Search designations…" clearLabel="Not assigned" emptyText="No designation matches" />
            </Field>
            <Field error={errors.teamId} hint={teams.length === 0 ? "This company has no teams yet. Add one in Admin → Teams." : "Optional. Their main team."}>
              <Label htmlFor="ae-team">Team / Department</Label>
              <SearchSelect id="ae-team" options={teamOpts} value={form.teamId} onChange={(v) => set("teamId", v)} clearLabel="No team" placeholder="Search teams…" />
            </Field>
            <Field error={errors.dateOfJoining}>
              <Label htmlFor="ae-doj">Date of joining</Label>
              <input id="ae-doj" type="date" value={form.dateOfJoining} onChange={(e) => set("dateOfJoining", e.target.value)} className={inputCls(!!errors.dateOfJoining)} />
            </Field>
          </Section>

          <Section title="Organization and access" sub="Who they report to and what they can do in the tracker.">
            <Field error={errors.role} hint={ROLE_HELP[form.role]}>
              <Label htmlFor="ae-role" required>System role</Label>
              <select id="ae-role" value={form.role} onChange={(e) => set("role", e.target.value)} className={inputCls(!!errors.role)}>
                {lookups.roles.map((r) => (
                  <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>
                ))}
              </select>
              {lookups.roles.length < 4 && <p className="mt-1.5 text-xs text-slate-400">Only an Admin can create HR or Admin accounts.</p>}
            </Field>
            <Field error={errors.managerId} hint="Optional. They approve this person's tasks and see their attendance.">
              <Label htmlFor="ae-manager">Reporting manager</Label>
              <SearchSelect id="ae-manager" options={managerOpts} value={form.managerId} onChange={(v) => set("managerId", v)} clearLabel="No reporting manager (top of the chain)" placeholder="Search by name or ID…" invalid={!!errors.managerId} />
            </Field>
            <Field>
              <Label htmlFor="ae-mgrid">Reporting manager employee ID</Label>
              <input id="ae-mgrid" readOnly value={manager?.employeeCode ?? ""} placeholder="Filled in when you pick a manager" className={`${inputCls()} bg-slate-50 text-slate-600`} />
            </Field>
            <Field error={errors.projects} hint="Optional. Extra projects (teams) beyond their main team.">
              <Label htmlFor="ae-projects">Projects</Label>
              <SearchSelect id="ae-projects" options={projectOpts} value="" onChange={(v) => v && set("projectIds", [...form.projectIds, v])} placeholder={projectOpts.length ? "Add a project…" : "No more projects to add"} disabled={projectOpts.length === 0} />
              {form.projectIds.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {form.projectIds.map((id) => (
                    <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
                      {teams.find((t) => t.id === id)?.name}
                      <button type="button" aria-label="Remove project" onClick={() => set("projectIds", form.projectIds.filter((p) => p !== id))} className="text-indigo-400 hover:text-indigo-700">×</button>
                    </span>
                  ))}
                </div>
              )}
            </Field>
            <div className="sm:col-span-2">
              <Label>How should they start?</Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {([
                  ["NEW_JOINER", "New joiner", "Document onboarding first; the tracker opens when HR approves their papers. A welcome email goes to a real address."],
                  ["EXISTING", "Existing employee", "Already works here. The tracker opens straight away after they set their own password."],
                ] as const).map(([value, title, detail]) => (
                  <label key={value} className={`cursor-pointer rounded-xl border p-3.5 text-sm transition ${form.onboarding === value ? "border-indigo-500 bg-indigo-50/60" : "border-indigo-100 hover:bg-indigo-50/40"}`}>
                    <span className="flex items-center gap-2 font-medium text-slate-900">
                      <input type="radio" name="ae-onboarding" checked={form.onboarding === value} onChange={() => set("onboarding", value)} className="h-4 w-4 text-indigo-600" />
                      {title}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-slate-500">{detail}</span>
                  </label>
                ))}
              </div>
            </div>
          </Section>

          <Section title="Working schedule" sub="Used for shift-based attendance. Leave it as “No shift” to set it later.">
            <div className="sm:col-span-2">
              <div className="inline-flex flex-wrap gap-1 rounded-xl bg-[#F1F2FC] p-1 text-sm">
                {([["none", "No shift"], ["existing", "Existing shift"], ["custom", "Custom hours"]] as const).map(([v, t]) => (
                  <button key={v} type="button" onClick={() => set("shiftMode", v)} className={`rounded-lg px-3.5 py-1.5 font-medium transition ${form.shiftMode === v ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {form.shiftMode === "existing" && (
              <Field error={errors.schedule}>
                <Label htmlFor="ae-shift" required>Shift</Label>
                <SearchSelect id="ae-shift" options={shiftOpts} value={form.shiftId} onChange={(v) => set("shiftId", v)} placeholder="Search shifts…" invalid={!!errors.schedule} emptyText="This company has no shifts yet" />
              </Field>
            )}

            {form.shiftMode === "custom" && (
              <>
                <Field>
                  <Label htmlFor="ae-start" required>Shift start time</Label>
                  <input id="ae-start" type="time" value={form.start} onChange={(e) => set("start", e.target.value)} className={inputCls(!!errors.schedule)} />
                </Field>
                <Field>
                  <Label htmlFor="ae-end" required>Shift end time</Label>
                  <input id="ae-end" type="time" value={form.end} onChange={(e) => set("end", e.target.value)} className={inputCls(!!errors.schedule)} />
                </Field>
                <div className="sm:col-span-2">
                  <Label required>Working days</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {DAYS.map((d) => {
                      const on = form.days.includes(d.n);
                      return (
                        <button key={d.n} type="button" aria-pressed={on} onClick={() => set("days", on ? form.days.filter((x) => x !== d.n) : [...form.days, d.n])} className={`w-12 rounded-xl py-2 text-sm font-medium transition ${on ? "bg-indigo-600 text-white shadow-sm" : "bg-[#F1F2FC] text-slate-600 hover:bg-indigo-100"}`}>
                          {d.short}
                        </button>
                      );
                    })}
                  </div>
                  {errors.schedule && <p className="mt-1.5 text-xs text-rose-600">{errors.schedule}</p>}
                  <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
                    <input type="checkbox" checked={form.createShift} onChange={(e) => set("createShift", e.target.checked)} className="h-4 w-4 rounded border-indigo-300 text-indigo-600" />
                    Create this shift for {company?.name ?? "the company"} if it doesn&apos;t exist yet
                  </label>
                </div>
              </>
            )}

            <div className="rounded-xl bg-[#F6F7FE] px-4 py-3 text-xs leading-relaxed text-slate-600 sm:col-span-2">
              {company ? (
                company.holidaysThisYear > 0 ? (
                  <>{company.name} has <b>{company.holidaysThisYear}</b> company holiday{company.holidaysThisYear === 1 ? "" : "s"} set up for {lookups.year}. They apply automatically to everyone in the company.</>
                ) : (
                  <>{company.name} has no holidays set up for {lookups.year} yet. Add them under Holidays so attendance targets are fair.</>
                )
              ) : (
                "Choose a company to see its holiday calendar."
              )}
            </div>
          </Section>
        </form>
      )}
    </Modal>
  );
}
