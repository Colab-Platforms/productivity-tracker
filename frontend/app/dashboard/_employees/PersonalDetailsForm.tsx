"use client";

// Edit employee > "Personal details" (HR / Admin only; the server enforces it, and says "not found" to anyone else). Holds what the profile could not store before:
// gender, date of birth, marital status, secondary contact, address and a few work labels. It saves on its own (own button), separately from the rest of the form.
// A blank box LEAVES the stored value as it is (never erases); the small "clear" link removes a value on purpose. Every message comes from the server.
import { useEffect, useState } from "react";
import { apiGet, apiPut } from "@/lib/api";

type Values = Record<string, string | null>;
type Loaded = { ready: boolean; canEdit: boolean; entered: boolean; values: Values };
const KEYS = ["gender", "dateOfBirth", "maritalStatus", "secondaryPhoneCode", "secondaryPhone", "addressLine1", "addressLine2", "city", "state", "country", "employeeStatusType", "reportingOffice", "grade", "vertical", "phoneCode", "department", "extraField1", "extraField2", "extraField3", "extraField4", "extraField5", "notes"] as const;
type Key = (typeof KEYS)[number];

const field = "mt-1 w-full rounded-xl border border-indigo-100 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500 disabled:bg-slate-50";
const label = "block text-xs font-medium text-slate-600";

