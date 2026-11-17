"use client";

// The task card's Edit action: "Edit" for a pending or sent-back task, "Request correction" for an approved or rated one (disabled while one waits).
import type { EditableTask } from "./editTypes";

const Pencil = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5" aria-hidden="true">
    <path d="M3 17l3.5-.8L16 6.7a1.8 1.8 0 000-2.5l-.2-.2a1.8 1.8 0 00-2.5 0L3.8 13.5 3 17z" strokeLinejoin="round" />
  </svg>
);

export function EditButton({ task, onEdit, busy }: { task: EditableTask; onEdit: () => void; busy?: boolean }) {
  if (!task.editRoute || !task.version) return null; // assigned tasks, or the server does not offer editing yet
  const correction = task.editRoute === "CORRECTION";
  if (correction && task.pendingCorrection) return <span className="shrink-0 text-xs text-amber-700">Correction requested</span>;
  return (
    <button
      type="button"
      onClick={onEdit}
      disabled={busy}
      aria-label={correction ? `Request a correction to ${task.title}` : `Edit ${task.title}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-indigo-100 px-2 py-1 text-xs font-medium text-indigo-700 transition hover:bg-indigo-50 disabled:opacity-40"
    >
      <Pencil />
      {correction ? "Request correction" : "Edit"}
    </button>
  );
}
