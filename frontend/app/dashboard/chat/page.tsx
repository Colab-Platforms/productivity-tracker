"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { useChatTyping, useRealtime } from "@/lib/realtime";
import { desktopOn, desktopSupported, disableDesktop, enableDesktop, ping, setSound, soundOn } from "@/lib/chatAlert";
import { useMe } from "../layout";
import { Modal } from "../_employees/Modal";
import { initialsOf } from "../_photos/Avatar";

// ---------------------------------------------------------------------------
// CHAT
// Anyone can message anyone, in any company. A chat is visible only to the people in it (HR and Admin get no extra view).
// The live connection only says "this conversation changed"; the content is always fetched, so the server decides who sees what.
// Without the live connection the page checks again every few seconds.
// ---------------------------------------------------------------------------

type Conv = { id: string; kind: "DIRECT" | "GROUP"; title: string; subtitle: string; lastMessage: { preview: string; mine: boolean; at: string } | null; lastMessageAt: string; unread: number };
type Member = { id: string; name: string; designation: string | null; company: string | null; isAdmin: boolean; lastReadAt: string };
type Msg = { id: string; senderId: string; senderName: string; body: string; createdAt: string; deleted: boolean; edited: boolean };
type Thread = { conversation: { id: string; kind: "DIRECT" | "GROUP"; title: string; subtitle: string; iAmAdmin: boolean }; members: Member[]; messages: Msg[]; hasMore: boolean };
type Person = { id: string; name: string; designation: string | null; company: string | null };

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayOf = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};
const shortWhen = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? timeOf(iso) : d.toLocaleDateString([], { day: "numeric", month: "short" });
};

function Badge({ name, kind, size = 40 }: { name: string; kind: "DIRECT" | "GROUP"; size?: number }) {
  return (
    <span
      style={{ width: size, height: size }}
      className={`flex shrink-0 items-center justify-center rounded-full text-xs font-semibold ${kind === "GROUP" ? "bg-emerald-100 text-emerald-700" : "bg-indigo-100 text-indigo-700"}`}
    >
      {kind === "GROUP" ? "👥" : initialsOf(name)}
    </span>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <Chat />
    </Suspense>
  );
}

