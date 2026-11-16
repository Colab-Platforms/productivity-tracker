// Deleting a task (soft delete by its tagged manager): the rules that need no database. Pure, so they can be tested on their own.

export const DELETE_REASONS = {
  WRONG_EMPLOYEE: "Assigned to the wrong employee",
  WRONG_PROJECT: "Submitted under the wrong project",
  MISTAKE: "Approved or rated by mistake",
  DUPLICATE: "Duplicate task",
  OTHER: "Other",
} as const;

export type DeleteReasonCode = keyof typeof DELETE_REASONS;
export const DELETE_REASON_CODES = Object.keys(DELETE_REASONS) as DeleteReasonCode[];
export const NOTE_MIN = 3;
export const NOTE_MAX = 300;

export const reasonLabel = (code: string): string => (DELETE_REASONS as Record<string, string>)[code] ?? code;

/**
 * The reason a manager gave. A reason from the list is always needed; "Other" needs a written note of at least 3 characters; for the others the
 * note is optional. A note is never longer than 300 characters.
 */
export function checkDeletion(input: { reasonCode?: unknown; note?: unknown }): { reasonCode: DeleteReasonCode; reasonNote: string | null } {
  const code = typeof input.reasonCode === "string" ? input.reasonCode : "";
  if (!DELETE_REASON_CODES.includes(code as DeleteReasonCode)) throw new Error("BAD_DELETE_REASON");
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > NOTE_MAX) throw new Error("DELETE_NOTE_TOO_LONG");
  if (code === "OTHER" && note.length < NOTE_MIN) throw new Error("DELETE_NOTE_REQUIRED");
  return { reasonCode: code as DeleteReasonCode, reasonNote: note || null };
}
