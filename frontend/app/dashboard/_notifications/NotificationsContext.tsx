"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";
import { labelOf, POPUP_TYPES, type Inbox, type Item } from "./types";
import { alarm, ping } from "@/lib/chatAlert";
import { categoryOf, claimToast, popupsEnabled, POPUPS_KEY, SEVERITY_STYLE, severityOf, soundFor, toastMs } from "./popup";

// ---------------------------------------------------------------------------
// ONE inbox for the whole app.
// The bell (desktop and mobile), the popups and the notification centre all read this, so they can never
// disagree about the unread count. It refreshes the instant the server says something arrived (live connection),
// and checks again on its own every 30 seconds if that connection is down (every 5 minutes while it is up), and
// whenever the window regains focus. Notifications live in the database: if you were away, they are waiting.
// ---------------------------------------------------------------------------

type Toast = { id: string; type: string; title: string; body: string; link: string | null; createdAt: string };
type Value = {
  inbox: Inbox;
  connected: boolean;
  reload: () => void;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** pop-ups on/off for THIS browser (the bell and history always keep everything) */
  popups: boolean;
  setPopups: (on: boolean) => void;
};

const Ctx = createContext<Value | null>(null);
export const useNotifications = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNotifications must be used inside NotificationsProvider");
  return v;
};

const MAX_TOASTS = 3;
const TAB_ID = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [inbox, setInbox] = useState<Inbox>({ unread: 0, items: [] });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [popups, setPopupsState] = useState(true);
  const popupsRef = useRef(true);
  useEffect(() => {
    const on = popupsEnabled(window.localStorage);
    popupsRef.current = on;
    setPopupsState(on);
    // tidy the small "which tab showed it" markers left by earlier notifications
    try {
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const k = window.localStorage.key(i);
        if (k?.startsWith("hrms-toast:") && Date.now() - Number((window.localStorage.getItem(k) ?? "").split("|")[1]) > 600_000) window.localStorage.removeItem(k);
      }
    } catch { /* storage blocked */ }
  }, []);
  const setPopups = useCallback((on: boolean) => {
    popupsRef.current = on;
    setPopupsState(on);
    try { window.localStorage.setItem(POPUPS_KEY, on ? "on" : "off"); } catch { /* not remembered */ }
  }, []);
  const known = useRef<Set<string> | null>(null); // ids already seen: null until the first load, so old ones never pop up
  // Bumped whenever the person reads something. A fetch that started BEFORE that must not overwrite the screen, or the item
  // they just read would flash back into the list until the next refresh.
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = seq.current;
    apiGet<Inbox>("/notifications")
      .then((next) => {
        if (mine !== seq.current) return;
        if (known.current === null) {
          known.current = new Set(next.items.map((i) => i.id)); // the first load is the baseline, not news
        } else {
          const fresh = next.items.filter((i) => !known.current!.has(i.id) && !i.readAt && POPUP_TYPES.has(i.type));
          next.items.forEach((i) => known.current!.add(i.id));
          // pop-ups can be switched off per browser, and when several tabs are open only the first one that claims a notification shows it
          const show = popupsRef.current ? fresh.filter((i) => claimToast(window.localStorage, i.id, TAB_ID)) : [];
          // a sound for the pop-ups that appear (the alarm for urgent ones, a soft ping for the rest); the existing sound switch decides whether it plays
          const sound = soundFor(show);
          if (sound === "alarm") alarm();
          else if (sound === "ping") ping();
          if (show.length > 0) {
            setToasts((cur) => [...cur, ...show.map((i) => ({ id: i.id, type: i.type, title: i.title, body: i.body, link: i.link, createdAt: i.createdAt }))].slice(-MAX_TOASTS));
          }
        }
        setInbox(next);
      })
      .catch(() => undefined); // a failed refresh keeps the last inbox instead of showing an error
  }, []);

  const { connected } = useRealtime(["notifications:changed"], load);
  const connectedRef = useRef(connected);
  useEffect(() => {
    connectedRef.current = connected;
  });

  useEffect(() => {
    const first = setTimeout(load, 0);
    let last = Date.now();
    const poll = setInterval(() => {
      if (!connectedRef.current || Date.now() - last > 5 * 60_000) {
        last = Date.now();
        load();
      }
    }, 30_000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  // Reading is applied on screen at once (the item leaves the bell, the badge goes down) and saved to the database in the background.
  // If the save fails, the next fetch shows the truth again instead of pretending it worked.
  const markRead = useCallback(
    async (id: string) => {
      seq.current += 1;
      setInbox((cur) => {
        const was = cur.items.find((i) => i.id === id);
        return { unread: was && !was.readAt ? Math.max(0, cur.unread - 1) : cur.unread, items: cur.items.filter((i) => i.id !== id) };
      });
      await apiPost(`/notifications/${id}/read`).catch(() => undefined);
      load();
    },
    [load]
  );
  const markAllRead = useCallback(async () => {
    seq.current += 1;
    setInbox({ unread: 0, items: [] });
    await apiPost("/notifications/read-all").catch(() => undefined);
    load();
  }, [load]);

  const dismiss = useCallback((id: string) => setToasts((cur) => cur.filter((t) => t.id !== id)), []);
  const openToast = useCallback(
    (t: Toast) => {
      dismiss(t.id);
      void markRead(t.id);
      if (t.link) router.push(t.link);
    },
    [dismiss, markRead, router]
  );

  const value = useMemo(() => ({ inbox, connected, reload: load, markRead, markAllRead, popups, setPopups }), [inbox, connected, load, markRead, markAllRead, popups, setPopups]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onOpen={openToast} onClose={dismiss} />
    </Ctx.Provider>
  );
}

// The on-screen popups. Each one fades after a few seconds, can be closed, and opens the related screen.
function ToastStack({ toasts, onOpen, onClose }: { toasts: Toast[]; onOpen: (t: Toast) => void; onClose: (id: string) => void }) {
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed right-4 top-4 z-[110] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} t={t} onOpen={onOpen} onClose={onClose} />
      ))}
    </div>
  );
}

function ToastCard({ t, onOpen, onClose }: { t: Toast; onOpen: (t: Toast) => void; onClose: (id: string) => void }) {
  const sev = severityOf(t.type, t.body);
  const st = SEVERITY_STYLE[sev];
  useEffect(() => {
    const timer = setTimeout(() => onClose(t.id), toastMs(sev, t.type));
    return () => clearTimeout(timer);
  }, [t.id, t.type, sev, onClose]);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(t.createdAt));
  return (
    <div data-testid="toast" data-severity={sev} data-type={t.type} className={`pointer-events-auto animate-in rounded-2xl bg-white p-4 shadow-[var(--shadow-lift)] ring-1 ${st.ring}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${st.dot}`}>{st.icon}</span>
        <button onClick={() => onOpen(t)} className="min-w-0 flex-1 text-left">
          <p className={`text-[11px] font-medium uppercase tracking-wide ${st.label}`}>{categoryOf(t.type)} · {labelOf(t.type)} · {time}</p>
          <p className="mt-0.5 text-sm font-semibold text-slate-900">{t.title}</p>
          <p className={`mt-0.5 text-xs text-slate-500 ${t.type === "BREAK_LIMIT_EXCEEDED" ? "" : "line-clamp-2"}`}>{t.body}</p>
        </button>
        <button onClick={() => onClose(t.id)} aria-label="Dismiss" className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M5 5l10 10M15 5L5 15" /></svg>
        </button>
      </div>
    </div>
  );
}

export type { Item };
