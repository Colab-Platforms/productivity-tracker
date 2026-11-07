"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// A centred white dialog on a dimmed lavender-slate overlay. Esc closes it,
// the page behind stops scrolling, and focus moves into the dialog so keyboard
// users are not left tabbing through the page underneath.
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = "max-w-3xl",
  dismissible = true,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
  dismissible?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);

  // The newest onClose, kept in a ref. Callers usually pass a fresh inline function on every render, and a page with a live timer
  // (the Today page ticks every second) re-renders constantly. If onClose were a dependency of the effect below, the effect would
  // re-run every second and its focus() call would pull the keyboard out of whatever the person was typing in (a textarea showed a
  // cursor but ignored typing). So the effect depends only on `dismissible` and reads the latest onClose from here.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Move focus into the dialog once, when it opens, but never steal it from a field inside (an autoFocus input has it already).
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [dismissible]);

  // Rendered straight into <body>, so no parent (a transform, filter or animation on a page wrapper) can ever
  // shrink or offset the "full screen" overlay again.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-[#1E293B]/45 backdrop-blur-[2px]" onClick={dismissible ? onClose : undefined} />
      <div
        ref={panel}
        tabIndex={-1}
        className={`relative flex max-h-[94vh] w-full ${width} flex-col overflow-hidden rounded-t-3xl bg-white shadow-[var(--shadow-lift)] outline-none sm:rounded-3xl`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-indigo-100 px-5 py-4 sm:px-7 sm:py-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          {dismissible && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded-full p-1.5 text-slate-400 transition hover:bg-indigo-50 hover:text-slate-700"
            >
              <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="m5 5 10 10M15 5 5 15" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">{children}</div>
        {footer && <div className="border-t border-indigo-100 bg-[#F3F7F6] px-5 py-4 sm:px-7">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
