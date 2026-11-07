"use client";

// The compact desktop header: page title and breadcrumb, a people search (HR/Admin), the notification bell, the theme switch and the profile menu.
// It only reads what the layout already knows (the signed-in person, the current page); it changes no data and adds no request of its own.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Bell from "../_notifications/Bell";
import { ThemeIconButton } from "../_theme/ThemeToggle";
import Avatar from "../_photos/Avatar";
import { roleLabel } from "@/lib/roles";
import { homeFor } from "@/lib/roleHome";

type Person = { id: string; firstName: string; lastName: string; role: string; employeeCode: string | null; photoAt?: string | null };

const iconBtn = "flex h-9 w-9 items-center justify-center rounded-full text-slate-500 hover:bg-[var(--nav-hover)] hover:text-indigo-600";

export default function TopBar({ me, title, onSignOut }: { me: Person; title: string; onSignOut: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fullName = `${me.firstName} ${me.lastName}`.trim();
  // The people list (name or employee ID search) is an HR/Admin screen; for everyone else there is nothing to search, so no box is shown.
  const canSearch = me.role === "HR" || me.role === "ADMIN";

  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [menu]);

  return (
    <header className="sticky top-0 z-30 hidden items-center gap-4 border-b border-[var(--border)] bg-[var(--card)]/90 px-8 py-3 backdrop-blur lg:flex">
      <div className="min-w-0">
        <h1 className="truncate text-[17px] font-semibold leading-tight tracking-tight text-slate-900">{title}</h1>
        <nav aria-label="Breadcrumb" className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
          <Link href={homeFor(me.role)} className="hover:text-indigo-600 hover:underline">Home</Link>
          <span aria-hidden="true">/</span>
          <span className="truncate text-slate-700">{title}</span>
        </nav>
      </div>

      {canSearch && (
        <form
          role="search"
          onSubmit={(e) => { e.preventDefault(); const t = q.trim(); if (t) router.push(`/dashboard/employees?q=${encodeURIComponent(t)}`); }}
          className="ml-6 hidden max-w-sm flex-1 xl:block"
        >
          <label className="relative block">
            <span className="sr-only">Search employees by name or ID</span>
            <svg viewBox="0 0 20 20" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="9" cy="9" r="5.5" /><path d="m13.5 13.5 3 3" strokeLinecap="round" /></svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              maxLength={80}
              placeholder="Search employees by name or ID"
              className="h-9 w-full rounded-full border border-[var(--border)] bg-[var(--background)] pl-9 pr-3 text-[13px] text-slate-900 outline-none placeholder:text-slate-400"
            />
          </label>
        </form>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <ThemeIconButton className={iconBtn} />
        <Bell />
        <div ref={ref} className="relative ml-1">
          <button
            type="button"
            onClick={() => setMenu((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-label="Account menu"
            data-testid="account-menu"
            className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 hover:bg-[var(--nav-hover)]"
          >
            <Avatar userId={me.id} name={fullName} photoAt={me.photoAt} size={32} />
            <span className="hidden text-left leading-tight 2xl:block">
              <span className="block max-w-[10rem] truncate text-[13px] font-medium text-slate-900">{fullName}</span>
              <span className="block text-[11px] text-[var(--text-secondary)]">{roleLabel(me.role)}</span>
            </span>
            <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m5 8 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {menu && (
            <div role="menu" className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-xl bg-[var(--card)] py-1.5 text-sm shadow-[var(--shadow-lift)]">
              <div className="border-b border-[var(--border)] px-4 pb-2 pt-1">
                <p className="truncate font-medium text-slate-900">{fullName}</p>
                <p className="truncate text-[11px] text-[var(--text-secondary)]">{roleLabel(me.role)}{me.employeeCode ? ` · ${me.employeeCode}` : ""}</p>
              </div>
              <Link role="menuitem" href="/dashboard/profile" onClick={() => setMenu(false)} className="block px-4 py-2 text-slate-700 hover:bg-[var(--nav-hover)] hover:text-indigo-700">My Profile</Link>
              <Link role="menuitem" href="/change-password" onClick={() => setMenu(false)} className="block px-4 py-2 text-slate-700 hover:bg-[var(--nav-hover)] hover:text-indigo-700">Change password</Link>
              <button role="menuitem" type="button" onClick={() => { setMenu(false); onSignOut(); }} className="block w-full px-4 py-2 text-left text-slate-700 hover:bg-[var(--nav-hover)] hover:text-indigo-700">Logout</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
