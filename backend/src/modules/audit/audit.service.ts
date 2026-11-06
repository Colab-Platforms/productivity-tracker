import { prisma } from "../../lib/prisma.js";
import { parseIsoDay, zonedToUtc } from "../../lib/dates.js";
import { ACTIONS, MODULES, classify } from "../../lib/auditCatalog.js";
import { scrub } from "../../lib/auditContext.js";
import { accessFor, scopeWhere } from "../../lib/companyAccess.js";

// Salaries are recorded in the audit trail (what it was, what it became) but only an Admin may read the amounts.
function hideSalary(value: unknown, role: string): unknown {
  if (role === "ADMIN" || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => hideSalary(v, role));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = /salary/i.test(k) ? "[hidden]" : hideSalary(v, role);
  return out;
}

// ---------------------------------------------------------------------------
// AUDIT LOG (read-only)
//
// HR and Admin read the history of every company they act on (own, assigned, or all for top management: the shared
// company-access rule, so an Admin with the all-company grant reads the whole organisation). There is no create, update or
// delete here: rows are written only by the audit middleware, and the database
// itself refuses edits and deletes. The IP address is shown to Admin only.
// ---------------------------------------------------------------------------

const PAGE_SIZES = [25, 50, 100];

async function viewer(userId: string) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, platformId: true, platform: { select: { timezone: true } } },
  });
  if (!u) throw new Error("USER_NOT_FOUND");
  if (!["HR", "ADMIN"].includes(String(u.role))) throw new Error("NOT_ALLOWED");
  const scope = scopeWhere(await accessFor(userId));
  return { id: u.id, role: String(u.role), platformId: u.platformId, tz: u.platform.timezone, scope };
}

const nameOf = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);

type Row = {
  id: string; createdAt: Date; actorId: string | null; method: string; path: string; status: number;
  detail: unknown; module: string | null; action: string | null; recordType: string | null; recordId: string | null;
  targetUserId: string | null; summary: string | null; before: unknown; after: unknown; ip: string | null;
};

// Older rows were written before the structured columns existed; describe them from their route.
function describe(r: Row) {
  const cls = classify(r.method, r.path, (r.detail ?? {}) as Record<string, unknown>);
  return {
    module: r.module ?? cls.module,
    action: r.action ?? cls.action,
    summary: r.summary ?? cls.summary,
    recordType: r.recordType ?? cls.recordType,
    recordId: r.recordId ?? cls.recordId,
    targetUserId: r.targetUserId ?? cls.targetUserId,
  };
}

