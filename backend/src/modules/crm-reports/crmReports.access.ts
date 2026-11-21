import type { NextFunction, Request, Response } from "express";

// WHO MAY USE CRM REPORTS: exactly one person, the user id in CRM_REPORTS_USER_ID. Not a role (other Admins are refused too).
// A missing, empty or blank variable means NOBODY: it never falls back to "everyone". Read on every call, so a restart with a new id needs no code change.

export function crmReportsUserId(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.CRM_REPORTS_USER_ID ?? "").trim().replace(/^["']|["']$/g, "").trim();
  return raw.length > 0 ? raw.toLowerCase() : null;
}

export function isCrmReportsUser(userId: unknown, env: Record<string, string | undefined> = process.env): boolean {
  const allowed = crmReportsUserId(env);
  return allowed !== null && typeof userId === "string" && userId.trim().toLowerCase() === allowed;
}

/** Runs after requireAuth. The id comes from the verified sign-in, never from the request body or query. */
export function requireCrmReportsUser(req: Request, res: Response, next: NextFunction) {
  if (!isCrmReportsUser(req.user?.userId)) {
    res.status(403).json({ error: "You do not have access to CRM Reports.", code: "CRM_REPORTS_FORBIDDEN" });
    return;
  }
  next();
}
