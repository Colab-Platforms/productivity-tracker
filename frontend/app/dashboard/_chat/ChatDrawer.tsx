"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import ChatPanel from "./ChatPanel";

// The right-hand chat drawer. State lives in the dashboard layout (so the drawer stays open while you move between pages); this file is the
// context other parts use to open it (header icon, sidebar item, notification links through /dashboard/chat) and the drawer itself.
// Desktop: a panel on the right, below the header, the dashboard stays visible and usable. Phone: the whole screen.
export type ChatDrawerApi = { open: boolean; openChat: (conversationId?: string | null) => void; closeChat: () => void };
export const ChatDrawerContext = createContext<ChatDrawerApi>({ open: false, openChat: () => undefined, closeChat: () => undefined });
export const useChatDrawer = () => useContext(ChatDrawerContext);

export default function ChatDrawer({ open, activeId, onSelect, onClose }: { open: boolean; activeId: string | null; onSelect: (id: string | null) => void; onClose: () => void }) {
  // The panel is created the first time the drawer opens and then kept, so reopening is instant and a draft message is not lost.
  const [everOpened, setEverOpened] = useState(open);
  if (open && !everOpened) setEverOpened(true);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      // a dialog opened from inside the chat (New conversation, Group, Seen by) owns Escape first
      if (e.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]:not(#chat-drawer)')) onClose();
    };
    document.addEventListener("keydown", key);
    const opener = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>("input, button")?.focus(), 320);
    return () => {
      document.removeEventListener("keydown", key);
      clearTimeout(t);
      opener?.focus?.();
    };
  }, [open, onClose]);

  return (
    <aside
      id="chat-drawer"
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Chat"
      aria-hidden={!open}
      inert={!open}
      data-testid="chat-drawer"
      data-open={open}
      className={`fixed inset-0 z-[45] flex flex-col bg-[var(--card)] shadow-[var(--shadow-lift)] transition-[translate,visibility] duration-300 ease-out lg:inset-auto lg:bottom-0 lg:right-0 lg:top-16 lg:w-[420px] lg:border-l lg:border-[var(--border)] ${
        open ? "visible" : "invisible translate-x-full"
      }`}
    >
      {everOpened && <ChatPanel activeId={activeId} onSelect={onSelect} onClose={onClose} />}
    </aside>
  );
}
