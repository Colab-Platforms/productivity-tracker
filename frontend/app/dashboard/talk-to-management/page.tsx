"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { API_BASE, apiGet, apiPost, getToken } from "@/lib/api";
import { useMe } from "../layout";
import { Modal } from "../_employees/Modal";

// Talk to Management: a private conversation between one person and the ONE Admin they choose.
// Employees / managers / HR see "Talk to Management" (their own conversations); an Admin sees the same page as an inbox of what was
// addressed to them. Nobody else can open a conversation (the server answers "not found").

type Person = { id: string; name: string };
type Item = {
  id: string; subject: string; status: string; statusLabel: string;
  sender: Person & { employeeCode: string | null }; admin: Person;
  messageCount: number; createdAt: string; updatedAt: string; needsYou: boolean;
};
type List = { ready: boolean; asSender: Item[]; asAdmin: Item[] };
type Message = { id: string; authorName: string; mine: boolean; body: string; attachmentName: string | null; createdAt: string };
type Detail = {
  id: string; subject: string; status: string; statusLabel: string; createdAt: string;
  sender: Person & { employeeCode: string | null }; admin: Person; iAmAdmin: boolean; canReply: boolean; canClose: boolean; messages: Message[];
};

const CHIP: Record<string, string> = {
  OPEN: "bg-amber-50 text-amber-700",
  REPLIED: "bg-emerald-50 text-emerald-700",
  CLOSED: "bg-slate-100 text-slate-600",
};
const input = "mt-1 w-full rounded-xl border border-indigo-100 bg-white px-3 py-2.5 text-sm text-slate-800";
const when = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(s));

const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(file);
  });

