import jwt from "jsonwebtoken";

// One place for the rules about a sign-in token.
//   * A token is a normal expiring JWT (lifetime = JWT_EXPIRES_IN). Nothing here lengthens it or accepts an expired one.
//   * A still-valid token can be swapped for a fresh one (POST /auth/refresh) so someone who is working is not cut off at the edge of the
//     lifetime. The swap keeps the SAME sign-in id (sid) and the original sign-in time (sst), and is refused once the sign-in is older than
//     JWT_MAX_SESSION_DAYS (default 30), so a session can never become permanent.
//   * Tokens are stateless, so two tabs refreshing at once cannot invalidate each other: every token stays valid until its own expiry.

export type TokenReason = "TOKEN_EXPIRED" | "TOKEN_MALFORMED" | "TOKEN_SIGNATURE" | "TOKEN_NOT_ACTIVE" | "TOKEN_PAYLOAD";

/** Why jsonwebtoken refused a token, as one of our own words. Never contains the token. */
export function reasonOf(err: unknown): TokenReason {
  if (err instanceof jwt.TokenExpiredError) return "TOKEN_EXPIRED";
  if (err instanceof jwt.NotBeforeError) return "TOKEN_NOT_ACTIVE";
  if (err instanceof jwt.JsonWebTokenError) return /signature/i.test(err.message) ? "TOKEN_SIGNATURE" : "TOKEN_MALFORMED";
  return "TOKEN_MALFORMED";
}

export function maxSessionSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const d = Number(env.JWT_MAX_SESSION_DAYS);
  return (Number.isFinite(d) && d >= 1 && d <= 365 ? d : 30) * 86400;
}

export type SessionClaims = { userId: string; platformId: string; role: string; sid?: string; sst?: number };

/** Signs a token. `sst` (the original sign-in time, seconds) is set on first sign-in and carried through every refresh. */
export function signSession(c: SessionClaims, now = Math.floor(Date.now() / 1000)): string {
  return jwt.sign(
    { userId: c.userId, platformId: c.platformId, role: c.role, ...(c.sid ? { sid: c.sid } : {}), sst: c.sst ?? now },
    process.env.JWT_SECRET as string,
    { expiresIn: process.env.JWT_EXPIRES_IN ?? "1d" } as jwt.SignOptions
  );
}

/** May this sign-in still be refreshed? `sst` falls back to the token's issue time (tokens made before sst existed). */
export function canRefresh(sst: number | undefined, iat: number | undefined, now = Math.floor(Date.now() / 1000), max = maxSessionSeconds()): boolean {
  const start = Number.isFinite(sst) ? (sst as number) : Number.isFinite(iat) ? (iat as number) : now;
  return now - start <= max;
}

// ---- diagnostics (never a token, a password or a secret) -------------------------------------------------------------------------------

const seen = new Map<string, number>();
/** One console line per reason + person + path per minute, so a broken client cannot flood the log. */
export function logAuthFailure(reason: string, token: string, method: string, path: string, now = Date.now()): void {
  let who = "unknown";
  try {
    // decode WITHOUT verifying, only to say whose token it claims to be (labelled unverified)
    const p = jwt.decode(token) as { userId?: string; sid?: string; exp?: number; iat?: number } | null;
    if (p?.userId) who = String(p.userId);
    const key = `${reason}|${who}|${path}`;
    if ((seen.get(key) ?? 0) > now - 60_000) return;
    seen.set(key, now);
    if (seen.size > 2000) for (const [k, t] of seen) if (t < now - 60_000) seen.delete(k);
    const exp = p?.exp ? new Date(p.exp * 1000).toISOString() : "n/a";
    const iat = p?.iat ? new Date(p.iat * 1000).toISOString() : "n/a";
    console.warn(`[auth] ${reason} user(unverified)=${who} issued=${iat} expires=${exp} ${method} ${path}`);
  } catch {
    console.warn(`[auth] ${reason} ${method} ${path}`);
  }
}

/** Server start check: without a secret nothing can be signed or verified. Weak secrets only warn (a live deployment must not fail to start). */
export function checkSecret(env: NodeJS.ProcessEnv = process.env): { ok: boolean; warning?: string } {
  const s = env.JWT_SECRET;
  if (!s || !s.trim()) return { ok: false };
  if (s === "change-me" || s.length < 16) return { ok: true, warning: "JWT_SECRET is short or still the sample value; use a long random string." };
  return { ok: true };
}
