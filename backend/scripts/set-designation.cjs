// Change ONE person's designation (and nothing else): no role, permission, username, password, company or reporting line is touched.
// Matched by employee ID AND name AND role, so a reused ID can never change somebody else. The new title must be on the official list
// (src/lib/designations.ts). One transaction, one audit line (before/after, no actor, path /scripts/set-designation).
//
// DRY RUN BY DEFAULT. --apply writes. Database from DES_DB_URL (never .env); the live database is refused without --allow-live,
// which needs the owner's approval (and a backup).
//   DES_DB_URL=... node scripts/set-designation.cjs --code sanjay.bhati --first Sanjay --last "Singh Bhati" --role ADMIN --to "Business Advisor" [--apply] [--allow-live]
const fs = require("node:fs"), path = require("node:path");
const { Client } = require(path.join(__dirname, "..", "node_modules") + path.sep + "pg");
const a = process.argv.slice(2);
const arg = (n) => { const i = a.indexOf("--" + n); return i >= 0 ? a[i + 1] : undefined; };
const APPLY = a.includes("--apply");
const norm = (h) => String(h ?? "").replace("-pooler", "");
function liveHost() {
  try {
    const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const line = env.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL=") || l.startsWith("DIRECT_URL="));
    return line ? new URL(line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")).host : null;
  } catch { return null; }
}
(async () => {
  const [code, first, last, role, to] = ["code", "first", "last", "role", "to"].map(arg);
  if (!code || !first || !last || !role || !to) throw new Error("Give --code --first --last --role --to");
  const list = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "designations.ts"), "utf8");
  if (!list.includes(`"${to}",`)) throw new Error(`"${to}" is not on the official designation list (src/lib/designations.ts)`);
  const url = process.env.DES_DB_URL; if (!url) throw new Error("Set DES_DB_URL (the database to change).");
  const host = new URL(url).host, live = norm(host) === norm(liveHost());
  if (live && !a.includes("--allow-live")) throw new Error("REFUSING: this is the live database. Needs --allow-live and the owner's approval.");
  console.log(`database: ${live ? "LIVE" : "not live"} (${host.slice(0, 24)})  mode: ${APPLY ? "APPLY" : "DRY RUN"}`);
  const db = new Client({ connectionString: url }); await db.connect();
  try {
    const rows = (await db.query(`select id, "platformId", "firstName", "lastName", role::text role, designation from users where "employeeCode" = $1`, [code])).rows;
    if (rows.length !== 1) throw new Error(`expected exactly one account with ID ${code}, found ${rows.length}`);
    const u = rows[0];
    if (u.firstName.trim().toLowerCase() !== first.toLowerCase() || u.lastName.trim().toLowerCase() !== last.toLowerCase()) throw new Error(`the name on ${code} is "${u.firstName} ${u.lastName}", not "${first} ${last}"`);
    if (u.role !== role) throw new Error(`the role on ${code} is ${u.role}, expected ${role}`);
    console.log(`${code} ${u.firstName} ${u.lastName} (${u.role}): designation "${u.designation ?? ""}" -> "${to}"`);
    if (u.designation === to) { console.log("already set, nothing to do"); return; }
    if (!APPLY) { console.log("DRY RUN: nothing written."); return; }
    await db.query("begin");
    const n = (await db.query(`update users set designation = $2, "updatedAt" = now() where id = $1 and designation is not distinct from $3`, [u.id, to, u.designation])).rowCount;
    if (n !== 1) throw new Error("the record changed while running; nothing was written");
    await db.query(`insert into audit_logs (id,"platformId","actorId",method,path,status,module,action,"recordType","recordId","targetUserId",summary,before,after,"createdAt") values (gen_random_uuid(),$1,null,'SCRIPT','/scripts/set-designation',200,'Employees','UPDATE','Employee',$2::text,$2::uuid,$3,$4::jsonb,$5::jsonb,now())`,
      [u.platformId, u.id, `Designation changed from "${u.designation ?? ""}" to "${to}" (${code})`, JSON.stringify({ designation: u.designation }), JSON.stringify({ designation: to })]);
    await db.query("commit"); console.log("done: committed.");
  } catch (e) { await db.query("rollback").catch(() => {}); throw e; } finally { await db.end(); }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
