"use client";

// Real-time task updates.
//
// One shared Socket.IO connection to the BACKEND (the same host the REST API uses, from API_BASE), never to the
// frontend's own address: the frontend may be on Vercel, which cannot host a persistent socket server.
//
// The server only ever sends a SIGNAL ("a task of someone you may see changed"), never task content. A page
// reacts by re-asking its normal API, so the database stays the single source of truth and the page's own
// person / tab / date filters are untouched.
//
// If the socket is down, `connected` is false and the page falls back to its ordinary polling. When the socket
// comes back the page is told to reload at once, so nothing that happened in between is missed.

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE, getToken } from "./api";

// "https://backend.example.com/api" -> "https://backend.example.com"
const SOCKET_URL = API_BASE.replace(/\/api\/?$/, "");

// Every signal carries an eventId (so a duplicate delivery can be ignored) and nothing else that matters here.
type Signal = { eventId: string };

let socket: Socket | null = null;
let subscribers = 0;

function acquire(): Socket {
  subscribers += 1;
  if (!socket) {
    socket = io(SOCKET_URL, {
      // The token is read each time a connection is made, so a reconnect always uses the current one.
      auth: (cb) => cb({ token: getToken() ?? "" }),
      transports: ["websocket", "polling"], // long-polling only as a fallback when websockets are blocked
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });
  }
  return socket;
}

function release() {
  subscribers = Math.max(0, subscribers - 1);
  if (subscribers === 0 && socket) {
    socket.disconnect();
    socket = null;
  }
}

/** Tasks: calls `onChange` whenever a task the user may see has changed. */
export const useTaskRealtime = (onChange: () => void) => useRealtime(["tasks:changed"], onChange);

/** Policies: calls `onChange` whenever a policy that concerns the user has changed. */
export const usePolicyRealtime = (onChange: () => void) => useRealtime(["policies:changed"], onChange);

/**
 * Calls `onChange` (debounced) whenever one of the named signals arrives, and once after every reconnect.
 * Returns whether the live connection is currently up, so the page can slow its polling down while it is.
 * All hooks share the ONE connection above; none opens its own.
 */
export function useRealtime(events: string[], onChange: () => void): { connected: boolean } {
  const eventKey = events.join("|");
  const [connected, setConnected] = useState(false);
  const handler = useRef(onChange);
  useEffect(() => {
    handler.current = onChange;
  });

  useEffect(() => {
    const s = acquire();
    const seen = new Set<string>(); // ignore a duplicate delivery of the same event
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hadReady = false;

    // Several events in a burst (a manager approving five tasks) become one refetch.
    const poke = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => handler.current(), 250);
    };

    const onSignal = (e: Signal) => {
      if (!e?.eventId || seen.has(e.eventId)) return;
      seen.add(e.eventId);
      if (seen.size > 200) seen.delete(seen.values().next().value as string);
      poke();
    };
    const onReady = () => {
      setConnected(true);
      if (hadReady) poke(); // after a RE-connect, catch up on anything missed while offline
      hadReady = true;
    };
    const onDown = () => setConnected(false);

    const names = eventKey.split("|");
    for (const name of names) s.on(name, onSignal);
    s.on("ready", onReady);
    s.on("disconnect", onDown);
    s.on("connect_error", onDown);
    if (s.connected) setTimeout(onReady, 0);

    // Team membership can change while a page stays open: ask the server to recompute this socket's rooms.
    const resync = setInterval(() => {
      if (s.connected) s.emit("resync");
    }, 5 * 60_000);

    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(resync);
      for (const name of names) s.off(name, onSignal);
      s.off("ready", onReady);
      s.off("disconnect", onDown);
      s.off("connect_error", onDown);
      release();
    };
  }, [eventKey]);

  return { connected };
}

/**
 * Chat typing. `typing` = ids of the other people who are typing in this conversation right now (each fades after 4 seconds without a
 * new hint). Call `notifyTyping()` as the person types; it sends at most one hint every 2 seconds. Shares the one connection.
 */
export function useChatTyping(conversationId: string | null): { typing: string[]; notifyTyping: () => void } {
  const [typing, setTyping] = useState<Record<string, number>>({});
  const last = useRef(0);

  useEffect(() => {
    if (!conversationId) return;
    const s = acquire();
    const onTyping = (e: { conversationId?: string; userId?: string }) => {
      if (e?.conversationId !== conversationId || !e.userId) return;
      const id = e.userId;
      setTyping((cur) => ({ ...cur, [id]: Date.now() + 4000 }));
    };
    s.on("chat:typing", onTyping);
    const sweep = setInterval(() => {
      setTyping((cur) => {
        const now = Date.now();
        const next = Object.fromEntries(Object.entries(cur).filter(([, until]) => until > now));
        return Object.keys(next).length === Object.keys(cur).length ? cur : next;
      });
    }, 1000);
    return () => {
      clearInterval(sweep);
      s.off("chat:typing", onTyping);
      release();
      setTyping({});
    };
  }, [conversationId]);

  const notifyTyping = () => {
    if (!conversationId || !socket?.connected || Date.now() - last.current < 2000) return;
    last.current = Date.now();
    socket.emit("chat:typing", { conversationId });
  };
  return { typing: Object.keys(typing), notifyTyping };
}
