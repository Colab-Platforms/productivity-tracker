// Fills the DEMO database with fictional data. Usage (from backend/):
//   DEMO_DATABASE_URL=postgresql://.../hrms_demo  npx tsx scripts/demo-seed.ts
// It reads ONLY DEMO_DATABASE_URL (never DATABASE_URL / .env), so it cannot be pointed at the real database by accident, and it refuses to run on any
// database that is not marked as a demo database (or an empty one with "demo" in its name).
const url = process.env.DEMO_DATABASE_URL;
if (!url) { console.error("Set DEMO_DATABASE_URL to the demo database (the real DATABASE_URL is never used)."); process.exit(1); }
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;
const name = url.split("/").pop()!.split("?")[0];
const { seedDemo } = await import("../src/modules/demo/demoSeed.js");
const { prisma } = await import("../src/lib/prisma.js");
try {
  const r = await seedDemo(name);
  console.log(`Demo database "${name}" is ready: ${r.users} fictional people. Start the demo server with DEMO_MODE=true.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
