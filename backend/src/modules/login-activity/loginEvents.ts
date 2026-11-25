import type { Request } from "express";
import { prisma } from "../../lib/prisma.js";
import { normalizeIp, type Verdict } from "../../lib/ipPolicy.js";
import { cleanUserAgent, parseUserAgent } from "../../lib/userAgent.js";
import { recordLogin } from "../../lib/securityLog.js";

// ---------------------------------------------------------------------------
// LOGIN ACTIVITY (recording). One row per authentication attempt in `login_events`: success, failed, or blocked by the network rule, with the device
// the browser reported and, for a success, the session's later life (last activity, logout). Times are the SERVER's; the address is the one Express
// derived with `trust proxy` (a client cannot choose it). Never stored: passwords, tokens, anything secret. The typed username is kept as typed.
//
// Before the migration the table does not exist: nothing here throws, and when the network policy is on the attempt falls back to the Audit log.
// Approximate location: there is NO location source yet, so country/region/city stay empty and the screens say "Location not available". They are
// never filled from the browser. When a source is added later it is an approximation from the IP address, not a verified physical location.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/login_events/.test(msg) && /does not exist|relation/.test(msg));
};

let readyValue = false;
let readyCheckedAt = 0;
let readyChecking: Promise<boolean> | null = null;
export async function loginEventsReady(): Promise<boolean> {
  if (readyValue) return true;
  if (readyChecking) return readyChecking; // callers share the one check in flight (never answer "not ready" to a second caller)
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  readyChecking = (async () => {
    try {
      await prisma.loginEvent.findFirst({ select: { id: true } });
      readyValue = true;
    } catch (e) {
      if (!isMissingTable(e)) throw e;
      readyValue = false;
    }
    return readyValue;
  })().finally(() => { readyChecking = null; });
  return readyChecking;
}

export type Outcome = "SUCCESS" | "FAILED" | "BLOCKED";

export const REASON_TEXT: Record<string, string> = {
  INVALID_CREDENTIALS: "Wrong password or unknown account",
  ACCOUNT_INACTIVE: "Account is not active",
  IP_NOT_ALLOWED: "Network not authorised",
  TOO_MANY_ATTEMPTS: "Too many attempts, temporarily locked",
  OTHER: "Sign-in failed",
};

import { findLooseUserId } from "../../lib/employeeIdMatch.js";

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

async function findAccount(username: string) {
  if (!username) return null;
  try {
    const exact = await prisma.user.findFirst({
      where: { OR: [{ employeeCode: { equals: username, mode: "insensitive" } }, { email: { equals: username, mode: "insensitive" } }] },
      select: { id: true, platformId: true, employeeCode: true },
    });
    if (exact || username.includes("@")) return exact;
    // the same loose ID the sign-in accepts, so a failed attempt is filed under the right person
    const looseId = await findLooseUserId(username);
    return looseId ? await prisma.user.findUnique({ where: { id: looseId }, select: { id: true, platformId: true, employeeCode: true } }) : null;
  } catch {
    return null;
  }
}

const recentThrottle = new Map<string, number>();

/**
 * Records one authentication attempt. Never throws. `userId`/`platformId` are known for a success; for a failure or a block the typed name is matched
 * to an account only to attribute the row (so the owner of the account can see that someone tried it). An unknown name stays unattributed.
 */
