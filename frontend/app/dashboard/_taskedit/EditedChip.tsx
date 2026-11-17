"use client";

// The "Edited" label with the last time the task really changed, and a badge while a correction request waits for the manager.
import { formatDateTime } from "@/lib/time";
import type { EditedInfo } from "./editTypes";

export function EditedChip({ edited, pending, onHistory }: { edited?: EditedInfo; pending?: boolean; onHistory?: () => void }) {
  if (!edited && !pending) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
      {edited && (
        <span data-testid="edited-chip" className="rounded-full bg-violet-50 px-2 py-0.5 font-medium text-violet-700">
          Edited{edited.at ? ` · ${formatDateTime(edited.at, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : ""}
        </span>
      )}
      {pending && <span data-testid="correction-chip" className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700">Correction requested</span>}
      {onHistory && (
        <button type="button" onClick={onHistory} className="font-medium text-indigo-700 underline-offset-2 hover:underline">
          History
        </button>
      )}
    </span>
  );
}