export async function filters(viewerId: string) {
  const v = await viewer(viewerId);
  const people = await prisma.user.findMany({
    where: { ...v.scope },
    select: { id: true, firstName: true, lastName: true, employeeCode: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    take: 1000,
  });
  return {
    timezone: v.tz,
    modules: MODULES,
    actions: ACTIONS,
    people: people.map((p) => ({ id: p.id, name: nameOf(p) as string, employeeCode: p.employeeCode })),
  };
}

export async function listLogs(
  viewerId: string,
  f: { from?: unknown; to?: unknown; q?: unknown; module?: unknown; action?: unknown; actorId?: unknown; targetUserId?: unknown; page?: unknown; pageSize?: unknown }
) {
  const v = await viewer(viewerId);

  const from = f.from ? parseIsoDay(f.from) : null;
  const to = f.to ? parseIsoDay(f.to) : null;
  if (from && to && from.getTime() > to.getTime()) throw new Error("BAD_RANGE");
  // Day boundaries are the COMPANY's days.
  const gte = from ? zonedToUtc(from.toISOString().slice(0, 10), "00:00", v.tz) : undefined;
  const lt = to ? new Date(zonedToUtc(to.toISOString().slice(0, 10), "00:00", v.tz).getTime() + 86_400_000) : undefined;

  const module = MODULES.find((m) => m === f.module);
  const action = ACTIONS.find((a) => a === f.action);
  if ((f.module && !module) || (f.action && !action)) throw new Error("BAD_FILTER");
  const uuid = (x: unknown) => (x ? String(x) : undefined);
  const page = Math.max(1, Math.floor(Number(f.page) || 1));
  const pageSize = PAGE_SIZES.includes(Number(f.pageSize)) ? Number(f.pageSize) : 50;
  const q = String(f.q ?? "").trim().slice(0, 100);

  // A search for a person finds what they did AND what was done to them.
  const matchedIds = q
    ? (
        await prisma.user.findMany({
          where: { ...v.scope, OR: [{ firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } }, { employeeCode: { contains: q, mode: "insensitive" } }] },
          select: { id: true },
          take: 100,
        })
      ).map((u) => u.id)
    : [];

  const where = {
    ...v.scope,
    ...(gte || lt ? { createdAt: { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) } } : {}),
    ...(module ? { module } : {}),
    ...(action ? { action } : {}),
    ...(uuid(f.actorId) ? { actorId: uuid(f.actorId) } : {}),
    ...(uuid(f.targetUserId) ? { targetUserId: uuid(f.targetUserId) } : {}),
    ...(q
      ? {
          OR: [
            { summary: { contains: q, mode: "insensitive" as const } },
            { path: { contains: q, mode: "insensitive" as const } },
            { recordId: { contains: q, mode: "insensitive" as const } },
            ...(matchedIds.length ? [{ actorId: { in: matchedIds } }, { targetUserId: { in: matchedIds } }] : []),
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // One batched lookup for every name on the page (no per-row queries).
  const described = rows.map((r) => ({ r: r as unknown as Row, d: describe(r as unknown as Row) }));
  const ids = [...new Set(described.flatMap(({ r, d }) => [r.actorId, d.targetUserId]).filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)))];
  const people = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true } }) : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const who = (id: string | null) => {
    const p = id ? byId.get(id) : null;
    return p ? { id: p.id, name: nameOf(p) as string, employeeCode: p.employeeCode, role: String(p.role) } : id ? { id, name: "Removed user", employeeCode: null, role: null } : null;
  };

  return {
    timezone: v.tz,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    items: described.map(({ r, d }) => ({
      id: r.id,
      at: r.createdAt,
      actor: who(r.actorId),
      module: d.module,
      action: d.action,
      summary: d.summary,
      recordType: d.recordType,
      recordId: d.recordId,
      target: who(d.targetUserId),
      method: r.method,
      path: r.path,
      hasChanges: r.before !== null || r.after !== null,
    })),
  };
}

export async function getLog(viewerId: string, id: string) {
  const v = await viewer(viewerId);
  const r = (await prisma.auditLog.findFirst({ where: { id, ...v.scope } })) as unknown as Row | null;
  if (!r) throw new Error("NOT_FOUND");
  const d = describe(r);
  const ids = [r.actorId, d.targetUserId].filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x));
  const people = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true } }) : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const who = (pid: string | null) => {
    const p = pid ? byId.get(pid) : null;
    return p ? { id: p.id, name: nameOf(p) as string, employeeCode: p.employeeCode, role: String(p.role) } : pid ? { id: pid, name: "Removed user", employeeCode: null, role: null } : null;
  };
  return {
    timezone: v.tz,
    id: r.id,
    at: r.createdAt,
    actor: who(r.actorId),
    target: who(d.targetUserId),
    module: d.module,
    action: d.action,
    summary: d.summary,
    recordType: d.recordType,
    recordId: d.recordId,
    method: r.method,
    path: r.path,
    status: r.status,
    // Original and new values of what changed (older rows have none: those predate this capture).
    before: r.before === null ? null : hideSalary(scrub(r.before), v.role),
    after: r.after === null ? null : hideSalary(scrub(r.after), v.role),
    // What the client sent. Already stripped of secrets when written; scrubbed again on the way out.
    request: r.detail === null ? null : hideSalary(scrub(r.detail), v.role),
    ip: v.role === "ADMIN" ? r.ip : null,
  };
}
