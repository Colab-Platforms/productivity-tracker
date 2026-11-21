"use client";

// The segmented control at the top of Daily Tasks (no new sidebar item: the same page, a switch between its parts).
export type ViewTab = { key: string; label: string; badge?: number };

export function ViewTabs({ tabs, value, onChange, label = "Daily tasks views", scroll = false }: { tabs: ViewTab[]; value: string; onChange: (k: string) => void; label?: string; scroll?: boolean }) {
  return (
    <div role="tablist" aria-label={label} className={"inline-flex max-w-full rounded-xl bg-white p-1 shadow-[var(--shadow-card)] " + (scroll ? "w-max max-w-none flex-nowrap" : "flex-wrap")}>
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          type="button"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={"rounded-lg px-4 py-2 text-sm font-medium " + (scroll ? "whitespace-nowrap " : "") + (value === t.key ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50")}
        >
          {t.label}
          {t.badge ? <span className={"ml-2 rounded-full px-1.5 py-0.5 text-[11px] " + (value === t.key ? "bg-white/20 text-white" : "bg-indigo-50 text-indigo-700")}>{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}
