"use client";

import { useState } from "react";

// Star ratings (1-5). Display-only <Stars /> for every screen that shows a rating, and <RateControl /> for the manager's rating box.
// The scale words are the only text: nothing here changes how a star counts (that is decided on the server).

export const STAR_WORD: Record<number, string> = { 1: "Poor", 2: "Needs improvement", 3: "Good", 4: "Very good", 5: "Excellent" };

function Star({ filled, size }: { filled: boolean; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className={filled ? "text-amber-500" : "text-slate-300"}>
      <path
        d="M10 1.8l2.5 5.3 5.8.8-4.2 4.1 1 5.8L10 15l-5.1 2.8 1-5.8L1.7 7.9l5.8-.8L10 1.8z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Read-only: filled stars for a rating, or "Not rated yet". */
export function Stars({ value, size = 14, showNumber = true, emptyText = "Not rated yet" }: { value: number | null | undefined; size?: number; showNumber?: boolean; emptyText?: string }) {
  if (value == null) return <span className="text-xs text-slate-400">{emptyText}</span>;
  const label = `${value} out of 5 stars`;
  return (
    <span className="inline-flex items-center gap-1" role="img" aria-label={label} title={`${value}/5 · ${STAR_WORD[Math.round(value)] ?? ""}`}>
      {[1, 2, 3, 4, 5].map((n) => <Star key={n} filled={n <= Math.round(value)} size={size} />)}
      {showNumber && <span className="ml-0.5 text-xs font-medium text-slate-600">{Number.isInteger(value) ? value : value.toFixed(1)}/5</span>}
    </span>
  );
}

/** Interactive 1-5 picker (radio group: click, or arrow keys / Home / End). */
export function StarPicker({ value, onChange, disabled, label = "Rating" }: { value: number | null; onChange: (n: number) => void; disabled?: boolean; label?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  function key(e: React.KeyboardEvent) {
    if (disabled) return;
    const cur = value ?? 0;
    let next = cur;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(5, cur + 1 || 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(1, cur - 1 || 1);
    else if (e.key === "Home") next = 1;
    else if (e.key === "End") next = 5;
    else return;
    e.preventDefault();
    onChange(next);
  }
  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <div role="radiogroup" aria-label={label} onKeyDown={key} onMouseLeave={() => setHover(null)} className="inline-flex gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} star${n === 1 ? "" : "s"}, ${STAR_WORD[n]}`}
            tabIndex={value === n || (value == null && n === 1) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(n)}
            onMouseEnter={() => setHover(n)}
            className="rounded p-0.5 transition hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-40"
          >
            <Star filled={n <= shown} size={24} />
          </button>
        ))}
      </div>
      <span className="min-w-[8rem] text-xs text-slate-500" aria-live="polite">{shown ? `${shown}/5 · ${STAR_WORD[shown]}` : "Pick a rating"}</span>
    </div>
  );
}

const COMMENT_MAX = 300;

/** The manager's rating box: stars, an optional comment, Save. */
export function RateControl({ initial, initialComment, busy, onSave, saveLabel = "Save rating" }: { initial?: number | null; initialComment?: string | null; busy: boolean; onSave: (rating: number, comment: string) => void; saveLabel?: string }) {
  const [stars, setStars] = useState<number | null>(initial ?? null);
  const [comment, setComment] = useState(initialComment ?? "");
  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[19rem]">
      <StarPicker value={stars} onChange={setStars} disabled={busy} />
      <textarea
        value={comment}
        maxLength={COMMENT_MAX}
        rows={2}
        disabled={busy}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional comment for the employee"
        className="w-full resize-y break-words rounded-xl border border-indigo-100 bg-white px-3 py-2 text-xs text-slate-800 [overflow-wrap:anywhere]"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-400">{comment.length}/{COMMENT_MAX}</span>
        <button
          type="button"
          disabled={busy || stars == null}
          onClick={() => stars != null && onSave(stars, comment.trim())}
          className="rounded-xl bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-700 disabled:opacity-40"
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
}
