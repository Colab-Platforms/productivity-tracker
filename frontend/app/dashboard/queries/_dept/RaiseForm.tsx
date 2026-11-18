"use client";

// The department request form. It shows who is asking (read from the signed-in person's own record, never typed), checks every field with a
// clear message, previews the attachment, and ends with a confirmation that carries the reference ID. The server re-checks everything.
import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Modal } from "../../_employees/Modal";

type Dept = { id: string; name: string };
type Preview = { employee: { name: string; employeeCode: string | null; designation: string | null; company: string }; reportingManager: string | null; hasManagerStep: boolean; finalApprovers: string[]; adminsMapped: boolean };
type Sent = { id: string; reference: string; stage: string; stageLabel: string };

const PRIORITIES = [
  { key: "LOW", label: "Low", hint: "Whenever possible", dot: "bg-slate-400", ring: "border-slate-300 bg-slate-50 text-slate-700" },
  { key: "MEDIUM", label: "Medium", hint: "Normal", dot: "bg-sky-500", ring: "border-sky-300 bg-sky-50 text-sky-800" },
  { key: "HIGH", label: "High", hint: "Needed soon", dot: "bg-orange-500", ring: "border-orange-300 bg-orange-50 text-orange-800" },
  { key: "URGENT", label: "Urgent", hint: "Blocking my work", dot: "bg-red-500", ring: "border-red-300 bg-red-50 text-red-800" },
] as const;
const MAX_BYTES = 10 * 1024 * 1024;
const OK_TYPES = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".doc", ".docx"];
const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const readFile = (file: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error("Could not read that file")); r.readAsDataURL(file); });
const input = "w-full rounded-xl border bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-indigo-500";
const border = (bad: boolean) => (bad ? "border-red-400" : "border-indigo-100");

