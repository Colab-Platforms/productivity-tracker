import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { getPinnedCompany } from "../lib/deployment.js";
import { isSupervisor } from "../lib/supervisor.js";

// Every route past /auth/login runs through requireAuth. It reads the bearer
// token, verifies it, and hangs the result on req.user — which is what every
// service means by "viewerId". The global declaration is what makes req.user
// exist in TypeScript across the whole project.

export type AuthUser = {
  userId: string;
  platformId: string;
  role: string;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// The token proves who someone was when they signed in. It cannot know that
// they were suspended, exited or demoted afterwards, so every request also
// reads the live record. One indexed primary-key lookup per request; if it
// ever shows in a profile, cache it for a few seconds rather than removing it.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = String(req.headers.authorization ?? "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    res.status(401).json({ error: "NOT_AUTHENTICATED" });
    return;
  }

  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET as string
    ) as Partial<AuthUser>;

    if (!payload?.userId || !payload?.platformId) {
      res.status(401).json({ error: "INVALID_TOKEN" });
      return;
    }

    // Verified token past this point; anything below is a database check.
    const live = await prisma.user.findUnique({
      where: { id: String(payload.userId) },
      select: { status: true, role: true, platformId: true, platform: { select: { isActive: true } } },
    });

    if (!live || live.status === "SUSPENDED" || live.status === "EXITED") {
      res.status(401).json({ error: "ACCOUNT_INACTIVE" });
      return;
    }

    // A deactivated company is closed to everyone in it.
    if (live.platform && !live.platform.isActive) {
      res.status(403).json({ error: "COMPANY_INACTIVE" });
      return;
    }

    // A deployment pinned to one company only serves that company's people.
    const pinned = await getPinnedCompany();
    if (pinned && live.platformId !== pinned.id) {
      res.status(403).json({ error: "NOT_PART_OF_THIS_HRMS" });
      return;
    }

    // Role and company come from the record, not the token, so a demotion or
    // transfer takes effect on the next request instead of at token expiry.
    req.user = {
      userId: String(payload.userId),
      platformId: live.platformId,
      role: String(live.role),
    };

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      // Expired and tampered tokens look identical to the caller on purpose.
      res.status(401).json({ error: "INVALID_TOKEN" });
      return;
    }
    if (error instanceof Error && error.message === "PINNED_COMPANY_MISSING") {
      console.error("[auth] HRMS_COMPANY_SLUG does not match any company");
      res.status(503).json({ error: "This HRMS is not configured correctly." });
      return;
    }
    console.error("[auth]", error);
    res.status(500).json({ error: "Something went wrong." });
  }
}

/** Manager, HR or Admin, OR a Productivity Supervisor. Only for routers whose every route is a READ: a supervisor stays an EMPLOYEE, so any route
 *  that still uses requireRole("MANAGER"/"HR"/"ADMIN") refuses them. */
export async function requireMonitor(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: "NOT_AUTHENTICATED" });
    return;
  }
  if (["MANAGER", "HR", "ADMIN"].includes(req.user.role)) {
    next();
    return;
  }
  try {
    if (req.user.role === "EMPLOYEE" && (await isSupervisor(req.user.userId))) {
      next();
      return;
    }
  } catch (e) {
    console.error("[auth] supervisor check failed", e);
  }
  res.status(403).json({ error: "NOT_ALLOWED" });
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "NOT_AUTHENTICATED" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "NOT_ALLOWED" });
      return;
    }
    next();
  };
}
