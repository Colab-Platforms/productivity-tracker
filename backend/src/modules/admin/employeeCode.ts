import { prisma } from "../../lib/prisma.js";
import { formatCode, highestNumber } from "../../lib/companyAccess.logic.js";

// ---------------------------------------------------------------------------
// EMPLOYEE IDs
// A new ID is the company's prefix plus the next number of its own counter (AI-0015). The counter row is locked while a number is
// handed out, so two people created at the same instant can never get the same ID, and because it runs INSIDE the transaction
// that creates the person, a failed create gives the number back (no gaps from errors). Existing IDs are never read to be changed,
// only to start the counter above the highest one in use.
// Before the migration there is no counter table: the old "highest + 1" rule is used, exactly as before.
// ---------------------------------------------------------------------------

type Db = Pick<typeof prisma, "user" | "platform" | "$queryRaw" | "$executeRaw">;

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/employee_code_sequences/.test(msg) && /does not exist|relation/.test(msg));
};

// Checked OUTSIDE any transaction (a missing-table error inside one would poison it).
let readyValue = false;
let readyCheckedAt = 0;
export async function sequencesReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await prisma.employeeCodeSequence.findFirst({ select: { platformId: true } });
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

export async function prefixFor(db: Db, platformId: string): Promise<string> {
  const p = await db.platform.findUnique({ where: { id: platformId }, select: { employeeCodePrefix: true, slug: true } });
  if (!p) throw new Error("NOT_FOUND");
  return (p.employeeCodePrefix ?? p.slug.slice(0, 3)).toUpperCase();
}

/** Codes already used anywhere that start with this prefix (IDs are unique across companies, so all of them count). */
async function codesWithPrefix(db: Db, prefix: string): Promise<string[]> {
  const rows = await db.user.findMany({ where: { employeeCode: { startsWith: `${prefix}-`, mode: "insensitive" } }, select: { employeeCode: true } });
  return rows.map((r) => r.employeeCode ?? "");
}

/** Hand out the next employee ID for a company. Call it inside the transaction that creates the person. */
export async function allocateEmployeeCode(db: Db, platformId: string): Promise<string> {
  const prefix = await prefixFor(db, platformId);
  if (!(await sequencesReady())) {
    // No counter table yet: the old rule.
    return formatCode(prefix, highestNumber(await codesWithPrefix(db, prefix), prefix) + 1, 4);
  }
  // One caller at a time per company, released automatically when the transaction ends.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${platformId}, 0))`;
  const start = highestNumber(await codesWithPrefix(db, prefix), prefix) + 1;
  await db.$executeRaw`INSERT INTO employee_code_sequences ("platformId", "nextNumber", "padWidth", "updatedAt") VALUES (${platformId}::uuid, ${start}, 4, now()) ON CONFLICT ("platformId") DO NOTHING`;
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await db.$queryRaw<{ n: number; w: number }[]>`UPDATE employee_code_sequences SET "nextNumber" = "nextNumber" + 1, "updatedAt" = now() WHERE "platformId" = ${platformId}::uuid RETURNING "nextNumber" - 1 AS n, "padWidth" AS w`;
    const code = formatCode(prefix, Number(rows[0].n), Number(rows[0].w));
    // A code typed in by hand, imported, or left from an older prefix may already be there: skip it, never reuse it.
    const taken = await db.user.findFirst({ where: { employeeCode: { equals: code, mode: "insensitive" } }, select: { id: true } });
    if (!taken) return code;
  }
  throw new Error("CODE_ALLOCATION_FAILED");
}
