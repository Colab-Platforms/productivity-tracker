import type { Request } from "express";
import { prisma } from "./prisma.js";
import { clientIp } from "./clientIp.js";
import { evaluate, normalizeIp, policyFromEnv, type Policy, type Verdict } from "./ipPolicy.js";

// ---------------------------------------------------------------------------
// SECURITY LOG for the network access policy. Written into the existing, immutable Audit log (module "Security"), so Admins read it where they already
// read everything else, and nothing here needs a new table. A row holds: what was typed as the username (never a password), the address the server
// saw, when, the result (Allowed / Blocked / Allowed in monitor mode) and why. No token, no password, no secret ever goes in.
//
//   every sign-in from an address that is not allowed  -> one row (Blocked, or "would be blocked" in monitor mode)
//   every successful sign-in (when the policy is on)   -> one row (Allowed)
//   a request on an existing session from an address that is not allowed -> one row per person + address every 10 minutes (so it cannot flood)
//
// Logging can never break a sign-in or a request: a failure is reported on the server console and swallowed.
// ---------------------------------------------------------------------------

const warned = new Set<string>();

/** The policy from the environment; a wrong setting is reported once on the server console (never to the browser). */
export function currentPolicy(): Policy {
  const p = policyFromEnv();
  if (p.problem && !warned.has(p.problem)) {
    warned.add(p.problem);
    console.error(`[network policy] ${p.problem}`);
  }
  return p;
}

/** The verdict for this request's address. */
export function check(req: Request): { ip: string | null; verdict: Verdict } {
  const ip = clientIp(req);
  return { ip, verdict: evaluate(ip, currentPolicy()) };
}

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

async function write(row: { actorId?: string | null; platformId?: string | null; targetUserId?: string | null; method: string; path: string; status: number; summary: string; ip: string | null; after: Record<string, unknown> }) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: row.actorId ?? null,
        platformId: row.platformId ?? null,
        method: row.method,
        path: row.path,
        status: row.status,
        module: "Security",
        action: "LOGIN",
        recordType: "Session",
        targetUserId: row.targetUserId ?? null,
        summary: row.summary,
        after: row.after as never,
        ip: row.ip,
      },
      select: { id: true },
    });
  } catch (e) {
    console.error("[network policy] could not write the security log:", e);
  }
}

const resultText = (v: Verdict) => (v.blocked ? "Blocked" : v.wouldBlock ? "Allowed (monitor mode: would be blocked)" : "Allowed");

/** A sign-in attempt. `userId` is known only after the password checked out; for a blocked attempt the typed name is matched to an account just to label the row. */
export async function recordLogin(req: Request, ip: string | null, v: Verdict, o: { username: unknown; userId?: string | null; platformId?: string | null; credentialsOk: boolean | null }) {
  const username = clean(o.username, 80);
  let userId = o.userId ?? null;
  let platformId = o.platformId ?? null;
  if (!userId && username) {
    try {
      const u = await prisma.user.findFirst({
        where: { OR: [{ employeeCode: { equals: username, mode: "insensitive" } }, { email: { equals: username, mode: "insensitive" } }] },
        select: { id: true, platformId: true },
      });
      if (u) { userId = u.id; platformId = u.platformId; }
    } catch { /* the row is still written, just without the link to an account */ }
  }
  const who = username || "(none)";
  await write({
    actorId: o.credentialsOk ? userId : null,
    platformId,
    targetUserId: userId,
    method: "POST",
    path: "/api/auth/login",
    status: v.blocked ? 403 : o.credentialsOk === false ? 401 : 200,
    summary: v.blocked ? `Sign-in BLOCKED from a network that is not authorised (${who})`
      : v.wouldBlock ? `Sign-in allowed in monitor mode, but would be blocked: network not authorised (${who})`
      : `Sign-in allowed from an authorised network (${who})`,
    ip: normalizeIp(ip),
    after: {
      username: username || null,
      result: resultText(v),
      reason: v.reason,
      mode: v.mode,
      credentialsOk: o.credentialsOk, // null when the check was refused before the password was looked at
      // The raw header as the client sent it, for diagnosing the proxy setup only: it is NOT what the decision used.
      forwardedForHeader: clean(req.headers["x-forwarded-for"], 120) || null,
    },
  });
}

// ---- requests on an existing session: one row per person + address every 10 minutes ----
const recent = new Map<string, number>();
const EVERY_MS = 10 * 60 * 1000;

export async function recordBlockedSession(ip: string | null, v: Verdict, who: { userId: string; platformId: string | null }, via: { method: string; path: string }) {
  const key = `${who.userId}|${normalizeIp(ip) ?? "?"}`;
  const now = Date.now();
  if (now - (recent.get(key) ?? 0) < EVERY_MS) return;
  if (recent.size > 5000) recent.clear();
  recent.set(key, now);
  await write({
    actorId: who.userId,
    platformId: who.platformId,
    targetUserId: who.userId,
    method: via.method,
    path: clean(via.path, 120),
    status: v.blocked ? 403 : 200,
    summary: v.blocked ? "Request BLOCKED: signed-in session used from a network that is not authorised" : "Signed-in session used from a network that is not authorised (monitor mode: would be blocked)",
    ip: normalizeIp(ip),
    after: { result: resultText(v), reason: v.reason, mode: v.mode, note: "Repeats from the same person and address are logged once every 10 minutes." },
  });
}
