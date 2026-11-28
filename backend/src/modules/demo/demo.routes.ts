import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { signSession } from "../../lib/session.js";
import { requireAuth } from "../../middlewares/auth.js";
import { DEMO_CODE, DEMO_ROLES, demoCredentialsOk, demoUserId, type DemoRole } from "../../lib/demo.js";
import { seedDemo } from "./demoSeed.js";

// Mounted ONLY when DEMO_MODE=true (server.ts), on a server whose database has the demo marker. Nothing here exists on a normal server.
//   GET  /api/demo/info     public: tells the sign-in page this is the demo (never a secret)
//   POST /api/demo/login    the ONE universal demo username + password (from this server's own environment) -> the Admin view
//   GET  /api/demo/roles    the four views and the current one
//   POST /api/demo/switch   instant switch to another of the four fixed demo accounts (no password: a demo sign-in is already required)
//   POST /api/demo/reset    put the fictional data back to its starting state (own database only, rate limited)
const router = Router();

const fails = new Map<string, { n: number; at: number }>();
const tooMany = (ip: string) => { const f = fails.get(ip); return !!f && f.n >= 10 && Date.now() - f.at < 15 * 60_000; };

const LABEL: Record<DemoRole, string> = { ADMIN: "Admin", HR: "HR", MANAGER: "Manager", EMPLOYEE: "Employee" };

async function tokenFor(role: DemoRole) {
  const id = demoUserId(role);
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, platformId: true, role: true, firstName: true, lastName: true, employeeCode: true } });
  if (!u || u.employeeCode !== DEMO_CODE[role]) throw new Error("DEMO_ACCOUNT_MISSING");
  return { token: signSession({ userId: u.id, platformId: u.platformId, role: String(u.role) }), user: { id: u.id, role: String(u.role), name: `${u.firstName} ${u.lastName}`.trim(), employeeCode: u.employeeCode } };
}
const isDemoUser = (id: string) => DEMO_ROLES.some((r) => demoUserId(r) === id);

router.get("/info", (_req, res) => {
  res.json({ demo: true, label: "DEMO MODE", usernameHint: process.env.DEMO_USERNAME ?? "demo", roles: DEMO_ROLES.map((r) => ({ role: r, label: LABEL[r] })) });
});

router.post("/login", async (req, res) => {
  const ip = String(req.ip ?? "?");
  if (tooMany(ip)) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
  if (!demoCredentialsOk(req.body?.username ?? req.body?.email, req.body?.password)) {
    const f = fails.get(ip) ?? { n: 0, at: 0 };
    fails.set(ip, { n: f.n + 1, at: Date.now() });
    return res.status(401).json({ error: "Email or password is incorrect" });
  }
  fails.delete(ip);
  try { return res.json(await tokenFor("ADMIN")); } catch { return res.status(503).json({ error: "The demo data is not ready. Ask the owner to run the demo seed." }); }
});

router.get("/roles", requireAuth, async (req, res) => {
  if (!isDemoUser(req.user!.userId)) return res.status(403).json({ error: "Not a demo account." });
  const current = DEMO_ROLES.find((r) => demoUserId(r) === req.user!.userId)!;
  res.json({ current, roles: DEMO_ROLES.map((r) => ({ role: r, label: LABEL[r] })) });
});

router.post("/switch", requireAuth, async (req, res) => {
  if (!isDemoUser(req.user!.userId)) return res.status(403).json({ error: "Not a demo account." });
  const role = String(req.body?.role ?? "").toUpperCase() as DemoRole;
  if (!DEMO_ROLES.includes(role)) return res.status(400).json({ error: "Pick Admin, HR, Manager or Employee." });
  try { res.json(await tokenFor(role)); } catch { res.status(503).json({ error: "The demo data is not ready." }); }
});

let lastReset = 0;
router.post("/reset", requireAuth, async (req, res) => {
  if (!isDemoUser(req.user!.userId)) return res.status(403).json({ error: "Not a demo account." });
  if (Date.now() - lastReset < 60_000) return res.status(429).json({ error: "The demo was reset a moment ago. Try again in a minute." });
  lastReset = Date.now();
  try {
    const url = process.env.DATABASE_URL ?? "";
    const r = await seedDemo(url.split("/").pop()?.split("?")[0] ?? "");
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error("[demo] reset failed:", e);
    res.status(500).json({ error: "Could not reset the demo data." });
  }
});

export default router;
