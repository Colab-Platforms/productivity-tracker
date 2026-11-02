// One-off: builds each company's designation list (the dropdown) from the job titles its people ALREADY have, word for word.
// Nothing is corrected, merged or invented, and nobody's own designation is touched: spelling mistakes in what people have are copied
// as they are (HR can hide or rename an entry later in Companies > Designations). Titles that differ only in capitals or extra spaces
// become ONE entry (the first spelling met). Needs migration 20261102100000_company_access_and_codes applied first.
//
//   npx tsx scripts/seed-designations.ts            dry run: shows what would be added, writes nothing
//   npx tsx scripts/seed-designations.ts --apply    adds them (only ones not already in the company's list)
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

const APPLY = process.argv.includes("--apply");
const tidy = (s: string) => s.trim().replace(/\s+/g, " ");

try {
  await prisma.designation.findFirst({ select: { id: true } });
} catch {
  console.log("STOPPED: the designations table does not exist in this database yet (migration 20261102100000_company_access_and_codes). Nothing changed.");
  process.exit(1);
}

const companies = await prisma.platform.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
let total = 0;
for (const c of companies) {
  const [people, have] = await Promise.all([
    prisma.user.findMany({ where: { platformId: c.id, designation: { not: null }, status: { not: "EXITED" } }, select: { designation: true } }),
    prisma.designation.findMany({ where: { platformId: c.id }, select: { name: true } }),
  ]);
  const known = new Set(have.map((h) => h.name.toLowerCase()));
  const toAdd: string[] = [];
  for (const p of people) {
    const name = tidy(p.designation ?? "");
    if (name.length < 2 || known.has(name.toLowerCase())) continue;
    known.add(name.toLowerCase());
    toAdd.push(name);
  }
  if (toAdd.length === 0) continue;
  console.log(`${c.name}: ${toAdd.length} to add: ${toAdd.join(" | ")}`);
  total += toAdd.length;
  if (APPLY) await prisma.designation.createMany({ data: toAdd.map((name) => ({ platformId: c.id, name })), skipDuplicates: true });
}
console.log(APPLY ? `\nAdded ${total} designation(s).` : `\nDRY RUN: ${total} designation(s) would be added. Nothing changed. Run again with --apply.`);
process.exit(0);
