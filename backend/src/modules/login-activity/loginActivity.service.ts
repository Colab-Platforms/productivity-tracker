import { prisma } from "../../lib/prisma.js";
import { accessFor, scopeWhere } from "../../lib/companyAccess.js";
import { parseIsoDay, zonedToUtc } from "../../lib/dates.js";
import { loginEventsReady, REASON_TEXT } from "./loginEvents.js";

// ---------------------------------------------------------------------------
// LOGIN ACTIVITY (reading). Who may see what, decided here on the server:
//   everyone       their OWN history only (the id comes from the sign-in, never from the request): successful sign-ins, and the failed or blocked
//                  attempts made on their account
//   HR             the people of the companies they act on (company access), with the address and device. Not shown to HR: attempts with an unknown
//                  username (they belong to nobody), and the "needs attention" analysis
//   Admin          the same for the companies they act on, PLUS attempts with an unknown username (all-company Admins) and the analysis
//   Manager / Supervisor / Employee   nothing about anyone else
// Approximate location is always labelled approximate and is empty until a location source is added. Device information is what the browser reported,
// never proof of which computer it was.
// ---------------------------------------------------------------------------

type Row = {
  id: string; createdAt: Date; result: string; reason: string | null; wouldBlock: boolean; mode: string | null; userId: string | null; platformId: string | null;
  employeeCode: string | null; username: string | null; ip: string | null; country: string | null; region: string | null; city: string | null;
  browserName: string | null; browserVersion: string | null; osName: string | null; osVersion: string | null; deviceType: string | null; userAgent: string | null;
  sessionId: string | null; expiresAt: Date | null; lastActiveAt: Date | null; loggedOutAt: Date | null;
};

export type SessionState = "ACTIVE" | "LOGGED_OUT" | "EXPIRED" | "NOT_TRACKED";

/** What became of a successful sign-in. A session that was never ended and whose time ran out is Expired (worked out when read; nothing is stored for it). */
export function sessionState(r: Pick<Row, "result" | "sessionId" | "loggedOutAt" | "expiresAt">, now = new Date()): SessionState | null {
  if (r.result !== "SUCCESS") return null;
  if (!r.sessionId) return "NOT_TRACKED";
  if (r.loggedOutAt) return "LOGGED_OUT";
  if (r.expiresAt && r.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

const text = (a: string | null, b: string | null) => (a ? (b ? `${a} ${b}` : a) : null);

function shape(r: Row, people: Map<string, { name: string; code: string | null; company: string }>, now: Date) {
  const p = r.userId ? people.get(r.userId) : null;
  const state = sessionState(r, now);
  const location = [r.city, r.region, r.country].filter(Boolean).join(", ") || null;
  const ended = r.loggedOutAt ?? (state === "EXPIRED" ? r.expiresAt : null);
  return {
    id: r.id,
    at: r.createdAt,
    result: r.result,
    reason: r.reason,
    reasonText: r.reason ? REASON_TEXT[r.reason] ?? REASON_TEXT.OTHER : null,
    // signed in from a network that is not authorised while the rule was only in monitor mode
    offNetwork: r.wouldBlock,
    employee: p ? { id: r.userId as string, name: p.name, employeeCode: p.code ?? r.employeeCode, company: p.company } : r.userId ? { id: r.userId, name: "Removed user", employeeCode: r.employeeCode, company: "" } : null,
    username: r.username,
    ip: r.ip,
    location, // always approximate; null until a location source exists
    deviceType: r.deviceType,
    browser: text(r.browserName, r.browserVersion),
    os: text(r.osName, r.osVersion),
    session: state
      ? {
          state,
          lastActiveAt: r.lastActiveAt,
          loggedOutAt: r.loggedOutAt,
          expiresAt: r.expiresAt,
          // time from sign-in to the last known activity (or to the end), in minutes: a length of time, not a claim about presence
          minutes: ended || r.lastActiveAt ? Math.max(0, Math.round((((ended ?? r.lastActiveAt) as Date).getTime() - r.createdAt.getTime()) / 60_000)) : null,
        }
      : null,
  };
}

async function peopleOf(ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  const rows = unique.length
    ? await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, firstName: true, lastName: true, employeeCode: true, platform: { select: { name: true } } } })
    : [];
  return new Map(rows.map((u) => [u.id, { name: `${u.firstName} ${u.lastName}`.trim(), code: u.employeeCode, company: u.platform.name }]));
}

const PAGE_SIZES = [25, 50, 100];
const pageOf = (v: unknown) => Math.max(1, Math.min(10_000, Number.parseInt(String(v ?? "1"), 10) || 1));
const sizeOf = (v: unknown) => { const n = Number.parseInt(String(v ?? "25"), 10); return PAGE_SIZES.includes(n) ? n : 25; };

