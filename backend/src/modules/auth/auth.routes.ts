import { Router } from "express";
import * as authService from "./auth.service.js";
import { requireAuth, requireRole } from "../../middlewares/auth.js";
import { clientIp } from "../../lib/clientIp.js";
import { evaluate, policyFromEnv } from "../../lib/ipPolicy.js";
import { prisma } from "../../lib/prisma.js";
import { photoStamps } from "../photos/photos.service.js";
import { isOwnerAdmin } from "../../lib/owner.js";
import { accessFor } from "../../lib/companyAccess.js";
import { loginLimiter, clearLoginAttempts } from "../../middlewares/rateLimit.js";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { check } from "../../lib/securityLog.js";
import { markLogout, recordAuthAttempt } from "../login-activity/loginEvents.js";
import { ACCESS_DENIED_MESSAGE } from "../../lib/ipPolicy.js";
import { canRefresh, signSession } from "../../lib/session.js";

const router = Router();

// Brute-force guard on the credential check only (it ignores other paths).
router.use(loginLimiter);

router.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  // Network access policy, BEFORE the password is looked at: from an address that is not authorised nobody can try passwords or get a token, and the
  // answer is the same for every role. (Off by default; in monitor mode nobody is refused but the attempt is logged.)
  const net = check(req);
  if (net.verdict.blocked) {
    await recordAuthAttempt(req, net.ip, net.verdict, { username: email, outcome: "BLOCKED", reason: "IP_NOT_ALLOWED", credentialsOk: null });
    return res.status(403).json({ error: ACCESS_DENIED_MESSAGE, code: "IP_NOT_ALLOWED" });
  }

  // The id of THIS sign-in; it goes into the token so the login history can follow the session to its last activity and its logout.
  const sessionId = randomUUID();
  try {
    const result = await authService.login(email, password, sessionId);
    clearLoginAttempts(req);
    const exp = (jwt.decode(result.token) as { exp?: number } | null)?.exp;
    await recordAuthAttempt(req, net.ip, net.verdict, { username: email, outcome: "SUCCESS", userId: result.user.id, platformId: result.user.platform.id, sessionId, expiresAt: exp ? new Date(exp * 1000) : null, credentialsOk: true });
    return res.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN";
    await recordAuthAttempt(req, net.ip, net.verdict, { username: email, outcome: "FAILED", reason: code === "INVALID_CREDENTIALS" || code === "ACCOUNT_INACTIVE" ? code : "OTHER", credentialsOk: code === "INVALID_CREDENTIALS" ? false : null });

    if (code === "INVALID_CREDENTIALS") {
      return res.status(401).json({ error: "Email or password is incorrect" });
    }
    if (code === "ACCOUNT_INACTIVE") {
      return res.status(403).json({ error: "This account is no longer active" });
    }

    console.error("Login failed:", error);
    return res.status(500).json({ error: "Something went wrong signing in" });
  }
});

// Logout: stamps the end of THIS sign-in in the login history (once). The token itself is dropped by the browser; it is not revoked on the server.
// ADMIN ONLY: what the server sees for THIS request, to check the network rule on the live server (no secrets: the list itself is not returned).
router.get("/ip-check", requireAuth, requireRole("ADMIN"), (req, res) => {
  const p = policyFromEnv();
  const ip = clientIp(req);
  const v = evaluate(ip, p);
  res.json({
    detectedIp: ip,
    connectionAddress: req.socket?.remoteAddress ?? null,
    forwardedForHeader: typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].slice(0, 200) : null,
    mode: p.mode,
    allowedEntries: p.rules.length,
    problem: p.problem,
    thisRequestAllowed: v.allowed,
  });
});

router.post("/logout", requireAuth, async (req, res) => {
  const sid = req.user!.sid;
  if (sid) await markLogout(sid, req.user!.userId);
  return res.json({ ok: true });
});

