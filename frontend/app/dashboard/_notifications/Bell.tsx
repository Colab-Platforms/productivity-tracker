"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useNotifications } from "./NotificationsContext";
import { ago, labelOf, type Item } from "./types";

// ---------------------------------------------------------------------------
// NOTIFICATION BELL
// The signed-in person's own inbox, read from the shared provider (so the desktop bell, the mobile bell, the
// popups and the notification centre always agree). It updates the moment something arrives.
// ---------------------------------------------------------------------------

export default function Bell() {
  const router = useRouter();
  const { inbox, markRead, markAllRead, reload } = useNotifications();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; wide: boolean }>({ top: 64, left: 16, wide: true });
  const button = useRef<HTMLButtonElement>(null);

  function toggle() {
    if (!open && button.current) {
      const r = button.current.getBoundingClientRect();
      const wide = window.innerWidth < 768;
      setPos({ top: wide ? r.bottom + 8 : Math.max(12, r.top), left: wide ? 16 : r.right + 12, wide });
      reload();
    }
    setOpen((o) => !o);
  }

  function openItem(i: Item) {
    setOpen(false);
    if (!i.readAt) void markRead(i.id); // leaves the bell at once; saved in the background
    if (i.link) router.push(i.link);
  }

  return (
    <>
      <button ref={button} data-testid="bell" onClick={toggle} aria-label={`Notifications${inbox.unread ? `, ${inbox.unread} unread` : ""}`} className="relative rounded-lg p-2 text-slate-500 hover:bg-indigo-50 hover:text-indigo-700">
        <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 2.8a4.7 4.7 0 0 0-4.7 4.7c0 4.4-1.8 5.6-1.8 5.6h13s-1.8-1.2-1.8-5.6A4.7 4.7 0 0 0 10 2.8Z" />
          <path d="M8.3 15.8a1.8 1.8 0 0 0 3.4 0" />
        </svg>
        {inbox.unread > 0 && (
          <span data-testid="bell-count" className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
            {Math.min(99, inbox.unread)}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[90]" onClick={() => setOpen(false)} />
            <div
              role="dialog"
              aria-label="Notifications"
              className="fixed z-[100] max-h-[70vh] overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-lift)] ring-1 ring-indigo-100"
              style={{ top: pos.top, left: pos.left, width: pos.wide ? "calc(100vw - 2rem)" : "24rem" }}
            >
              <div className="flex items-center justify-between border-b border-indigo-100 px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">Notifications</p>
                {inbox.unread > 0 && (
                  <button onClick={() => markAllRead()} className="text-xs font-medium text-indigo-600 hover:text-indigo-800">
                    Mark all read
                  </button>
                )}
              </div>
              <div className="max-h-[52vh] overflow-y-auto">
                {inbox.items.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-slate-500">You&apos;re all caught up. Read notifications are in View all.</p>
                ) : (
                  inbox.items.map((i) => (
                    <div key={i.id} data-testid="bell-item" className="flex items-start gap-1 border-b border-indigo-50 bg-indigo-50/30 pr-2 hover:bg-indigo-50/50">
                      <button onClick={() => openItem(i)} className="block min-w-0 flex-1 px-4 py-3 text-left">
                        <div className="flex items-start gap-2">
                          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-indigo-600" />
                          <div className="min-w-0">
                            <p className="text-[11px] font-medium uppercase tracking-wide text-indigo-600">{labelOf(i.type)}</p>
                            <p className="text-sm font-medium text-slate-900">{i.title}</p>
                            <p className="mt-0.5 line-clamp-3 text-xs text-slate-500">{i.body}</p>
                            <p className="mt-1 text-[11px] text-slate-400">{ago(i.createdAt)}</p>
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => void markRead(i.id)}
                        aria-label={`Mark "${i.title}" as read`}
                        title="Mark as read"
                        className="mt-2.5 shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-white hover:text-indigo-700"
                      >
                        Mark read
                      </button>
                    </div>
                  ))
                )}
              </div>
              <Link href="/dashboard/notifications" onClick={() => setOpen(false)} className="block border-t border-indigo-100 px-4 py-3 text-center text-sm font-medium text-indigo-600 hover:bg-indigo-50/50">
                View all notifications
              </Link>
            </div>
          </>,
          document.body
        )}
    </>
  );
}