async function openFile(path: string) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error("Could not open the file");
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function Chip({ status, label }: { status: string; label: string }) {
  return <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${CHIP[status] ?? "bg-slate-100 text-slate-600"}`}>{label}</span>;
}

// ---------------------------------------------------------------------------------------------------------------------------
function NewMessageModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [admins, setAdmins] = useState<{ id: string; name: string; company: string | null }[] | null>(null);
  const [adminId, setAdminId] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<{ admins: { id: string; name: string; company: string | null }[] }>("/management-talk/admins")
      .then((r) => setAdmins(r.admins))
      .catch((e: Error) => setError(e.message));
  }, []);

  async function submit() {
    if (busy) return;
    if (!adminId) return setError("Choose which Admin to write to.");
    setBusy(true);
    setError("");
    try {
      const attachment = file ? { fileName: file.name, data: await readFile(file), mimeType: file.type } : undefined;
      const r = await apiPost<{ id: string }>("/management-talk", { adminId, subject, message, attachment });
      onDone(r.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Talk to Management"
      subtitle="Only the Admin you choose can read this. HR and managers cannot see it."
      onClose={onClose}
      width="max-w-xl"
      footer={
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">Close</button>
          <button disabled={busy || !adminId} onClick={submit} className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <label className="block text-sm text-slate-600">Write to
          <select value={adminId} onChange={(e) => setAdminId(e.target.value)} className={input}>
            <option value="">{admins ? "Choose an Admin…" : "Loading…"}</option>
            {(admins ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}{a.company ? ` · ${a.company}` : ""}</option>)}
          </select>
        </label>
        <label className="block text-sm text-slate-600">Subject<input value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} placeholder="A few words" className={input} /></label>
        <label className="block text-sm text-slate-600">Message<textarea value={message} maxLength={4000} rows={6} onChange={(e) => setMessage(e.target.value)} placeholder="Say what you want management to know." className={`${input} break-words`} /></label>
        <label className="block text-sm text-slate-600">Attachment (optional)
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm text-slate-600" />
          <span className="text-xs text-slate-400">PDF, image or Word file, up to 10 MB.</span>
        </label>
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
function ThreadModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    apiGet<Detail>(`/management-talk/${id}`)
      .then((r) => { setD(r); setError(""); })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function send() {
    if (busy || !d) return;
    setBusy(true);
    setError("");
    try {
      const attachment = file ? { fileName: file.name, data: await readFile(file), mimeType: file.type } : undefined;
      await apiPost(`/management-talk/${d.id}/messages`, { body: text, attachment });
      setText("");
      setFile(null);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function closeThread() {
    if (busy || !d) return;
    if (!window.confirm("Close this conversation? Neither of you can add to it afterwards.")) return;
    setBusy(true);
    try {
      await apiPost(`/management-talk/${d.id}/close`);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={d ? d.subject : "Conversation"}
      subtitle={d ? (d.iAmAdmin ? `From ${d.sender.name}${d.sender.employeeCode ? ` (${d.sender.employeeCode})` : ""}` : `To ${d.admin.name}`) : undefined}
      onClose={onClose}
      width="max-w-2xl"
    >
      {!d ? (
        <p className="text-sm text-slate-500">{error || "Loading…"}</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Chip status={d.status} label={d.statusLabel} />
            <span className="text-xs text-slate-400">Started {when(d.createdAt)}</span>
            {d.canClose && (
              <button onClick={closeThread} disabled={busy} className="ml-auto rounded-xl border border-indigo-100 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50">Close conversation</button>
            )}
          </div>
          <ul className="space-y-3">
            {d.messages.map((m) => (
              <li key={m.id} className={`rounded-2xl px-4 py-3 text-sm ${m.mine ? "bg-indigo-50 text-slate-800" : "bg-slate-50 text-slate-800"}`}>
                <div className="mb-1 flex items-center justify-between gap-3 text-xs text-slate-500">
                  <span className="font-medium">{m.mine ? "You" : m.authorName}</span>
                  <span>{when(m.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                {m.attachmentName && (
                  <button onClick={() => openFile(`/management-talk/${d.id}/messages/${m.id}/attachment`).catch((e: Error) => setError(e.message))} className="mt-2 rounded-lg border border-indigo-100 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
                    Open attachment: {m.attachmentName}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {d.canReply ? (
            <div className="space-y-2 border-t border-indigo-100 pt-4">
              <textarea value={text} maxLength={4000} rows={4} onChange={(e) => setText(e.target.value)} placeholder={d.iAmAdmin ? "Write your reply…" : "Add a message…"} className={`${input} break-words`} />
              <div className="flex flex-wrap items-center gap-3">
                <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-xs text-slate-600" />
                <button onClick={send} disabled={busy || text.trim().length === 0} className="ml-auto rounded-xl bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          ) : (
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-500">This conversation is closed.</p>
          )}
          {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
function Rows({ items, mode, onOpen }: { items: Item[]; mode: "sender" | "admin"; onOpen: (id: string) => void }) {
  if (items.length === 0) return <p className="px-6 py-10 text-center text-sm text-slate-500">{mode === "admin" ? "Nothing has been sent to you yet." : "You have not written to management yet."}</p>;
  return (
    <ul className="divide-y divide-indigo-50">
      {items.map((it) => (
        <li key={it.id}>
          <button onClick={() => onOpen(it.id)} className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-indigo-50/40">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-900">{it.subject}</p>
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {mode === "admin" ? `From ${it.sender.name}${it.sender.employeeCode ? ` (${it.sender.employeeCode})` : ""}` : `To ${it.admin.name}`} · {it.messageCount} message{it.messageCount === 1 ? "" : "s"} · {when(it.updatedAt)}
              </p>
            </div>
            {it.needsYou && <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white">Needs reply</span>}
            <Chip status={it.status} label={it.statusLabel} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Inner() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [composing, setComposing] = useState(false);
  const [tab, setTab] = useState<"inbox" | "mine">("inbox");
  const openId = params.get("id");

  useEffect(() => {
    let live = true;
    apiGet<List>("/management-talk")
      .then((r) => live && setData(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [reload]);

  const isAdmin = me?.role === "ADMIN";
  const showInbox = isAdmin && tab === "inbox";
  const items = data ? (showInbox ? data.asAdmin : data.asSender) : [];
  const open = (id: string | null) => router.replace(id ? `/dashboard/talk-to-management?id=${id}` : "/dashboard/talk-to-management");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{isAdmin ? "Management Inbox" : "Talk to Management"}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {isAdmin ? "Private messages people have addressed to you. No one else can see them." : "A private line to an Admin you choose. HR and managers cannot see what you write."}
          </p>
        </div>
        <button onClick={() => setComposing(true)} className="ml-auto h-10 rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700">New message</button>
      </div>

      {isAdmin && (
        <div className="flex gap-2">
          {([["inbox", "Sent to me"], ["mine", "My messages"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className={`rounded-xl px-4 py-2 text-sm font-medium ${tab === k ? "bg-indigo-600 text-white" : "bg-white text-slate-600 shadow-[var(--shadow-card)] hover:bg-indigo-50"}`}>{label}</button>
          ))}
        </div>
      )}

      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      {data && !data.ready && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Talk to Management is not set up on this server yet. Ask an administrator to finish the database update.</p>}

      <div className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
        {!data ? <p className="px-6 py-10 text-center text-sm text-slate-500">Loading…</p> : <Rows items={items} mode={showInbox ? "admin" : "sender"} onOpen={open} />}
      </div>

      {composing && (
        <NewMessageModal
          onClose={() => setComposing(false)}
          onDone={(id) => {
            setComposing(false);
            setReload((n) => n + 1);
            open(id);
          }}
        />
      )}
      {openId && <ThreadModal id={openId} onClose={() => open(null)} onChanged={() => setReload((n) => n + 1)} />}
    </div>
  );
}

export default function TalkToManagementPage() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