export function DeptRaiseModal({ departments, onClose, onDone }: { departments: Dept[]; onClose: () => void; onDone: (ref: string, stage: string) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [find, setFind] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState("");
  const [thumb, setThumb] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    apiGet<Preview>("/queries/dept/form-preview").then((p) => live && setPreview(p)).catch(() => undefined);
    return () => { live = false; };
  }, []);
  // An image gets a small preview; the temporary address is released when it changes or the form closes.
  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThumb(url);
    return () => { URL.revokeObjectURL(url); setThumb(null); };
  }, [file]);

  const errors = useMemo(() => ({
    title: title.trim().length === 0 ? "Please give your query a title." : title.trim().length < 3 ? "The title needs at least 3 characters." : "",
    description: description.trim().length === 0 ? "Please describe what you need." : description.trim().length < 5 ? "Please add a few more words so the team understands." : "",
    department: departmentId ? "" : "Choose the department that should do the work.",
  }), [title, description, departmentId]);
  const show = (k: keyof typeof errors) => (tried ? errors[k] : "");
  const shown = departments.filter((x) => x.name.toLowerCase().includes(find.trim().toLowerCase()));
  const pickedDept = departments.find((x) => x.id === departmentId);
  const pickedPriority = PRIORITIES.find((p) => p.key === priority)!;

  function chooseFile(f: File | null) {
    setFileError("");
    if (!f) return setFile(null);
    const ext = "." + (f.name.split(".").pop() ?? "").toLowerCase();
    if (!OK_TYPES.includes(ext)) { setFile(null); return setFileError("That file type is not allowed. Attach a PDF, image (PNG, JPG, WEBP) or Word file."); }
    if (f.size === 0) { setFile(null); return setFileError("That file is empty."); }
    if (f.size > MAX_BYTES) { setFile(null); return setFileError(`That file is ${sizeText(f.size)}. The limit is 10 MB.`); }
    setFile(f);
  }

  async function submit() {
    if (busy) return;
    setTried(true);
    if (errors.title) return titleRef.current?.focus();
    if (errors.description) return descRef.current?.focus();
    if (errors.department) return findRef.current?.focus();
    setBusy(true); setError("");
    try {
      const attachment = file ? { fileName: file.name, data: await readFile(file), mimeType: file.type } : undefined;
      const r = await apiPost<Sent>("/queries/dept", { title, description, departmentId, priority, attachment });
      setSent(r);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (sent) {
    const when = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date());
    return (
      <Modal title="Request submitted" onClose={() => onDone(sent.reference, sent.stage)} width="max-w-lg"
        footer={<div className="flex justify-end gap-2"><button onClick={() => onDone(sent.reference, sent.stage)} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700">View my requests</button></div>}>
        <div className="space-y-4 text-center" data-testid="submit-confirmation">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl text-emerald-600" aria-hidden="true">✓</div>
          <div>
            <p className="text-sm text-slate-500">Your reference ID</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums tracking-wide text-slate-900" data-testid="reference-id">{sent.reference}</p>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(sent.reference)} className="mt-1 text-xs font-medium text-indigo-600 hover:underline">Copy reference</button>
          </div>
          <dl className="grid grid-cols-2 gap-3 rounded-2xl bg-[#F3F7F6] p-4 text-left text-sm">
            <div><dt className="text-xs text-slate-500">Query</dt><dd className="break-words font-medium text-slate-900">{title.trim()}</dd></div>
            <div><dt className="text-xs text-slate-500">Department</dt><dd className="font-medium text-slate-900">{pickedDept?.name}</dd></div>
            <div><dt className="text-xs text-slate-500">Priority</dt><dd className="font-medium text-slate-900">{pickedPriority.label}</dd></div>
            <div><dt className="text-xs text-slate-500">Submitted</dt><dd className="font-medium text-slate-900">{when}</dd></div>
          </dl>
          <p className="rounded-xl bg-indigo-50 px-4 py-3 text-left text-sm text-indigo-900">
            <b>Status: {sent.stageLabel}.</b>{" "}
            {sent.stage === "PENDING_MANAGER" ? `${preview?.reportingManager ?? "Your reporting manager"} decides first, then an Admin gives the final approval.` : "It goes to an Admin for the final approval."} Only after that does {pickedDept?.name ?? "the department"} see it. You can follow every step, and the history, from your list.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="New department request" subtitle="Ask a department to do something. Your manager and an Admin approve it first." onClose={onClose} width="max-w-2xl"
      footer={<div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">Fields marked * are required. The date and time are recorded when you send.</p>
        <div className="flex gap-2">
          <button onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button disabled={busy} onClick={submit} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">{busy ? "Sending…" : "Send for approval"}</button>
        </div>
      </div>}>
      <div className="space-y-5">
        {/* who is asking: read from the profile, not typed */}
        <section aria-label="Your details" className="rounded-2xl bg-[#F3F7F6] p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Your details (from your profile)</p>
          {!preview ? <div className="skeleton mt-2 h-12" aria-busy="true" /> : (
            <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-slate-500">Employee</dt><dd className="font-medium text-slate-900" data-testid="pf-name">{preview.employee.name}</dd></div>
              <div><dt className="text-xs text-slate-500">Employee ID</dt><dd className="font-medium text-slate-900" data-testid="pf-code">{preview.employee.employeeCode ?? "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Company</dt><dd className="font-medium text-slate-900" data-testid="pf-company">{preview.employee.company}</dd></div>
              <div><dt className="text-xs text-slate-500">Reporting manager</dt><dd className="font-medium text-slate-900" data-testid="pf-manager">{preview.hasManagerStep ? preview.reportingManager : "None, goes straight to an Admin"}</dd></div>
            </dl>
          )}
          {preview && preview.finalApprovers.length > 0 && <p className="mt-3 text-xs text-slate-500">Final approval by: {preview.finalApprovers.join(", ")}{preview.adminsMapped ? "" : " (any Admin of your company)"}</p>}
        </section>

        <div>
          <label htmlFor="dq-title" className="text-sm font-medium text-slate-700">Query title *</label>
          <input id="dq-title" ref={titleRef} value={title} maxLength={150} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!show("title")} aria-describedby="dq-title-msg" placeholder="For example: Request for PC cleaning" className={`mt-1 ${input} ${border(!!show("title"))}`} />
          <div className="mt-1 flex justify-between text-xs"><span id="dq-title-msg" role={show("title") ? "alert" : undefined} className="text-red-600">{show("title")}</span><span className="text-slate-400">{title.length}/150</span></div>
        </div>

        <div>
          <label htmlFor="dq-desc" className="text-sm font-medium text-slate-700">Description *</label>
          <textarea id="dq-desc" ref={descRef} value={description} maxLength={4000} rows={5} onChange={(e) => setDescription(e.target.value)} aria-invalid={!!show("description")} aria-describedby="dq-desc-msg" placeholder="What do you need, where, and by when? For example: my office PC is slow and needs cleaning and maintenance." className={`mt-1 resize-y ${input} ${border(!!show("description"))} [overflow-wrap:anywhere]`} />
          <div className="mt-1 flex justify-between text-xs"><span id="dq-desc-msg" role={show("description") ? "alert" : undefined} className="text-red-600">{show("description")}</span><span className="text-slate-400">{description.length}/4000</span></div>
        </div>

        <div>
          <label htmlFor="dq-find" className="text-sm font-medium text-slate-700">Department that will do the work *</label>
          <input id="dq-find" ref={findRef} value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search departments…" aria-describedby="dq-dept-msg" className={`mt-1 ${input} ${border(!!show("department"))}`} />
          <ul role="listbox" aria-label="Department" className="mt-2 grid max-h-44 gap-2 overflow-y-auto sm:grid-cols-2">
            {shown.map((x) => (
              <li key={x.id} role="option" aria-selected={departmentId === x.id}>
                <button type="button" onClick={() => setDepartmentId(x.id)} className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-sm ${departmentId === x.id ? "border-indigo-500 bg-indigo-50 font-medium text-indigo-900" : "border-indigo-100 bg-white text-slate-700 hover:bg-indigo-50/50"}`}>
                  <span className="truncate">{x.name}</span>{departmentId === x.id && <span aria-hidden="true">✓</span>}
                </button>
              </li>
            ))}
            {shown.length === 0 && departments.length > 0 && <li className="text-xs text-slate-500">No department matches “{find}”.</li>}
          </ul>
          {departments.length === 0 && <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">No departments are set up for your company yet. Ask an Admin to add them (Query Desk › Department requests › Manage departments).</p>}
          <p id="dq-dept-msg" role={show("department") ? "alert" : undefined} className="mt-1 text-xs text-red-600">{show("department")}</p>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Priority *</legend>
          <div role="radiogroup" aria-label="Priority" className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PRIORITIES.map((p) => (
              <button key={p.key} type="button" role="radio" aria-checked={priority === p.key} onClick={() => setPriority(p.key)} className={`rounded-xl border px-3 py-2 text-left text-sm ${priority === p.key ? `${p.ring} font-medium ring-1 ring-current` : "border-indigo-100 bg-white text-slate-600 hover:bg-slate-50"}`}>
                <span className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${p.dot}`} aria-hidden="true" />{p.label}</span>
                <span className="mt-0.5 block text-xs font-normal opacity-70">{p.hint}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <div>
          <p className="text-sm font-medium text-slate-700">Attachment <span className="font-normal text-slate-400">(optional)</span></p>
          {!file ? (
            <label className="mt-1 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-indigo-200 bg-white px-4 py-5 text-center text-sm text-slate-600 hover:bg-indigo-50/40">
              <span className="font-medium text-indigo-700">Choose a screenshot or document</span>
              <span className="mt-0.5 text-xs text-slate-400">PDF, image or Word file, up to 10 MB</span>
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" onChange={(e) => { chooseFile(e.target.files?.[0] ?? null); e.target.value = ""; }} className="sr-only" />
            </label>
          ) : (
            <div className="mt-1 flex items-center gap-3 rounded-xl border border-indigo-100 bg-white p-3" data-testid="attachment-preview">
              {thumb ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={thumb} alt="Preview of the attachment" className="h-14 w-14 rounded-lg object-cover" /> : <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-[#F3F7F6] text-xs font-semibold uppercase text-slate-500">{(file.name.split(".").pop() ?? "file").slice(0, 4)}</span>}
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-slate-900">{file.name}</p><p className="text-xs text-slate-500">{sizeText(file.size)}</p></div>
              <button type="button" onClick={() => chooseFile(null)} className="rounded-lg border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50">Remove</button>
            </div>
          )}
          {fileError && <p role="alert" className="mt-1 text-xs text-red-600">{fileError}</p>}
        </div>

        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