export default function PersonalDetailsForm({ userId, name }: { userId: string; name: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [form, setForm] = useState<Values>({});
  const [cleared, setCleared] = useState<Set<Key>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [bad, setBad] = useState<Record<string, string>>({});

  const load = () => apiGet<Loaded>(`/personal-details/${userId}`).then((r) => { setLoaded(r); setForm(r.values); setCleared(new Set()); }).catch(() => setLoaded(null));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [userId]);

  if (!loaded) return null;
  const set = (k: Key, v: string) => { setForm((f) => ({ ...f, [k]: v })); setCleared((c) => { const n = new Set(c); n.delete(k); return n; }); setBad((b) => ({ ...b, [k]: "" })); };
  const stored = (k: Key) => loaded.values[k];

  async function save() {
    setBusy(true);
    setNote(null);
    setBad({});
    try {
      const body: Record<string, string | null> = {};
      for (const k of KEYS) {
        if (cleared.has(k)) body[k] = null;
        else if (form[k] && String(form[k]).trim() !== "" && form[k] !== loaded!.values[k]) body[k] = String(form[k]);
      }
      if (Object.keys(body).length === 0) { setNote({ text: "Nothing to save: no field was changed.", error: false }); return; }
      const r = await apiPut<{ changed: string[]; unchanged: boolean }>(`/personal-details/${userId}`, body);
      setNote({ text: r.unchanged ? "Nothing changed." : `Saved: ${r.changed.join(", ")}.`, error: false });
      await load();
    } catch (e) {
      const err = e as Error & { data?: { fields?: { field: string; message: string }[] } };
      const map: Record<string, string> = {};
      for (const f of err.data?.fields ?? []) map[f.field] = f.message;
      setBad(map);
      setNote({ text: err.message || "Could not save.", error: true });
    } finally {
      setBusy(false);
    }
  }

  const Clear = ({ k }: { k: Key }) => (stored(k) && !cleared.has(k) ? (
    <button type="button" onClick={() => { setCleared((c) => new Set(c).add(k)); setForm((f) => ({ ...f, [k]: "" })); }} className="ml-2 text-[11px] font-normal text-slate-400 hover:text-rose-600" data-testid={`clear-${k}`}>clear</button>
  ) : cleared.has(k) ? <span className="ml-2 text-[11px] font-normal text-rose-600">will be removed</span> : null);
  const Err = ({ k }: { k: Key }) => (bad[k] ? <span className="mt-1 block text-xs text-rose-600" data-testid={`err-${k}`}>{bad[k]}</span> : null);
  const disabled = !loaded.canEdit || busy;
  const text = (k: Key, title: string, ph?: string) => (
    <label className={label}>{title}<Clear k={k} /><input value={form[k] ?? ""} onChange={(e) => set(k, e.target.value)} disabled={disabled} placeholder={stored(k) ? "" : ph} data-testid={`pd-${k}`} className={field} /><Err k={k} /></label>
  );

  return (
    <section className="mt-6 border-t border-indigo-100 pt-5" data-testid="personal-details" aria-label={`Personal details of ${name}`}>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Personal details</p>
      <p className="mb-3 text-xs text-slate-400">Private to the employee, HR and Admin. A blank box leaves the saved value as it is; use “clear” to remove one on purpose.</p>
      {!loaded.ready ? (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="pd-not-ready">Personal details cannot be saved on this server yet (the database update has not been applied).</p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className={label}>Gender<Clear k="gender" />
              <select value={form.gender ?? ""} onChange={(e) => set("gender", e.target.value)} disabled={disabled} data-testid="pd-gender" className={field}>
                <option value="">Not provided</option><option value="MALE">Male</option><option value="FEMALE">Female</option><option value="OTHER">Other</option>
              </select><Err k="gender" /></label>
            <label className={label}>Date of birth<Clear k="dateOfBirth" /><input type="date" value={form.dateOfBirth ?? ""} onChange={(e) => set("dateOfBirth", e.target.value)} disabled={disabled} data-testid="pd-dateOfBirth" className={field} /><Err k="dateOfBirth" /></label>
            <label className={label}>Marital status<Clear k="maritalStatus" />
              <select value={form.maritalStatus ?? ""} onChange={(e) => set("maritalStatus", e.target.value)} disabled={disabled} data-testid="pd-maritalStatus" className={field}>
                <option value="">Not provided</option><option value="SINGLE">Single / unmarried</option><option value="MARRIED">Married</option><option value="DIVORCED">Divorced</option><option value="WIDOWED">Widowed</option>
              </select><Err k="maritalStatus" /></label>
          </div>
          <div className="grid gap-3 sm:grid-cols-[6rem_1fr]">
            {text("secondaryPhoneCode", "Secondary phone code", "91")}
            {text("secondaryPhone", "Secondary contact number")}
          </div>
          <label className={label}>Address line 1<Clear k="addressLine1" /><textarea rows={2} value={form.addressLine1 ?? ""} onChange={(e) => set("addressLine1", e.target.value)} disabled={disabled} data-testid="pd-addressLine1" className={`${field} resize-y break-words`} /><Err k="addressLine1" /></label>
          <label className={label}>Address line 2<Clear k="addressLine2" /><textarea rows={2} value={form.addressLine2 ?? ""} onChange={(e) => set("addressLine2", e.target.value)} disabled={disabled} data-testid="pd-addressLine2" className={`${field} resize-y break-words`} /><Err k="addressLine2" /></label>
          <div className="grid gap-3 sm:grid-cols-3">{text("city", "City")}{text("state", "State")}{text("country", "Country")}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={label}>Employee status<Clear k="employeeStatusType" />
              <select value={form.employeeStatusType ?? ""} onChange={(e) => set("employeeStatusType", e.target.value)} disabled={disabled} data-testid="pd-employeeStatusType" className={field}>
                <option value="">Not provided</option><option value="FULL_TIME">Full time</option><option value="PART_TIME">Part time</option>
              </select><Err k="employeeStatusType" /></label>
            {text("reportingOffice", "Reporting office")}
            {text("grade", "Grade")}
            {text("vertical", "Vertical")}
            {text("department", "Department (as in the HR sheet)")}
            {text("phoneCode", "Mobile phone code", "91")}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">{text("extraField1", "Extra field 1")}{text("extraField2", "Extra field 2")}{text("extraField3", "Extra field 3")}{text("extraField4", "Extra field 4")}{text("extraField5", "Extra field 5")}</div>
          <label className={label}>Notes<Clear k="notes" /><textarea rows={3} value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} disabled={disabled} data-testid="pd-notes" className={`${field} resize-y break-words`} /><Err k="notes" /></label>
          {note && <p role="alert" data-testid="pd-note" className={`rounded-xl px-3 py-2 text-sm ${note.error ? "border border-rose-200 bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-800"}`}>{note.text}</p>}
          {loaded.canEdit && (
            <button type="button" onClick={save} disabled={busy} data-testid="pd-save" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">{busy ? "Saving…" : "Save personal details"}</button>
          )}
        </div>
      )}
    </section>
  );
}