function Chat() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const activeId = params.get("c");
  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [loaded, setThread] = useState<Thread | null>(null);
  const [failed, setFailed] = useState<{ id: string; message: string } | null>(null);
  // A thread or error that belongs to a chat you have since left is simply not shown (no reset needed).
  const thread = loaded && loaded.conversation.id === activeId ? loaded : null;
  const threadError = failed && failed.id === activeId ? failed.message : "";
  const [picker, setPicker] = useState(false);
  const [manage, setManage] = useState(false);
  const [filter, setFilter] = useState("");

  const select = useCallback((id: string | null) => router.replace(id ? `/dashboard/chat?c=${id}` : "/dashboard/chat"), [router]);

  const loadList = useCallback(() => {
    apiGet<{ conversations: Conv[] }>("/chat/conversations")
      .then((r) => {
        setConvs(r.conversations);
        setNotReady(false);
      })
      .catch((e: Error) => {
        if (/switched on/i.test(e.message)) setNotReady(true);
        setConvs((c) => c ?? []);
      });
  }, []);

  const loadThread = useCallback(() => {
    if (!activeId) return;
    apiGet<Thread>(`/chat/conversations/${activeId}/messages`)
      .then((t) => {
        setThread(t);
        setFailed(null);
      })
      .catch((e: Error) => setFailed({ id: activeId, message: e.message }));
  }, [activeId]);

  const reload = useCallback(() => {
    loadList();
    loadThread();
  }, [loadList, loadThread]);
  const { connected } = useRealtime(["chat:changed"], reload);

  useEffect(() => {
    loadList();
  }, [loadList]);
  useEffect(() => {
    loadThread();
  }, [loadThread]);
  // Without the live connection, ask again every few seconds.
  useEffect(() => {
    if (connected) return;
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, [connected, reload]);

  // Opening a chat (or a new message arriving in the open one while you look at it) marks it read.
  const lastRead = useRef("");
  useEffect(() => {
    if (!thread || !activeId) return;
    const last = thread.messages[thread.messages.length - 1];
    const fromOthers = last && last.senderId !== me?.id;
    const key = `${activeId}|${last?.id ?? ""}`;
    if (!fromOthers || lastRead.current === key || document.visibilityState !== "visible") return;
    lastRead.current = key;
    apiPost(`/chat/conversations/${activeId}/read`).catch(() => {
      lastRead.current = "";
    });
  }, [thread, activeId, me?.id]);

  const visible = (convs ?? []).filter((c) => !filter.trim() || c.title.toLowerCase().includes(filter.trim().toLowerCase()));

  if (notReady) {
    return <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">Chat isn&apos;t switched on for this system yet. Ask your administrator.</div>;
  }

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[480px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm" data-testid="chat">
      {/* conversations */}
      <aside className={`${activeId ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-r border-slate-200 md:w-80`}>
        <div className="flex items-center gap-2 border-b border-slate-200 p-3">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search chats"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button onClick={() => setPicker(true)} className="shrink-0 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700">
            New
          </button>
        </div>
        <AlertSettings />
        <div className="flex-1 overflow-y-auto">
          {convs === null && <p className="p-4 text-sm text-slate-500">Loading…</p>}
          {convs !== null && visible.length === 0 && (
            <p className="p-4 text-sm text-slate-500">{convs.length === 0 ? "No chats yet. Press New to message someone." : "No chat matches."}</p>
          )}
          {visible.map((c) => (
            <button
              key={c.id}
              onClick={() => select(c.id)}
              className={`flex w-full items-center gap-3 border-b border-slate-100 px-3 py-3 text-left hover:bg-slate-50 ${c.id === activeId ? "bg-indigo-50" : ""}`}
            >
              <Badge name={c.title} kind={c.kind} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={`truncate text-sm ${c.unread ? "font-semibold text-slate-900" : "font-medium text-slate-800"}`}>{c.title}</span>
                  {c.lastMessage && <span className="shrink-0 text-[11px] text-slate-400">{shortWhen(c.lastMessage.at)}</span>}
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className={`truncate text-xs ${c.unread ? "text-slate-700" : "text-slate-500"}`}>
                    {c.lastMessage ? `${c.lastMessage.mine ? "You: " : ""}${c.lastMessage.preview}` : c.subtitle || "No messages yet"}
                  </span>
                  {c.unread > 0 && <span className="shrink-0 rounded-full bg-indigo-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">{Math.min(99, c.unread)}</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      {/* conversation */}
      <section className={`${activeId ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
        {!activeId && (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-slate-500">Choose a chat on the left, or press New to start one.</div>
        )}
        {activeId && threadError && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-slate-600">
            <p>{threadError}</p>
            <button onClick={() => select(null)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">Back to chats</button>
          </div>
        )}
        {activeId && !threadError && !thread && <div className="flex flex-1 items-center justify-center text-sm text-slate-500">Loading…</div>}
        {activeId && !threadError && thread && (
          <ThreadView
            key={activeId}
            thread={thread}
            meId={me?.id ?? ""}
            onBack={() => select(null)}
            onManage={() => setManage(true)}
            refresh={reload}
            onLoadedEarlier={(older, hasMore) => setThread((t) => (t ? { ...t, messages: [...older, ...t.messages], hasMore } : t))}
          />
        )}
      </section>

      {picker && (
        <NewChat
          onClose={() => setPicker(false)}
          onOpened={(id) => {
            setPicker(false);
            loadList();
            select(id);
          }}
        />
      )}
      {manage && thread && (
        <GroupSettings
          thread={thread}
          meId={me?.id ?? ""}
          onClose={() => setManage(false)}
          onChanged={reload}
          onLeft={() => {
            setManage(false);
            loadList();
            select(null);
          }}
        />
      )}
    </div>
  );
}

// Sound and desktop popup for new messages. Remembered on this device only.
function Switch({ on, onChange, label, hint, icon, disabled }: { on: boolean; onChange: (next: boolean) => void; label: string; hint: string; icon: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${on ? "border-indigo-200 bg-indigo-50" : "border-slate-200 bg-white hover:bg-slate-50"} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${on ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        <span className="block truncate text-[11px] text-slate-500">{hint}</span>
      </span>
      <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? "bg-indigo-600" : "bg-slate-300"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

const SpeakerIcon = ({ muted }: { muted?: boolean }) => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 8v4h3l4 3V5l-4 3h-3Z" />
    {muted ? <path d="m14 8 3.5 4m0-4L14 12" /> : <path d="M13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.5 6.5 0 0 1 0 9" />}
  </svg>
);
const BellIcon = () => (
  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 2.8a4.7 4.7 0 0 0-4.7 4.7c0 4.4-1.8 5.6-1.8 5.6h13s-1.8-1.2-1.8-5.6A4.7 4.7 0 0 0 10 2.8Z" />
    <path d="M8.3 15.8a1.8 1.8 0 0 0 3.4 0" />
  </svg>
);

function AlertSettings() {
  const [open, setOpen] = useState(false);
  const [sound, setSoundState] = useState(true);
  const [desktop, setDesktopState] = useState(false);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    // Read after mount: the saved choice lives in this browser, which the server render cannot see.
    const t = setTimeout(() => {
      setSoundState(soundOn());
      setDesktopState(desktopOn());
      setBlocked(desktopSupported() && Notification.permission === "denied");
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const summary = [sound ? "Sound on" : "Sound off", desktopSupported() ? (desktop ? "Popup on" : "Popup off") : null].filter(Boolean).join(" · ");
  return (
    <div className="border-b border-slate-200">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-50">
        <span className="text-slate-500">{sound || desktop ? <BellIcon /> : <SpeakerIcon muted />}</span>
        <span className="flex-1">Alerts: {summary}</span>
        <span className={`text-slate-400 transition ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          <Switch
            on={sound}
            icon={<SpeakerIcon muted={!sound} />}
            label="Message sound"
            hint="A short ping when a message arrives"
            onChange={(next) => {
              setSound(next);
              setSoundState(next);
              if (next) ping();
            }}
          />
          {desktopSupported() ? (
            <Switch
              on={desktop}
              icon={<BellIcon />}
              label="Desktop popup"
              hint={blocked ? "Blocked in the browser" : "When this tab is in the background"}
              disabled={blocked}
              onChange={async (next) => {
                if (!next) {
                  disableDesktop();
                  setDesktopState(false);
                  return;
                }
                const ok = await enableDesktop();
                setDesktopState(ok);
                setBlocked(Notification.permission === "denied");
              }}
            />
          ) : (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-500">This browser does not support desktop popups.</p>
          )}
          {blocked && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              Notifications are blocked for this site. Click the lock icon beside the address, set Notifications to Allow, then reload.
            </p>
          )}
          <p className="text-[11px] text-slate-400">Popups never show message text. Saved on this device only.</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One open conversation: header, messages, composer.
// ---------------------------------------------------------------------------
function ThreadView({ thread, meId, onBack, onManage, refresh, onLoadedEarlier }: { thread: Thread; meId: string; onBack: () => void; onManage: () => void; refresh: () => void; onLoadedEarlier: (older: Msg[], hasMore: boolean) => void }) {
  const { conversation: conv, members, messages } = thread;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null); // message whose menu is open
  const [menuCanEdit, setMenuCanEdit] = useState(false); // decided when the menu opens (the 15-minute edit window)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<Msg | null>(null);
  const [working, setWorking] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { typing, notifyTyping } = useChatTyping(conv.id);
  const typers = typing.map((id) => members.find((m) => m.id === id)?.name.split(" ")[0]).filter((n): n is string => !!n);
  const lastId = messages[messages.length - 1]?.id;

  // Stay at the bottom when new messages arrive, unless the person has scrolled up to read.
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lastId]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError("");
    try {
      await apiPost(`/chat/conversations/${conv.id}/messages`, { body });
      setText("");
      stick.current = true;
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send.");
    } finally {
      setSending(false);
    }
  };

  const remove = async (m: Msg) => {
    setWorking(true);
    try {
      await apiDelete(`/chat/conversations/${conv.id}/messages/${m.id}`);
      setConfirmDel(null);
      refresh();
    } catch (e) {
      setConfirmDel(null);
      setError(e instanceof Error ? e.message : "Could not delete.");
    } finally {
      setWorking(false);
    }
  };

  const saveEdit = async () => {
    if (!editing || working) return;
    const body = editing.text.trim();
    if (!body) return;
    setWorking(true);
    setError("");
    try {
      await apiPatch(`/chat/conversations/${conv.id}/messages/${editing.id}`, { body });
      setEditing(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the change.");
    } finally {
      setWorking(false);
    }
  };

  const earlier = async () => {
    if (loadingOlder || !messages[0]) return;
    setLoadingOlder(true);
    const el = box.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      const r = await apiGet<Thread>(`/chat/conversations/${conv.id}/messages?before=${encodeURIComponent(messages[0].createdAt)}`);
      stick.current = false;
      onLoadedEarlier(r.messages, r.hasMore);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load earlier messages.");
    } finally {
      setLoadingOlder(false);
    }
  };

  // "Seen": in a direct chat the other person has read up to my last message; in a group, count the people who have.
  const myLast = [...messages].reverse().find((m) => m.senderId === meId && !m.deleted);
  const seenBy = myLast ? members.filter((m) => m.id !== meId && new Date(m.lastReadAt).getTime() >= new Date(myLast.createdAt).getTime()).length : 0;
  const others = members.filter((m) => m.id !== meId).length;

  return (
    <>
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
        <button onClick={onBack} className="rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100 md:hidden" aria-label="Back to chats">←</button>
        <Badge name={conv.title} kind={conv.kind} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{conv.title}</p>
          <p className="truncate text-xs text-slate-500">{conv.subtitle}</p>
        </div>
        {conv.kind === "GROUP" && (
          <button onClick={onManage} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
            Group
          </button>
        )}
      </header>

      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 space-y-1 overflow-y-auto bg-slate-50 px-4 py-3"
      >
        {thread.hasMore && (
          <div className="pb-2 text-center">
            <button onClick={earlier} disabled={loadingOlder} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50">
              {loadingOlder ? "Loading…" : "Earlier messages"}
            </button>
          </div>
        )}
        {messages.length === 0 && <p className="py-10 text-center text-sm text-slate-500">No messages yet. Say hello.</p>}
        {messages.map((m, i) => {
          const day = dayOf(m.createdAt);
          const showDay = i === 0 || dayOf(messages[i - 1].createdAt) !== day;
          const mine = m.senderId === meId;
          const sameSender = i > 0 && messages[i - 1].senderId === m.senderId && !showDay;
          return (
            <div key={m.id}>
              {showDay && (
                <div className="my-3 text-center">
                  <span className="rounded-full bg-slate-200 px-3 py-0.5 text-[11px] text-slate-600">{day}</span>
                </div>
              )}
              <div className={`group flex ${mine ? "justify-end" : "justify-start"} ${sameSender ? "" : "pt-1.5"}`}>
                <div className={`max-w-[80%] ${mine ? "items-end" : "items-start"} flex flex-col`}>
                  {!mine && conv.kind === "GROUP" && !sameSender && <span className="px-1 text-[11px] font-medium text-slate-500">{m.senderName}</span>}
                  {editing?.id === m.id ? (
                    <div className="w-[min(32rem,80vw)] rounded-2xl border border-indigo-300 bg-white p-2 shadow-sm">
                      <textarea
                        autoFocus
                        value={editing.text}
                        onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setEditing(null);
                          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void saveEdit();
                          }
                        }}
                        maxLength={4000}
                        rows={Math.min(6, Math.max(2, editing.text.split("\n").length))}
                        className="w-full resize-none rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-800 outline-none focus:border-indigo-500"
                      />
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <span className="text-[11px] text-slate-400">Enter to save · Esc to cancel</span>
                        <span className="flex gap-1.5">
                          <button onClick={() => setEditing(null)} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50">Cancel</button>
                          <button onClick={() => void saveEdit()} disabled={working || !editing.text.trim() || editing.text.trim() === m.body} className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Save</button>
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className={`flex items-center gap-1 ${mine ? "flex-row-reverse" : ""}`}>
                      <div
                        className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
                          m.deleted ? "border border-dashed border-slate-300 bg-transparent italic text-slate-400" : mine ? "bg-indigo-600 text-white" : "border border-slate-200 bg-white text-slate-800"
                        }`}
                      >
                        {m.deleted ? "Message deleted" : m.body}
                      </div>
                      {mine && !m.deleted && (
                        <div className="relative">
                          <button
                            onClick={() => {
                              setMenuCanEdit(Date.now() - new Date(m.createdAt).getTime() <= 15 * 60_000);
                              setMenuFor(menuFor === m.id ? null : m.id);
                            }}
                            aria-label="Message options"
                            aria-expanded={menuFor === m.id}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 opacity-100 hover:bg-slate-200 hover:text-slate-700 focus:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                          >
                            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor"><circle cx="4.5" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="15.5" cy="10" r="1.5" /></svg>
                          </button>
                          {menuFor === m.id && (
                            <>
                              <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />
                              <div className="absolute bottom-full right-0 z-20 mb-1 w-40 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg">
                                {menuCanEdit ? (
                                  <button
                                    onClick={() => {
                                      setMenuFor(null);
                                      setEditing({ id: m.id, text: m.body });
                                    }}
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-slate-700 hover:bg-slate-50"
                                  >
                                    <svg viewBox="0 0 20 20" className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m12.5 4.5 3 3L7 16H4v-3l8.5-8.5Z" /></svg>
                                    Edit
                                  </button>
                                ) : (
                                  <p className="px-3 py-1.5 text-[11px] text-slate-400">Editing closes after 15 minutes</p>
                                )}
                                <button
                                  onClick={() => {
                                    setMenuFor(null);
                                    setConfirmDel(m);
                                  }}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50"
                                >
                                  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6" /></svg>
                                  Delete
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <span className="px-1 text-[10px] text-slate-400">
                    {timeOf(m.createdAt)}
                    {m.edited && <> · edited</>}
                    {myLast?.id === m.id && others > 0 && seenBy > 0 && <> · {conv.kind === "DIRECT" ? "Seen" : `Seen by ${seenBy}`}</>}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {confirmDel && (
        <Modal
          title="Delete this message?"
          subtitle="It will show as “Message deleted” for everyone in the chat. This cannot be undone."
          onClose={() => setConfirmDel(null)}
          width="max-w-md"
          footer={
            <div className="flex w-full justify-end gap-2">
              <button onClick={() => setConfirmDel(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">Cancel</button>
              <button onClick={() => void remove(confirmDel)} disabled={working} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50">
                {working ? "Deleting…" : "Delete"}
              </button>
            </div>
          }
        >
          <p className="line-clamp-4 whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{confirmDel.body}</p>
        </Modal>
      )}

      <div className="border-t border-slate-200 p-3">
        <p className="mb-1 h-4 text-xs italic text-slate-500" aria-live="polite" data-testid="typing">
          {typers.length === 0 ? "" : typers.length === 1 ? `${typers[0]} is typing…` : typers.length === 2 ? `${typers[0]} and ${typers[1]} are typing…` : "Several people are typing…"}
        </p>
        {error && <p className="mb-2 rounded-md bg-rose-50 px-3 py-1.5 text-xs text-rose-700">{error}</p>}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value) notifyTyping();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            maxLength={4000}
            placeholder="Type a message (Enter to send, Shift+Enter for a new line)"
            className="max-h-32 min-h-[40px] flex-1 resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          <button onClick={() => void send()} disabled={sending || !text.trim()} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            Send
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// People search, used to start a chat and to add people to a group.
// ---------------------------------------------------------------------------
function PeopleSearch({ exclude = [], selected, onToggle, single, onPick }: { exclude?: string[]; selected?: Person[]; onToggle?: (p: Person) => void; single?: boolean; onPick?: (p: Person) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Person[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      apiGet<{ people: Person[] }>(`/chat/people?q=${encodeURIComponent(q)}`)
        .then((r) => {
          setRows(r.people);
          setError("");
        })
        .catch((e: Error) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const shown = (rows ?? []).filter((p) => !exclude.includes(p.id));
  return (
    <div>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or employee code" className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
      {error && <p className="mb-2 text-xs text-rose-600">{error}</p>}
      <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200">
        {rows === null && <p className="p-3 text-sm text-slate-500">Loading…</p>}
        {rows !== null && shown.length === 0 && <p className="p-3 text-sm text-slate-500">Nobody found.</p>}
        {shown.map((p) => {
          const on = !!selected?.find((s) => s.id === p.id);
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => (single ? onPick?.(p) : onToggle?.(p))}
              className={`flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-slate-50 ${on ? "bg-indigo-50" : ""}`}
            >
              <Badge name={p.name} kind="DIRECT" size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-800">{p.name}</span>
                <span className="block truncate text-xs text-slate-500">{[p.designation, p.company].filter(Boolean).join(" · ")}</span>
              </span>
              {!single && <span className={`h-4 w-4 shrink-0 rounded border ${on ? "border-indigo-600 bg-indigo-600" : "border-slate-300"}`} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NewChat({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const [group, setGroup] = useState(false);
  const [picked, setPicked] = useState<Person[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const open = async (userIds: string[], groupTitle?: string) => {
    setBusy(true);
    setError("");
    try {
      const r = await apiPost<{ id: string }>("/chat/conversations", { userIds, ...(groupTitle ? { title: groupTitle } : {}) });
      onOpened(r.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the chat.");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={group ? "New group" : "New chat"}
      subtitle={group ? "Choose the people and name the group." : "Choose a person to message. You can message anyone, in any company."}
      onClose={onClose}
      width="max-w-lg"
      footer={
        group ? (
          <div className="flex w-full items-center justify-between gap-2">
            <button onClick={() => { setGroup(false); setPicked([]); }} className="text-sm text-slate-600 hover:underline">Single chat instead</button>
            <button disabled={busy || picked.length === 0 || !title.trim()} onClick={() => open(picked.map((p) => p.id), title)} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
              Create group{picked.length ? ` (${picked.length + 1})` : ""}
            </button>
          </div>
        ) : (
          <button onClick={() => setGroup(true)} className="text-sm font-medium text-indigo-600 hover:underline">Make a group instead</button>
        )
      }
    >
      {error && <p className="mb-2 rounded-md bg-rose-50 px-3 py-1.5 text-sm text-rose-700">{error}</p>}
      {group && (
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Group name" className="mb-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
      )}
      {group && picked.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {picked.map((p) => (
            <button key={p.id} onClick={() => setPicked((c) => c.filter((x) => x.id !== p.id))} className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs text-indigo-700 hover:bg-indigo-100">
              {p.name} ✕
            </button>
          ))}
        </div>
      )}
      <PeopleSearch
        single={!group}
        selected={picked}
        onPick={(p) => !busy && open([p.id])}
        onToggle={(p) => setPicked((c) => (c.find((x) => x.id === p.id) ? c.filter((x) => x.id !== p.id) : [...c, p]))}
      />
    </Modal>
  );
}

function GroupSettings({ thread, meId, onClose, onChanged, onLeft }: { thread: Thread; meId: string; onClose: () => void; onChanged: () => void; onLeft: () => void }) {
  const { conversation: conv, members } = thread;
  const [name, setName] = useState(conv.title);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Person[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onChanged();
      done?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={conv.title} subtitle={`${members.length} people`} onClose={onClose} width="max-w-lg">
      {error && <p className="mb-2 rounded-md bg-rose-50 px-3 py-1.5 text-sm text-rose-700">{error}</p>}
      {conv.iAmAdmin && (
        <div className="mb-4 flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
          <button disabled={busy || !name.trim() || name.trim() === conv.title} onClick={() => act(() => apiPatch(`/chat/conversations/${conv.id}`, { title: name }))} className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50">
            Rename
          </button>
        </div>
      )}
      <ul className="mb-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
        {members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2">
            <Badge name={m.name} kind="DIRECT" size={32} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-800">
                {m.name}
                {m.id === meId ? " (you)" : ""}
                {m.isAdmin && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">Admin</span>}
              </span>
              <span className="block truncate text-xs text-slate-500">{[m.designation, m.company].filter(Boolean).join(" · ")}</span>
            </span>
            {conv.iAmAdmin && m.id !== meId && (
              <button disabled={busy} onClick={() => window.confirm(`Remove ${m.name} from the group?`) && act(() => apiDelete(`/chat/conversations/${conv.id}/members/${m.id}`))} className="text-xs text-rose-600 hover:underline disabled:opacity-50">
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {conv.iAmAdmin && (
        <div className="mb-4">
          {!adding ? (
            <button onClick={() => setAdding(true)} className="text-sm font-medium text-indigo-600 hover:underline">Add people</button>
          ) : (
            <>
              <PeopleSearch
                exclude={members.map((m) => m.id)}
                selected={picked}
                onToggle={(p) => setPicked((c) => (c.find((x) => x.id === p.id) ? c.filter((x) => x.id !== p.id) : [...c, p]))}
              />
              <button
                disabled={busy || picked.length === 0}
                onClick={() => act(() => apiPost(`/chat/conversations/${conv.id}/members`, { userIds: picked.map((p) => p.id) }), () => { setPicked([]); setAdding(false); })}
                className="mt-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Add {picked.length || ""}
              </button>
            </>
          )}
        </div>
      )}
      <button disabled={busy} onClick={() => window.confirm("Leave this group? You will not see it any more.") && act(() => apiDelete(`/chat/conversations/${conv.id}/members/${meId}`), onLeft)} className="text-sm font-medium text-rose-600 hover:underline disabled:opacity-50">
        Leave group
      </button>
    </Modal>
  );
}
