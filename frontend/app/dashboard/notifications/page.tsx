"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";
import { useNotifications } from "../_notifications/NotificationsContext";
import { ago, labelOf, stamp, type Item } from "../_notifications/types";

// ---------------------------------------------------------------------------
// NOTIFICATION CENTRE
// Everything that has been sent to you, newest first: all of it, only what you have not read yet, or only what you have read.
// Reading something never deletes it: it leaves the bell and the Unread list and stays here under All and Read.
// Notifications are stored, so anything that arrived while you were away is here. Clicking one marks it read
// and opens the related screen. It updates by itself when something new arrives.
// ---------------------------------------------------------------------------

type Page = { unread: number; total: number; items: Item[]; hasMore: boolean; next: string | null };
type Filter = "all" | "unread" | "read";

export default function NotificationCentre() {
  const router = useRouter();
  const { markRead: readInBell, markAllRead: readAllInBell } = useNotifications();
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<Item[]>([]);
  const [meta, setMeta] = useState<{ unread: number; total: number; hasMore: boolean; next: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const p = await apiGet<Page>(`/notifications/page?filter=${filter}&limit=25`);
      setItems(p.items);
      setMeta({ unread: p.unread, total: p.total, hasMore: p.hasMore, next: p.next });
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);
  useRealtime(["notifications:changed"], load); // a new one appears here without a refresh

  async function loadMore() {
    if (!meta?.next || more) return;
    setMore(true);
    try {
      const p = await apiGet<Page>(`/notifications/page?filter=${filter}&limit=25&before=${encodeURIComponent(meta.next)}`);
      setItems((cur) => [...cur, ...p.items.filter((n) => !cur.some((c) => c.id === n.id))]);
      setMeta({ unread: p.unread, total: p.total, hasMore: p.hasMore, next: p.next });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMore(false);
    }
  }

  // Applied on screen immediately, then saved (the shared inbox also updates the bell and badge at once).
  // Unread list: the item leaves it. All list: it stays and loses its dot. Read list: unchanged (it was not there).
  function showRead(ids: string[] | "all") {
    const now = new Date().toISOString();
    const hit = (n: Item) => !n.readAt && (ids === "all" || ids.includes(n.id));
    setMeta((m) => (m ? { ...m, unread: ids === "all" ? 0 : Math.max(0, m.unread - items.filter(hit).length) } : m));
    setItems((cur) => (filter === "unread" ? cur.filter((n) => !hit(n)) : cur.map((n) => (hit(n) ? { ...n, readAt: now } : n))));
  }

  async function open(n: Item) {
    if (!n.readAt) {
      showRead([n.id]);
      await readInBell(n.id);
    }
    if (n.link) router.push(n.link);
    else void load();
  }
  async function markOne(n: Item) {
    showRead([n.id]);
    await readInBell(n.id);
    void load();
  }
  async function markAll() {
    showRead("all");
    await readAllInBell();
    void load();
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Notifications</h1>
          <p className="mt-1 text-sm text-slate-500">Everything sent to you. Anything that arrived while you were away is kept here.</p>
        </div>
        <button onClick={markAll} disabled={!meta || meta.unread === 0} className="rounded-xl border border-indigo-100 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          Mark all as read
        </button>
      </div>

      <div role="tablist" className="inline-flex rounded-xl bg-white p-1 shadow-[var(--shadow-card)]">
        {([["all", "All notifications"], ["unread", "Unread"], ["read", "Read"]] as [Filter, string][]).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={filter === key} onClick={() => { if (key === filter) return; setLoading(true); setFilter(key); }} className={"rounded-lg px-4 py-2 text-sm font-medium " + (filter === key ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50")}>
            {label}
            {key === "unread" && meta && meta.unread > 0 && <span className={"ml-2 rounded-full px-1.5 py-0.5 text-[11px] " + (filter === key ? "bg-white/20" : "bg-rose-50 text-rose-600")}>{meta.unread}</span>}
          </button>
        ))}
      </div>

      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">Couldn&apos;t load your notifications: {error}</p>}

      <section className="overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        {loading ? (
          <div className="space-y-2 p-6" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14" />)}</div>
        ) : items.length === 0 ? (
          <p className="px-6 py-14 text-center text-sm text-slate-500">{filter === "unread" ? "No unread notifications. You're all caught up." : filter === "read" ? "No read notifications yet." : "No notifications yet."}</p>
        ) : (
          <ul className="divide-y divide-indigo-50">
            {items.map((n) => (
              <li key={n.id} className={"flex items-start gap-3 px-5 py-4 " + (n.readAt ? "" : "bg-indigo-50/30")}>
                <span className={"mt-2 h-2 w-2 shrink-0 rounded-full " + (n.readAt ? "bg-transparent" : "bg-indigo-600")} aria-label={n.readAt ? "Read" : "Unread"} />
                <button onClick={() => open(n)} className="min-w-0 flex-1 text-left">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-indigo-600">{labelOf(n.type)}</p>
                  <p className="mt-0.5 text-sm font-semibold text-slate-900">{n.title}</p>
                  <p className="mt-0.5 text-sm text-slate-600">{n.body}</p>
                  <p className="mt-1 text-xs text-slate-400" title={stamp(n.createdAt)}>{stamp(n.createdAt)} · {ago(n.createdAt)}</p>
                </button>
                {!n.readAt && (
                  <button onClick={() => markOne(n)} className="shrink-0 rounded-lg border border-indigo-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                    Mark read
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {meta?.hasMore && (
          <div className="border-t border-indigo-50 p-4 text-center">
            <button onClick={loadMore} disabled={more} className="rounded-xl border border-indigo-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              {more ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </section>
      {meta && <p className="text-xs text-slate-400">{meta.total} in total · {meta.unread} unread · {meta.total - meta.unread} read</p>}
    </div>
  );
}
