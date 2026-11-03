"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export type Opt = { value: string; label: string; sub?: string };

// A dropdown you can type into. Used for companies, teams, managers and shifts,
// where a plain <select> with 60 names is slow to scan.
export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "Select…",
  disabled,
  invalid,
  clearLabel,
  emptyText = "Nothing matches",
  id,
  allowCreate,
}: {
  options: Opt[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  clearLabel?: string; // when set, an entry that clears the choice is offered
  emptyText?: string;
  id?: string;
  allowCreate?: boolean; // when set, whatever is typed that is not in the list can be used as a new value
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value) ?? (allowCreate && value ? { value, label: value } : undefined);
  const typed = query.trim();
  const canCreate = !!allowCreate && typed.length > 0 && !options.some((o) => o.label.toLowerCase() === typed.toLowerCase());

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter((o) => `${o.label} ${o.sub ?? ""}`.toLowerCase().includes(q))
      : options;
    return list.slice(0, 80);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function choose(v: string) {
    onChange(v);
    setOpen(false);
    setQuery("");
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && open && shown[active]) {
      e.preventDefault();
      choose(shown[active].value);
    } else if (e.key === "Enter" && open && canCreate) {
      e.preventDefault();
      choose(typed);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div ref={box} className="relative">
      <div
        className={`flex items-center rounded-xl border bg-white transition focus-within:ring-2 focus-within:ring-[var(--ring)] ${
          invalid ? "border-rose-300" : "border-indigo-200 focus-within:border-indigo-500"
        } ${disabled ? "opacity-60" : ""}`}
      >
        <input
          id={id}
          disabled={disabled}
          value={open ? query : (selected?.label ?? "")}
          placeholder={selected ? selected.label : placeholder}
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onKeyDown={onKey}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          className="min-w-0 flex-1 rounded-xl bg-transparent px-3 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400"
        />
        <svg viewBox="0 0 20 20" className="mr-3 h-4 w-4 shrink-0 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m5 8 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {open && !disabled && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1.5 max-h-60 w-full overflow-y-auto rounded-xl bg-white py-1.5 text-sm shadow-[var(--shadow-lift)] ring-1 ring-indigo-100"
        >
          {clearLabel && (
            <li>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose("")}
                className="block w-full px-3.5 py-2 text-left text-slate-500 hover:bg-indigo-50"
              >
                {clearLabel}
              </button>
            </li>
          )}
          {canCreate && (
            <li>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(typed)}
                className="block w-full px-3.5 py-2 text-left font-medium text-indigo-700 hover:bg-indigo-50"
              >
                Use &ldquo;{typed}&rdquo; as a new one
              </button>
            </li>
          )}
          {shown.length === 0 && !canCreate && <li className="px-3.5 py-3 text-slate-400">{emptyText}</li>}
          {shown.map((o, i) => (
            <li key={o.value}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o.value)}
                className={`flex w-full items-baseline justify-between gap-3 px-3.5 py-2 text-left ${
                  i === active ? "bg-indigo-50" : ""
                } ${o.value === value ? "font-medium text-indigo-700" : "text-slate-800"} hover:bg-indigo-50`}
              >
                <span className="truncate">{o.label}</span>
                {o.sub && <span className="shrink-0 text-xs text-slate-400">{o.sub}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
