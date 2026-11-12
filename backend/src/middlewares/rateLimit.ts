import type { Request, Response, NextFunction } from "express";
import { clientIp } from "../lib/clientIp.js";

// ---------------------------------------------------------------------------
// RATE LIMIT
//
// Without this, anyone who knows an employee ID — and they're printed on
// payroll documents — can try passwords at machine speed. Ten attempts per
// fifteen minutes makes that pointless while never inconveniencing someone
// who genuinely mistyped.
//
// In memory on purpose: one backend process, no new dependency, no Redis.
// If this ever runs on more than one instance, this moves to the database.
// ---------------------------------------------------------------------------

type Entry = { count: number; firstAt: number; blockedUntil: number };

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const BLOCK_MS = 15 * 60 * 1000;

const attempts = new Map<string, Entry>();

// Stop the map growing forever on a long-running server.
setInterval(() => {
  const now = Date.now();
  for (const [key, e] of attempts) {
    if (now - e.firstAt > WINDOW_MS && now > e.blockedUntil) {
      attempts.delete(key);
    }
  }
}, WINDOW_MS).unref();

function clientKey(req: Request) {
  const ip = clientIp(req) || "unknown";

  // Keyed on IP **and** the identifier being tried, so one person fumbling
  // their own password never locks out a colleague behind the same office
  // router — while someone spraying many IDs from one address still gets
  // stopped.
  const who = String(req.body?.email ?? req.body?.identifier ?? "").toLowerCase();
  return `${ip}|${who}`;
}

export function loginLimiter(req: Request, res: Response, next: NextFunction) {
  // Only guard the credential check. /auth/me is called on every page load.
  if (!req.path.startsWith("/login")) return next();

  const key = clientKey(req);
  const now = Date.now();
  const entry = attempts.get(key);

  if (entry && now < entry.blockedUntil) {
    const mins = Math.ceil((entry.blockedUntil - now) / 60000);
    res.status(429).json({
      error: "TOO_MANY_ATTEMPTS",
      message: `Too many sign-in attempts. Try again in ${mins} minute${
        mins === 1 ? "" : "s"
      }, or ask HR to reset your password.`,
    });
    return;
  }

  if (!entry || now - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now, blockedUntil: 0 });
    return next();
  }

  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    entry.blockedUntil = now + BLOCK_MS;
    res.status(429).json({
      error: "TOO_MANY_ATTEMPTS",
      message:
        "Too many sign-in attempts. Try again in 15 minutes, or ask HR to reset your password.",
    });
    return;
  }

  next();
}

// Called after a successful sign-in so a correct password wipes the slate.
export function clearLoginAttempts(req: Request) {
  attempts.delete(clientKey(req));
}