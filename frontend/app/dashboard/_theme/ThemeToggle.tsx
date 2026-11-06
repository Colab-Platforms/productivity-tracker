"use client";

import { useTheme } from "./ThemeContext";

const Sun = () => (
  <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="10" cy="10" r="3.2" />
    <path d="M10 2.5v1.6M10 15.9v1.6M2.5 10h1.6M15.9 10h1.6M4.7 4.7l1.1 1.1M14.2 14.2l1.1 1.1M15.3 4.7l-1.1 1.1M5.8 14.2l-1.1 1.1" />
  </svg>
);
const Moon = () => (
  <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M16.5 11.6A6.6 6.6 0 0 1 8.4 3.5a6.6 6.6 0 1 0 8.1 8.1Z" />
  </svg>
);

/** A row in the sidebar: shows the current theme and switches it. */
export function ThemeRow() {
  const { theme, toggle, saved } = useTheme();
  const dark = theme === "DARK";
  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={dark}
      aria-label={dark ? "Dark theme is on. Switch to light theme" : "Light theme is on. Switch to dark theme"}
      className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] text-[var(--nav-text)] hover:bg-[var(--nav-hover)] hover:text-slate-900"
      title={saved ? undefined : "Saved on this device only for now"}
    >
      <span className="text-slate-400">{dark ? <Moon /> : <Sun />}</span>
      <span className="flex-1 text-left">{dark ? "Dark theme" : "Light theme"}</span>
      <span aria-hidden className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${dark ? "bg-indigo-600" : "bg-slate-300"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${dark ? "left-[18px]" : "left-0.5"}`} />
      </span>
    </button>
  );
}

/** A compact icon button (mobile top bar by default; pass `className` for another look). It only switches the theme: the click never reaches a parent link or container. */
export function ThemeIconButton({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const dark = theme === "DARK";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggle();
      }}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      className={className ?? "rounded-lg p-2 text-slate-500 hover:bg-indigo-50 hover:text-indigo-700"}
    >
      {dark ? <Moon /> : <Sun />}
    </button>
  );
}