// ---------------------------------------------------------------------------------------------------------------- the person's own history
export async function mine(userId: string, f: { page?: unknown; pageSize?: unknown; result?: unknown }) {
  if (!(await loginEventsReady())) return { ready: false as const, total: 0, page: 1, pageSize: 25, pages: 1, retentionNote: null, items: [] };
  const result = ["SUCCESS", "FAILED", "BLOCKED"].find((x) => x === f.result);
  const where = { userId, ...(result ? { result } : {}) };
  const page = pageOf(f.page), pageSize = sizeOf(f.pageSize);
  const [total, rows, me] = await Promise.all([
    prisma.loginEvent.count({ where }),
    prisma.loginEvent.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    peopleOf([userId]),
  ]);
  const now = new Date();
  return { ready: true as const, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), items: rows.map((r) => shape(r as Row, me, now)) };
}

// ---------------------------------------------------------------------------------------------------------------- Admin and HR
async function viewer(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, platform: { select: { timezone: true } } } });
  if (!u) throw new Error("USER_NOT_FOUND");
  const role = String(u.role);
  if (role !== "ADMIN" && role !== "HR") throw new Error("NOT_ALLOWED");
  const access = await accessFor(userId);
  const admin = role === "ADMIN";
  // Rows are attributed to the person's company. A row with no company (an unknown username) belongs to nobody: ONLY an Admin with access to every
  // company sees it. HR, even with every company, sees only rows that belong to a company they act on.
  const scope: Record<string, unknown> = admin && access.all ? {} : access.all ? { platformId: { not: null } } : { platformId: { in: access.ids } };
  return { id: u.id, role, tz: u.platform.timezone, scope, admin };
}

export type Filters = { q?: unknown; from?: unknown; to?: unknown; ip?: unknown; location?: unknown; device?: unknown; status?: unknown; companyId?: unknown; page?: unknown; pageSize?: unknown };

function dayBounds(from: unknown, to: unknown, tz: string) {
  const out: { gte?: Date; lt?: Date } = {};
  const f = typeof from === "string" && from ? from : null;
  const t = typeof to === "string" && to ? to : null;
  if (f) out.gte = zonedToUtc(parseIsoDay(f).toISOString().slice(0, 10), "00:00", tz);
  if (t) { const d = parseIsoDay(t); out.lt = zonedToUtc(new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10), "00:00", tz); }
  return out;
}

const STATUSES = ["SUCCESS", "FAILED", "BLOCKED", "NOT_SUCCESS"];

export async function list(userId: string, f: Filters) {
  const v = await viewer(userId);
  if (!(await loginEventsReady())) return { ready: false as const, admin: v.admin, total: 0, page: 1, pageSize: 25, pages: 1, summary: null, items: [] };
  const and: Record<string, unknown>[] = [v.scope];
  const q = String(f.q ?? "").trim().slice(0, 80);
  if (q) {
    const ids = (
      await prisma.user.findMany({
        where: { ...v.scope, OR: [{ firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } }, { employeeCode: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] },
        select: { id: true },
        take: 300,
      })
    ).map((u) => u.id);
    // an unknown username belongs to nobody, so only an Admin can search for it
    and.push({ OR: [{ userId: { in: ids } }, ...(v.admin ? [{ username: { contains: q, mode: "insensitive" } }] : [])] });
  }
  const status = STATUSES.find((x) => x === f.status);
  if (status === "NOT_SUCCESS") and.push({ result: { not: "SUCCESS" } });
  else if (status) and.push({ result: status });
  const ip = String(f.ip ?? "").trim().slice(0, 64);
  if (ip) and.push({ ip: { contains: ip, mode: "insensitive" } });
  const loc = String(f.location ?? "").trim().slice(0, 60);
  if (loc) and.push({ OR: [{ city: { contains: loc, mode: "insensitive" } }, { region: { contains: loc, mode: "insensitive" } }, { country: { contains: loc, mode: "insensitive" } }] });
  const device = ["Desktop", "Mobile", "Tablet", "Bot", "Unknown"].find((x) => x === f.device);
  if (device) and.push({ deviceType: device });
  const company = typeof f.companyId === "string" && /^[0-9a-f-]{36}$/i.test(f.companyId) ? f.companyId : null;
  if (company) and.push({ platformId: company });
  const when = dayBounds(f.from, f.to, v.tz);
  if (when.gte || when.lt) and.push({ createdAt: when });
  const where = { AND: and };

  const page = pageOf(f.page), pageSize = sizeOf(f.pageSize);
  const since = new Date(Date.now() - 86_400_000);
  const [total, rows, last24] = await Promise.all([
    prisma.loginEvent.count({ where }),
    prisma.loginEvent.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.loginEvent.groupBy({ by: ["result"], where: { AND: [v.scope, { createdAt: { gte: since } }] }, _count: { _all: true } }),
  ]);
  const typed = rows as unknown as Row[];
  const people = await peopleOf(typed.map((r) => r.userId).filter((x): x is string => !!x));
  const now = new Date();
  const items = typed.map((r) => shape(r, people, now));
  const flags = v.admin ? await flagsFor(typed) : null;
  const n = (r: string) => last24.find((x) => x.result === r)?._count._all ?? 0;
  return {
    ready: true as const,
    admin: v.admin,
    timezone: v.tz,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    summary: { last24Hours: { success: n("SUCCESS"), failed: n("FAILED"), blocked: n("BLOCKED") } },
    items: items.map((it, i) => ({ ...it, flags: flags ? flags[i] : undefined })),
  };
}

