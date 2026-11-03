"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { initialsOf, matchPeople, moveActive, taskWord, withEveryone, type PickerPerson } from "./people";

// ---------------------------------------------------------------------------
// "Select Employee": ONE searchable dropdown that replaces the row of name chips on Team Tasks.
// Default "Everyone". Each person shows their name, employee code and how many tasks they have in the dates being viewed.
// Keyboard: Enter / Space / Down arrow opens, type to search, Up / Down / Home / End move, Enter chooses, Esc closes and returns focus to the
// button. Follows the standard combobox + listbox pattern so screen readers announce the choice and the number of matches.
// ---------------------------------------------------------------------------

export function EmployeePicker({ people, total, value, onChange }: { people: PickerPerson[]; total: number; value: string; onChange: (id: string) => void }) {
  const uid = useId();
  const labelId = `${uid}-label`;
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const all = useMemo(() => withEveryone(people, total), [people, total]);
  const shown = useMemo(() => matchPeople(all, query), [all, query]);
  const selected = all.find((p) => p.id === value) ?? all[0];
  const activeIdx = Math.min(active, Math.max(0, shown.length - 1));

  // click outside closes
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  // focus goes to the search box when it opens
  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);

  // keep the highlighted option in view while arrowing through a long list
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx, shown]);

  function openList() {
    setQuery("");
    const at = all.findIndex((p) => p.id === value);
    setActive(Math.max(0, at));
    setOpen(true);
  }
  function close(returnFocus = true) {
    setOpen(false);
    setQuery("");
    if (returnFocus) trigger.current?.focus();
  }
  function choose(p: PickerPerson) {
    onChange(p.id);
    close();
  }
  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(moveActive(activeIdx, e.key, shown.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[activeIdx]) choose(shown[activeIdx]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  const sub = (p: PickerPerson) => (p.id === "" ? "The whole reporting team" : p.code ?? "");

  return (
    <div ref={box} className="relative w-full sm:w-80">
      <span id={labelId} className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-400">Select Employee</span>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={labelId}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            openList();
          }
        }}
        className="flex h-10 w-full items-center gap-2.5 rounded-xl border border-indigo-200 bg-white pl-1.5 pr-3 text-left text-sm outline-none transition hover:bg-indigo-50/50 focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-200"
      >
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ${value ? "bg-indigo-600" : "bg-slate-400"}`}>
          {value ? initialsOf(selected.name) : "ALL"}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{selected.name}</span>
        <span className="shrink-0 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium tabular-nums text-indigo-700">{taskWord(selected.count)}</span>
        <svg viewBox="0 0 20 20" className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="m5 8 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-2xl border border-indigo-100 bg-white shadow-[var(--shadow-lift)] sm:w-[22rem]">
          <div className="border-b border-indigo-50 p-2">
            <input
              ref={search}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={shown[activeIdx] ? `${listId}-opt-${activeIdx}` : undefined}
              aria-label="Search employees by name or code"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
              placeholder="Search name or code…"
              className="h-9 w-full rounded-lg border border-indigo-100 bg-white px-3 text-sm text-slate-800 outline-none focus:border-indigo-400"
            />
          </div>
          <ul ref={list} id={listId} role="listbox" aria-labelledby={labelId} className="max-h-72 overflow-y-auto py-1">
            {shown.map((p, i) => {
              const isSel = p.id === value;
              const isActive = i === activeIdx;
              return (
                <li
                  key={p.id || "everyone"}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={isSel}
                  data-active={isActive}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep focus where it is until the choice is made
                    choose(p);
                  }}
                  className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm ${isActive ? "bg-indigo-50" : ""}`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ${p.id ? "bg-slate-400" : "bg-indigo-600"}`}>{p.id ? initialsOf(p.name) : "ALL"}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate ${isSel ? "font-semibold text-indigo-700" : "font-medium text-slate-800"}`}>{p.name}</span>
                    {sub(p) && <span className="block truncate text-xs text-slate-400">{sub(p)}</span>}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-500">{taskWord(p.count)}</span>
                  {isSel && (
                    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-indigo-600" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <path d="m4 10 4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </li>
              );
            })}
            {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-400">No one matches “{query.trim()}”.</li>}
          </ul>
          <p className="sr-only" aria-live="polite">{shown.length} {shown.length === 1 ? "match" : "matches"}</p>
        </div>
      )}
    </div>
  );
}