export async function recordAuthAttempt(
  req: Request,
  ip: string | null,
  verdict: Verdict,
  o: { username: unknown; outcome: Outcome; reason?: string | null; userId?: string | null; platformId?: string | null; sessionId?: string | null; expiresAt?: Date | null; credentialsOk?: boolean | null }
): Promise<void> {
  try {
    const username = clean(o.username, 80);
    // a lockout repeats on every click: one row per address + name per minute
    if (o.reason === "TOO_MANY_ATTEMPTS") {
      const key = `${normalizeIp(ip) ?? "?"}|${username.toLowerCase()}`;
      if (Date.now() - (recentThrottle.get(key) ?? 0) < 60_000) return;
      if (recentThrottle.size > 2000) recentThrottle.clear();
      recentThrottle.set(key, Date.now());
    }
    if (await loginEventsReady()) {
      let userId = o.userId ?? null;
      let platformId = o.platformId ?? null;
      let employeeCode: string | null = null;
      const acc = userId ? { id: userId, platformId, employeeCode: null as string | null } : await findAccount(username);
      if (acc) {
        userId = acc.id;
        platformId = acc.platformId ?? platformId;
        if (acc.employeeCode) employeeCode = acc.employeeCode;
      }
      if (userId && !employeeCode) {
        employeeCode = (await prisma.user.findUnique({ where: { id: userId }, select: { employeeCode: true } }).catch(() => null))?.employeeCode ?? null;
      }
      const device = parseUserAgent(req.headers["user-agent"]);
      await prisma.loginEvent.create({
        data: {
          result: o.outcome,
          reason: o.reason ?? null,
          wouldBlock: verdict.wouldBlock,
          mode: verdict.mode,
          userId,
          platformId,
          employeeCode,
          username: username || null,
          ip: normalizeIp(ip),
          browserName: device.browserName,
          browserVersion: device.browserVersion,
          osName: device.osName,
          osVersion: device.osVersion,
          deviceType: device.deviceType,
          userAgent: cleanUserAgent(req.headers["user-agent"]),
          sessionId: o.outcome === "SUCCESS" ? o.sessionId ?? null : null,
          expiresAt: o.outcome === "SUCCESS" ? o.expiresAt ?? null : null,
          lastActiveAt: o.outcome === "SUCCESS" ? new Date() : null,
        },
        select: { id: true },
      });
      return;
    }
    // Before the migration: the network policy keeps its own record in the Audit log (nothing at all when the policy is off).
    if (verdict.mode !== "off" && (o.outcome === "BLOCKED" || verdict.wouldBlock || o.outcome === "SUCCESS")) {
      await recordLogin(req, ip, verdict, { username: o.username, userId: o.userId ?? null, platformId: o.platformId ?? null, credentialsOk: o.credentialsOk ?? (o.outcome === "SUCCESS" ? true : o.outcome === "BLOCKED" ? null : false) });
    }
  } catch (e) {
    console.error("[login activity] could not record an attempt:", e);
  }
}

// ---- last activity: at most once a minute per session ----
const lastStamp = new Map<string, number>();
export function stampActivity(sessionId: string): void {
  const now = Date.now();
  if (now - (lastStamp.get(sessionId) ?? 0) < 60_000) return;
  if (lastStamp.size > 5000) lastStamp.clear();
  lastStamp.set(sessionId, now);
  void (async () => {
    try {
      if (!(await loginEventsReady())) return;
      await prisma.loginEvent.updateMany({ where: { sessionId, loggedOutAt: null }, data: { lastActiveAt: new Date(now) } });
    } catch (e) {
      console.error("[login activity] could not stamp activity:", e);
    }
  })();
}

/** The person pressed Logout: stamp it once (the database refuses to move it afterwards). */
export async function markLogout(sessionId: string, userId: string): Promise<boolean> {
  try {
    if (!(await loginEventsReady())) return false;
    const now = new Date();
    const r = await prisma.loginEvent.updateMany({ where: { sessionId, userId, loggedOutAt: null }, data: { loggedOutAt: now, lastActiveAt: now } });
    lastStamp.delete(sessionId);
    return r.count > 0;
  } catch (e) {
    console.error("[login activity] could not record a logout:", e);
    return false;
  }
}

// ---- retention ----
export const RETENTION_FLOOR_DAYS = 90; // the database refuses to delete anything younger than this, whatever the setting
export function retentionDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.LOGIN_ACTIVITY_RETENTION_DAYS);
  return Number.isInteger(n) && n >= RETENTION_FLOOR_DAYS ? n : 180; // 6 months unless the server says longer
}

export async function purgeOldLoginEvents(now = new Date(), days = retentionDays()): Promise<number> {
  try {
    if (!(await loginEventsReady())) return 0;
    // never reach below the floor, whatever was asked (the database refuses it too)
    const cutoff = new Date(now.getTime() - Math.max(days, RETENTION_FLOOR_DAYS) * 86_400_000);
    const r = await prisma.loginEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return r.count;
  } catch (e) {
    console.error("[login activity] could not remove old history:", e);
    return 0;
  }
}

/** Removes history older than the retention period; checked every 6 hours. */
export function startLoginActivityPurge(): void {
  const run = async () => {
    const n = await purgeOldLoginEvents();
    if (n > 0) console.log(`[login activity] removed ${n} login record(s) older than ${retentionDays()} days`);
  };
  setTimeout(() => void run(), 60_000).unref();
  setInterval(() => void run(), 6 * 3_600_000).unref();
}
