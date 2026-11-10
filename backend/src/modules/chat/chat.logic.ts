// Pure rules for chat. No database, no network: easy to test.

export const LIMITS = { message: 4000, title: 80, groupMembers: 100, perMinute: 30, page: 50, preview: 90 } as const;
/** A sender can change the text of a message for this long after sending it. Deleting has no time limit. */
export const EDIT_WINDOW_MS = 15 * 60_000;
export const canEditNow = (sentAt: Date, now: number = Date.now()) => now - sentAt.getTime() <= EDIT_WINDOW_MS;

/** The same two people always get the same key, whoever starts the chat. */
export const directKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Message text: trimmed, must not be empty, must not be too long. Throws a code the route maps. */
export function cleanMessage(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("MESSAGE_EMPTY");
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) throw new Error("MESSAGE_EMPTY");
  if (text.length > LIMITS.message) throw new Error("MESSAGE_TOO_LONG");
  return text;
}

export function cleanTitle(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new Error("TITLE_INVALID");
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length > LIMITS.title) throw new Error("TITLE_TOO_LONG");
  return t || null;
}

/** A list of user ids from the client: strings only, no repeats, never the caller. */
export function cleanIds(raw: unknown, selfId: string): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === "string"))].filter((x) => x !== selfId);
}

export const previewOf = (body: string, deleted: boolean) => (deleted ? "Message deleted" : body.replace(/\s+/g, " ").slice(0, LIMITS.preview));

/** Messages sent by others after the member last read the chat. */
export const isUnread = (m: { senderId: string; createdAt: Date; deletedAt: Date | null }, me: string, lastReadAt: Date) =>
  m.senderId !== me && !m.deletedAt && m.createdAt.getTime() > lastReadAt.getTime();

/** A small in-memory limiter: at most `max` sends per person per minute. */
export function makeLimiter(max: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (v.every((x) => t - x >= 60_000)) hits.delete(k);
    return true;
  };
}
