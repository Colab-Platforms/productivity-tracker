import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { classify } from "../lib/auditCatalog.js";
import { runWithAudit, scrub, type AuditNote } from "../lib/auditContext.js";

// ---------------------------------------------------------------------------
// AUDIT
//
// Sits in front of every route, so a screen written months from now is covered
// without anyone remembering to add logging to it. Only records changes (GETs
// are noise) and only successful ones.
//
// Each row is classified from the route (module, action, plain-English summary)
// and enriched by services that call auditNote() with the original and new values.
//
// Writing happens AFTER the response is sent, so auditing can never slow a
// request or fail one. A logging failure must never break the thing being logged.
// The table itself refuses edits and deletes (see migration audit_log_immutable).
// ---------------------------------------------------------------------------

export function audit(req: Request, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "OPTIONS") return next();

  const note: AuditNote = {};

  res.on("finish", () => {
    // Only successful changes. A rejected request isn't a change.
    if (res.statusCode >= 400) return;

    const path = req.originalUrl.split("?")[0];
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cls = classify(req.method, path, body);
    if (cls.skip || note.skip) return;

    const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0];

    const legacy = {
      actorId: note.actorId !== undefined ? note.actorId : (req.user?.userId ?? null),
      platformId: note.platformId !== undefined ? note.platformId : (req.user?.platformId ?? null),
      method: req.method,
      path,
      status: res.statusCode,
      // What the client sent, with secrets and file contents removed.
      detail: scrub(body) as never,
      ip: forwarded.trim() || req.ip || null,
    };
    const structured = {
      ...legacy,
      module: note.module ?? cls.module,
      action: note.action ?? cls.action,
      recordType: note.recordType ?? cls.recordType,
      recordId: note.recordId !== undefined ? note.recordId : cls.recordId,
      targetUserId: note.targetUserId !== undefined ? note.targetUserId : cls.targetUserId,
      summary: note.summary ?? cls.summary,
      before: note.before === undefined ? undefined : (scrub(note.before) as never),
      after: note.after === undefined ? undefined : (scrub(note.after) as never),
    };

    // select: { id } keeps the INSERT ... RETURNING to columns every version of the table has.
    void prisma.auditLog
      .create({ data: structured, select: { id: true } })
      .catch(async (err: unknown) => {
        // Database not migrated yet (columns missing): still record the request the old way, never lose it.
        if ((err as { code?: string }).code === "P2022" || /column .* does not exist/i.test(String((err as Error)?.message))) {
          await prisma.auditLog.create({ data: legacy, select: { id: true } }).catch((e: unknown) => console.error("[audit] could not record:", e));
          return;
        }
        console.error("[audit] could not record:", err);
      });
  });

  runWithAudit({ note }, () => next());
}
