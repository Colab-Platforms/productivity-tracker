// Retention (6 months by default), the 90-day floor the database enforces, and the session-state rules. Throwaway database ONLY:
//   DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test DIRECT_URL=<same> npx tsx tests/login-activity-purge.test.mts
const url = process.env.DATABASE_URL ?? "";
if (!url.includes("localhost:54329") && !url.includes("127.0.0.1:54329")) throw new Error("refusing: DATABASE_URL is not the throwaway database");
const { prisma } = await import("../src/lib/prisma.ts");
const { purgeOldLoginEvents, retentionDays, RETENTION_FLOOR_DAYS } = await import("../src/modules/login-activity/loginEvents.ts");
const { sessionState } = await import("../src/modules/login-activity/loginActivity.service.ts");

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 300) : "")); };

console.log("\n## the retention setting");
ok("six months by default", retentionDays({}) === 180 && retentionDays({ LOGIN_ACTIVITY_RETENTION_DAYS: "" }) === 180);
ok("the server can lengthen it", retentionDays({ LOGIN_ACTIVITY_RETENTION_DAYS: "365" }) === 365 && retentionDays({ LOGIN_ACTIVITY_RETENTION_DAYS: "90" }) === 90);
ok("a value under the floor, or nonsense, is ignored (180)", retentionDays({ LOGIN_ACTIVITY_RETENTION_DAYS: "30" }) === 180 && retentionDays({ LOGIN_ACTIVITY_RETENTION_DAYS: "abc" }) === 180 && retentionDays({ LOGIN_ACTIVITY_RETENTION_DAYS: "-5" }) === 180 && retentionDays({ LOGIN_ACTIVITY_RETENTION_DAYS: "100.5" }) === 180);
ok("the floor is 90 days", RETENTION_FLOOR_DAYS === 90);

console.log("\n## the purge");
const day = 86_400_000;
const RUN = Math.random().toString(36).slice(2, 8); // young rows can never be deleted, so each run uses its own tag
const mk = (days: number, tag: string) => prisma.loginEvent.create({ data: { result: "FAILED", username: `purge.${RUN}.${tag}`, ip: "9.9.9.9", createdAt: new Date(Date.now() - days * day) }, select: { id: true } });
const [d200, d120, d100, d10] = await Promise.all([mk(200, "200"), mk(120, "120"), mk(100, "100"), mk(10, "10")]);
const left = async () => (await prisma.loginEvent.findMany({ where: { username: { startsWith: `purge.${RUN}.` } }, select: { username: true } })).map((r) => r.username).sort();
const n1 = await purgeOldLoginEvents(new Date(), 180);
ok("with 6 months, only the 200-day-old row goes", n1 === 1 && (await left()).map((x) => x?.split(".")[2]).join() === "10,100,120", { n1, left: await left() });
const n2 = await purgeOldLoginEvents(new Date(), 90);
ok("with 90 days, the 120 and 100 day rows go, the 10-day row stays", n2 === 2 && (await left()).map((x) => x?.split(".")[2]).join() === "10", { n2, left: await left() });
const n3 = await purgeOldLoginEvents(new Date(), 1);
ok("a mistaken tiny setting cannot delete recent history (the database refuses) and never crashes", n3 === 0 && (await left()).map((x) => x?.split(".")[2]).join() === "10", { n3, left: await left() });
ok("running it again is harmless", (await purgeOldLoginEvents(new Date(), 180)) === 0);
void d200; void d120; void d100; void d10;
await prisma.$executeRawUnsafe(`select 1`); // connection still fine

console.log("\n## what became of a sign-in");
const now = new Date("2026-11-19T12:00:00Z");
const row = (o: Record<string, unknown>) => ({ result: "SUCCESS", sessionId: "s", loggedOutAt: null as Date | null, expiresAt: new Date("2026-11-20T12:00:00Z"), ...o });
ok("a valid session is Active", sessionState(row({}) as never, now) === "ACTIVE");
ok("a logout makes it Logged out, even before it would have expired", sessionState(row({ loggedOutAt: new Date("2026-11-19T10:00:00Z") }) as never, now) === "LOGGED_OUT");
ok("a session never ended whose time ran out is Expired", sessionState(row({ expiresAt: new Date("2026-11-19T11:00:00Z") }) as never, now) === "EXPIRED");
ok("exactly at expiry it is Expired", sessionState(row({ expiresAt: now }) as never, now) === "EXPIRED");
ok("an old sign-in with no session id is Not tracked", sessionState(row({ sessionId: null }) as never, now) === "NOT_TRACKED");
ok("a failed or blocked attempt has no session at all", sessionState(row({ result: "FAILED", sessionId: null }) as never, now) === null && sessionState(row({ result: "BLOCKED" }) as never, now) === null);
ok("a logout wins over expiry", sessionState(row({ loggedOutAt: new Date("2026-11-19T10:00:00Z"), expiresAt: new Date("2026-11-19T11:00:00Z") }) as never, now) === "LOGGED_OUT");

await prisma.$disconnect();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
