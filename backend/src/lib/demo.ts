import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "./prisma.js";

// ---------------------------------------------------------------------------
// DEMO MODE: a SEPARATE deployment of the same code, pointed at its OWN database full of invented people, so an outside tester can try every role.
//
//   * Switched on only by DEMO_MODE=true on that separate server. Production never sets it, and nothing below is mounted or reachable without it.
//   * The server REFUSES TO START in demo mode unless its database carries the table `demo_marker` (created by the demo seed). A production database
//     has no such table, so DEMO_MODE=true pointed at production by mistake exits immediately instead of serving or changing anything.
//   * The seed script refuses to touch any database that is not (a) already marked as a demo database or (b) empty of real users and named *demo*.
//   * Email and AI calls are switched off in demo mode, so a tester can never send a message or spend a key. Files live in the database (stored_blobs),
//     chat and live updates run inside the same server, so they are isolated by the same database.
// ---------------------------------------------------------------------------

export const isDemo = process.env.DEMO_MODE === "true";

/** The four fixed demo accounts, one per role. Same ids on every seed, so a signed-in tester survives "Reset demo data". */
export type DemoRole = "ADMIN" | "HR" | "MANAGER" | "EMPLOYEE";
export const DEMO_ROLES: DemoRole[] = ["ADMIN", "HR", "MANAGER", "EMPLOYEE"];
export const DEMO_CODE: Record<DemoRole, string> = { ADMIN: "DEMO-ADMIN", HR: "DEMO-HR", MANAGER: "DEMO-MGR", EMPLOYEE: "DEMO-EMP" };
export const DEMO_EMAIL_DOMAIN = "demo.avatar-hrms.example";

/** Deterministic UUID from a name, so every seed produces the same ids. */
export function demoId(name: string): string {
  const h = createHash("sha1").update("avatar-hrms-demo:" + name).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const demoUserId = (role: DemoRole) => demoId("user:" + DEMO_CODE[role]);

export async function hasDemoMarker(): Promise<boolean> {
  try {
    const r = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from demo_marker where note like 'Avatar HRMS demo database%'`;
    return (r[0]?.n ?? 0) > 0;
  } catch {
    return false; // no such table = not a demo database
  }
}

/** Called at startup in demo mode. Exits the process when the database is not a marked demo database. */
export async function assertDemoDatabase(): Promise<void> {
  if (!isDemo) return;
  if (!(await hasDemoMarker())) {
    console.error("[demo] DEMO_MODE=true but this database has no demo marker (run `npm run demo:seed` against the DEMO database). Refusing to start so it can never serve a real database.");
    process.exit(1);
  }
  if (!process.env.DEMO_PASSWORD) {
    console.error("[demo] DEMO_PASSWORD is not set. Set the universal demo password in the demo server's environment. Not starting.");
    process.exit(1);
  }
  console.log(`[demo] DEMO MODE: marked demo database confirmed. Email and AI are switched off. Universal login username: ${process.env.DEMO_USERNAME ?? "demo"}`);
}

/** Constant-time check of the universal demo credentials (from the demo server's own environment). */
export function demoCredentialsOk(username: unknown, password: unknown): boolean {
  const u = String(process.env.DEMO_USERNAME ?? "demo"), p = String(process.env.DEMO_PASSWORD ?? "");
  if (!p || typeof username !== "string" || typeof password !== "string") return false;
  const eq = (a: string, b: string) => {
    const x = createHash("sha256").update(a).digest(), y = createHash("sha256").update(b).digest();
    return timingSafeEqual(x, y);
  };
  const okUser = eq(username.trim().toLowerCase(), u.toLowerCase());
  const okPass = eq(password, p);
  return okUser && okPass;
}
