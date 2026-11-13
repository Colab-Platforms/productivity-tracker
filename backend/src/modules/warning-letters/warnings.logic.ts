// Warning letters: the pure rules (no database), so they can be tested alone.
//
// A warning letter is stored as an ordinary `employee_documents` row (category OTHER, status APPROVED, no requirement) so it reuses the existing
// private file store. That table has no column for the reason, the letter name or the issue date, so they travel inside `rejectionReason` after a
// fixed marker. That marker is also how every other document screen recognises a letter and leaves it out (see `notWarningLetter`).
// The acknowledgment is `reviewedAt` (when) and `reviewedById` (the employee). Both are written once.

export const WL_MARKER = "[WARNING_LETTER]";

export type LetterMeta = { v: 1; title: string; reason: string; issueDate: string; source: "UPLOAD" | "TYPED" };

export const LIMITS = { titleMin: 3, titleMax: 120, reasonMin: 3, reasonMax: 1000, textMin: 20, textMax: 8000 };

export function encodeMeta(m: LetterMeta): string {
  return WL_MARKER + JSON.stringify(m);
}

export function isLetterRow(rejectionReason: string | null | undefined): boolean {
  return typeof rejectionReason === "string" && rejectionReason.startsWith(WL_MARKER);
}

/** The stored meta, or null when the row is not a warning letter or the text is damaged (never throws). */
export function decodeMeta(rejectionReason: string | null | undefined): LetterMeta | null {
  if (!isLetterRow(rejectionReason)) return null;
  try {
    const m = JSON.parse(String(rejectionReason).slice(WL_MARKER.length)) as Partial<LetterMeta>;
    if (typeof m.title !== "string" || typeof m.reason !== "string" || typeof m.issueDate !== "string") return null;
    return { v: 1, title: m.title, reason: m.reason, issueDate: m.issueDate, source: m.source === "TYPED" ? "TYPED" : "UPLOAD" };
  } catch {
    return null;
  }
}

/**
 * Prisma fragment that leaves warning letters OUT. A plain `NOT startsWith` would also drop rows whose column is null (SQL NULL logic), so the null
 * case is spelled out. Add it to every query that lists a person's checklist documents.
 */
export const notWarningLetter = {
  OR: [{ rejectionReason: null }, { NOT: { rejectionReason: { startsWith: WL_MARKER } } }],
};

const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim() : "");

export type IssueInput = { title: string; reason: string; text: string | null };

/** Validates the typed values; returns an error code (a key of the route MESSAGES) or the cleaned values. */
export function checkIssue(body: { title?: unknown; reason?: unknown; text?: unknown }, hasFile: boolean): { error: string } | { value: IssueInput } {
  const title = clean(body.title);
  const reason = clean(body.reason);
  const text = clean(body.text);
  if (title.length < LIMITS.titleMin) return { error: "TITLE_REQUIRED" };
  if (title.length > LIMITS.titleMax) return { error: "TITLE_TOO_LONG" };
  if (reason.length < LIMITS.reasonMin) return { error: "REASON_REQUIRED" };
  if (reason.length > LIMITS.reasonMax) return { error: "REASON_TOO_LONG" };
  if (hasFile && text) return { error: "FILE_OR_TEXT" }; // one way only, so there is never a doubt which letter was issued
  if (!hasFile && !text) return { error: "LETTER_REQUIRED" };
  if (text && text.length < LIMITS.textMin) return { error: "TEXT_TOO_SHORT" };
  if (text.length > LIMITS.textMax) return { error: "TEXT_TOO_LONG" };
  return { value: { title, reason, text: text || null } };
}

/** A PDF starts with "%PDF". The claimed type alone is not trusted for PDFs. */
export function looksLikePdf(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.subarray(0, 5).toString("latin1").startsWith("%PDF");
}

/** The issue date may be today or earlier (up to a year back); a future date is refused. Both arguments are YYYY-MM-DD. */
export function issueDateOk(issueIso: string, todayIso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueIso) || issueIso > todayIso) return false;
  const a = Date.UTC(+issueIso.slice(0, 4), +issueIso.slice(5, 7) - 1, +issueIso.slice(8, 10));
  const b = Date.UTC(+todayIso.slice(0, 4), +todayIso.slice(5, 7) - 1, +todayIso.slice(8, 10));
  return (b - a) / 86_400_000 <= 366;
}

/** May this viewer read / download this letter? The employee it is for, or HR/Admin with access to the company the letter belongs to. */
export function mayOpenLetter(v: { id: string; role: string; access: { all: boolean; ids: string[] } }, letter: { userId: string; platformId: string }): boolean {
  if (v.id === letter.userId) return true;
  if (v.role !== "HR" && v.role !== "ADMIN") return false;
  return v.access.all || v.access.ids.includes(letter.platformId);
}