export async function detail(userId: string, id: string) {
  const v = await viewer(userId);
  if (!(await loginEventsReady())) throw new Error("NOT_FOUND");
  const r = (await prisma.loginEvent.findFirst({ where: { AND: [v.scope, { id }] } })) as unknown as Row | null;
  if (!r) throw new Error("NOT_FOUND"); // not in this person's reach = does not exist
  const people = await peopleOf(r.userId ? [r.userId] : []);
  const flags = v.admin ? (await flagsFor([r]))[0] : undefined;
  let sameIp24h: number | undefined;
  if (v.admin && r.ip) {
    sameIp24h = await prisma.loginEvent.count({ where: { ip: r.ip, createdAt: { gte: new Date(r.createdAt.getTime() - 86_400_000), lte: new Date(r.createdAt.getTime() + 86_400_000) } } });
  }
  return {
    ...shape(r, people, new Date()),
    flags,
    userAgent: r.userAgent,
    mode: r.mode,
    attemptsFromThisAddressWithin24Hours: sameIp24h,
    notes: {
      location: "Location is approximate and comes from the IP address only. It is not a verified physical location.",
      device: "Browser, system and device type are what the browser reported. They do not identify one particular computer.",
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------- "needs attention" (Admin only)
export type Flag = "BLOCKED" | "MANY_FAILURES" | "NEW_ADDRESS" | "OFF_NETWORK";
export const FLAG_TEXT: Record<Flag, string> = {
  BLOCKED: "Blocked: the network is not authorised",
  MANY_FAILURES: "3 or more failed attempts within an hour",
  NEW_ADDRESS: "First sign-in from this address for this person",
  OFF_NETWORK: "Signed in from outside the authorised network (monitor mode)",
};

/** Transparent rules, worked out from the rows themselves; nothing is scored or guessed. Batched: a fixed number of queries for the whole page. */
export async function flagsFor(rows: Row[]): Promise<Flag[][]> {
  const out: Flag[][] = rows.map(() => []);
  if (rows.length === 0) return out;
  const hourMs = 3_600_000;
  const failed = rows.filter((r) => r.result === "FAILED");
  const users = [...new Set(failed.map((r) => r.userId).filter((x): x is string => !!x))];
  const names = [...new Set(failed.filter((r) => !r.userId && r.username).map((r) => (r.username as string).toLowerCase()))];
  const minAt = failed.length ? new Date(Math.min(...failed.map((r) => r.createdAt.getTime())) - hourMs) : null;
  const maxAt = failed.length ? new Date(Math.max(...failed.map((r) => r.createdAt.getTime()))) : null;
  const history = failed.length
    ? await prisma.loginEvent.findMany({
        where: { result: "FAILED", createdAt: { gte: minAt as Date, lte: maxAt as Date }, OR: [...(users.length ? [{ userId: { in: users } }] : []), ...(names.length ? [{ username: { in: names, mode: "insensitive" as const } }] : [])] },
        select: { userId: true, username: true, createdAt: true },
      })
    : [];
  const succ = rows.filter((r) => r.result === "SUCCESS" && r.userId);
  const sUsers = [...new Set(succ.map((r) => r.userId as string))];
  const firstSeen = sUsers.length
    ? await prisma.loginEvent.groupBy({ by: ["userId", "ip"], where: { result: "SUCCESS", userId: { in: sUsers } }, _min: { createdAt: true } })
    : [];
  const ipsPerUser = new Map<string, Set<string>>();
  for (const g of firstSeen) if (g.userId && g.ip) ipsPerUser.set(g.userId, (ipsPerUser.get(g.userId) ?? new Set()).add(g.ip));
  const first = new Map(firstSeen.map((g) => [`${g.userId}|${g.ip}`, g._min.createdAt?.getTime() ?? 0]));

  rows.forEach((r, i) => {
    if (r.result === "BLOCKED") out[i].push("BLOCKED");
    if (r.result === "FAILED") {
      const t = r.createdAt.getTime();
      const same = history.filter((h) => (r.userId ? h.userId === r.userId : !h.userId && (h.username ?? "").toLowerCase() === (r.username ?? "").toLowerCase()) && h.createdAt.getTime() <= t && h.createdAt.getTime() >= t - hourMs).length;
      if (same >= 3) out[i].push("MANY_FAILURES");
    }
    if (r.result === "SUCCESS" && r.userId && r.ip) {
      // new address: this is the first successful sign-in from it, and the person had signed in from somewhere else before
      const isFirst = first.get(`${r.userId}|${r.ip}`) === r.createdAt.getTime();
      const hadOthers = (ipsPerUser.get(r.userId)?.size ?? 0) > 1 && [...(ipsPerUser.get(r.userId) ?? [])].some((ip) => ip !== r.ip && (first.get(`${r.userId}|${ip}`) ?? Infinity) < r.createdAt.getTime());
      if (isFirst && hadOthers) out[i].push("NEW_ADDRESS");
    }
    if (r.result === "SUCCESS" && r.wouldBlock) out[i].push("OFF_NETWORK");
  });
  return out;
}