// Renew a session that is still valid: the caller must already hold a VALID token (an expired or tampered one never reaches this point, because
// requireAuth refuses it first). The new token has the same sign-in id and original sign-in time, role and company come from the live record,
// and a sign-in older than JWT_MAX_SESSION_DAYS (default 30) is refused so a session can never become permanent. The old token is not revoked
// (tokens are stateless), so several tabs refreshing at once cannot invalidate each other.
router.post("/refresh", requireAuth, (req, res) => {
  const u = req.user!;
  if (!canRefresh(u.sst, u.iat)) {
    console.warn(`[auth] REFRESH_REFUSED session_too_old user=${u.userId}`);
    return res.status(401).json({ error: "INVALID_TOKEN", code: "SESSION_TOO_OLD" });
  }
  const token = signSession({ userId: u.userId, platformId: u.platformId, role: u.role, ...(u.sid ? { sid: u.sid } : {}), sst: u.sst ?? u.iat });
  const exp = (jwt.decode(token) as { exp?: number } | null)?.exp ?? null;
  console.log(`[auth] REFRESH_OK user=${u.userId} sid=${u.sid ?? "none"} newExpiry=${exp ? new Date(exp * 1000).toISOString() : "n/a"}`);
  return res.json({ token, expiresAt: exp ? exp * 1000 : null });
});

router.get("/me", requireAuth, async (req, res) => {
  const me = await authService.getMe(req.user!.userId);

  if (!me) {
    return res.status(404).json({ error: "User not found" });
  }

  return res.json(me);
});

// My Profile: the signed-in person's OWN details (read-only; the id always comes from the token, never from the request).
// Only fields the system actually holds are returned. Address and emergency contact are not stored anywhere yet, so they are not invented.
router.get("/me/profile", requireAuth, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true, firstName: true, lastName: true, email: true, phone: true, employeeCode: true, designation: true, role: true, status: true,
        dateOfJoining: true, probationEndDate: true, lastLoginAt: true, createdAt: true,
        platform: { select: { name: true } },
        reportsTo: { select: { firstName: true, lastName: true, designation: true } },
        shift: { select: { name: true, startTime: true, endTime: true } },
        teamMemberships: { where: { isActive: true }, select: { team: { select: { name: true } } } },
      },
    });
    if (!u) return res.status(404).json({ error: "User not found" });
    let employmentType: string | null = null;
    try {
      employmentType = (await prisma.employeeProfile.findUnique({ where: { userId: u.id }, select: { employmentType: true } }))?.employmentType ?? null;
    } catch {
      /* table not there: not set */
    }
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    // Admins are senior management: their profile shows which companies they act on (read from the same rule every module uses) and when the
    // account was made / last used. Nobody else gets these fields.
    let admin: { companies: "ALL" | string[]; lastLoginAt: string | null; createdAt: string } | null = null;
    if (String(u.role) === "ADMIN") {
      try {
        const a = await accessFor(u.id);
        const names = a.all ? [] : (await prisma.platform.findMany({ where: { id: { in: a.ids } }, select: { name: true }, orderBy: { name: "asc" } })).map((p) => p.name);
        admin = { companies: a.all ? "ALL" : names, lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null, createdAt: u.createdAt.toISOString() };
      } catch {
        admin = null;
      }
    }
    return res.json({
      admin,
      firstName: u.firstName, lastName: u.lastName, email: u.email, phone: u.phone, employeeCode: u.employeeCode, designation: u.designation,
      role: String(u.role), status: String(u.status), company: u.platform.name,
      dateOfJoining: day(u.dateOfJoining), probationEndDate: day(u.probationEndDate), employmentType,
      reportsTo: u.reportsTo ? { name: `${u.reportsTo.firstName} ${u.reportsTo.lastName}`.trim(), designation: u.reportsTo.designation } : null,
      shift: u.shift ? { name: u.shift.name, startTime: u.shift.startTime, endTime: u.shift.endTime } : null,
      departments: u.teamMemberships.map((m) => m.team.name),
      photoAt: (await photoStamps([u.id])).get(u.id) ?? null,
      documentsExempt: await isOwnerAdmin(u.id).catch(() => false),
    });
  } catch (e) {
    console.error("Profile error:", e);
    return res.status(500).json({ error: "Something went wrong" });
  }
});

export default router;