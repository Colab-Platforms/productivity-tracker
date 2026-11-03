// Makes every person's stored designation use the fixed list's own spelling (lib/designations.ts).
//   cd backend
//   npx tsx scripts/normalize-designations.ts            # DRY RUN: prints what would change, writes nothing
//   npx tsx scripts/normalize-designations.ts --apply    # applies it in ONE transaction, after saving a backup JSON
//
// Only changes a title that already MEANS a list entry but is spelled differently ("Hr Generalist" -> "HR Generalist",
// "Accountaant" -> "Accountant"). A title that is not on the list at all ("Test", "Time pass") is left exactly as it is and
// only reported: nobody's title is ever guessed, blanked or deleted. Nothing else on the person is touched.
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prisma } from "../src/lib/prisma.js";
import { canonicalDesignation } from "../src/lib/designations.js";

const apply = process.argv.includes("--apply");
console.log("Database host:", new URL(process.env.DIRECT_URL || process.env.DATABASE_URL || "http://none").host.slice(0, 24));

const people = await prisma.user.findMany({
  where: { designation: { not: null } },
  select: { id: true, employeeCode: true, firstName: true, lastName: true, designation: true, platform: { select: { slug: true } } },
  orderBy: [{ employeeCode: "asc" }],
});

const change: typeof people = [];
const unknown = new Map<string, string[]>();
let same = 0;
for (const p of people) {
  const cur = (p.designation ?? "").trim();
  if (!cur) continue;
  const hit = canonicalDesignation(cur);
  if (!hit) {
    unknown.set(cur, [...(unknown.get(cur) ?? []), `${p.employeeCode ?? "?"} (${p.platform.slug})`]);
  } else if (hit !== p.designation) {
    change.push(p);
  } else same++;
}

console.log(`\nAlready exactly on the list: ${same}`);
console.log(`Would be re-spelled to the list's spelling: ${change.length}`);
for (const p of change) console.log(`  ${(p.employeeCode ?? "?").padEnd(10)} "${p.designation}"  ->  "${canonicalDesignation(p.designation)}"`);
console.log(`\nNot on the list (left exactly as they are): ${unknown.size} title(s)`);
for (const [t, who] of unknown) console.log(`  "${t}"  ${who.join(", ")}`);

if (!apply) {
  console.log("\nDRY RUN: nothing was written. Add --apply to apply the re-spellings above.");
  await prisma.$disconnect();
  process.exit(0);
}

if (change.length === 0) {
  console.log("\nNothing to change.");
  await prisma.$disconnect();
  process.exit(0);
}

const dir = path.join(os.homedir(), "productivity-backups");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `designations-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(change.map((p) => ({ id: p.id, employeeCode: p.employeeCode, designation: p.designation })), null, 2));
console.log("\nBackup saved:", file);

await prisma.$transaction(
  change.map((p) => prisma.user.update({ where: { id: p.id }, data: { designation: canonicalDesignation(p.designation) as string } })),
);
console.log(`Updated ${change.length} people. Their designation now uses the list's own spelling.`);
await prisma.$disconnect();
