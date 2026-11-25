// Pure rules about the stored sign-in token (no browser access here, so they can be tested). The server is the only judge of whether a token is
// valid; this only READS the expiry the token announces about itself, to decide when to ask for a fresh one while the session is still valid.

const SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Three dot-separated parts. Catches "undefined", "null", "" and half-written values that would otherwise be sent and refused as "jwt malformed". */
export const tokenShapeOk = (t: string | null | undefined): t is string => typeof t === "string" && SHAPE.test(t);

export type TokenTimes = { iat: number; exp: number };
/** issued-at and expiry (seconds) read from the token body; null when it cannot be read. Not a validity check. */
export function tokenTimes(t: string | null | undefined, decode: (b64: string) => string = (s) => atob(s)): TokenTimes | null {
  if (!tokenShapeOk(t)) return null;
  try {
    const b = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(decode(b + "=".repeat((4 - (b.length % 4)) % 4))) as { iat?: unknown; exp?: unknown };
    return typeof p.iat === "number" && typeof p.exp === "number" ? { iat: p.iat, exp: p.exp } : null;
  } catch {
    return null;
  }
}

/** Ask for a fresh token once less than half of the lifetime is left (and it has not already run out: an expired token cannot be renewed). */
export function shouldRefresh(times: TokenTimes | null, nowSec: number, lastTryMs: number, nowMs: number): boolean {
  if (!times) return false;
  const left = times.exp - nowSec;
  if (left <= 0) return false;
  if (nowMs - lastTryMs < 5 * 60_000) return false;
  return left < (times.exp - times.iat) / 2;
}

export type AuthVerdict = "RETRY" | "END" | "KEEP";
/**
 * A request came back "not authorised". Should the person be signed out? Only when the session itself is really gone.
 *  - nothing was sent: not our business (public screens)                      -> KEEP
 *  - another tab replaced the token while the request was in flight           -> RETRY with the new one
 *  - another tab signed out                                                   -> END
 *  - the token is provably expired, or the failing call was /auth/me itself   -> END
 *  - otherwise ask the server once (/auth/me): still valid means this single request failed for its own reason -> KEEP, else END
 */
export function decideAuth(a: { sent: string | null; current: string | null; code: string | undefined; path: string; probeOk: boolean | null }): AuthVerdict {
  if (!a.sent) return "KEEP";
  if (a.current && a.current !== a.sent) return "RETRY";
  if (!a.current) return "END";
  if (a.code === "TOKEN_EXPIRED" || a.code === "SESSION_TOO_OLD" || a.path === "/auth/me") return "END";
  if (a.probeOk === true) return "KEEP";
  if (a.probeOk === false) return "END";
  return "KEEP"; // the probe could not reach the server: never sign someone out because of a network problem
}

export const AUTH_CODES = ["INVALID_TOKEN", "NOT_AUTHENTICATED", "ACCOUNT_INACTIVE"];
export const isAuthFailure = (status: number, error: unknown) => status === 401 && AUTH_CODES.includes(String(error));

export function endMessage(code: string | undefined, error: unknown): string {
  if (code === "ACCOUNT_INACTIVE" || error === "ACCOUNT_INACTIVE") return "This account is no longer active. Please contact HR.";
  if (code === "TOKEN_EXPIRED" || code === "SESSION_TOO_OLD") return "Your session has expired. Please sign in again.";
  return "You were signed out because your session is no longer valid. Please sign in again.";
}
