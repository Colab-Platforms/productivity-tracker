// Move every account whose status is the LEGACY value SUSPENDED to TERMINATED (owner decision 2026-11-21: Suspended is no longer a status).
// Sets exitDate to today where it is empty, writes one audit line per person (before/after, no actor, path /scripts/suspended-to-terminated).
// Nothing else on the account changes (role, company, history, password, records).
//
// DRY RUN BY DEFAULT. --apply writes in ONE transaction. Database from ST_DB_URL (never .env); the live database is refused without --allow-live,
// which needs the owner's approval AND a backup, AND migration 20261122100000_user_status_terminated_absconded applied there first.
//   ST_DB_URL=... node scripts/suspended-to-terminated.cjs [--apply] [--allow-live]
const fs = require("node:fs"), path = require("node:path");
const { Client } = require(path.join(__dirname, "..", "node_modules") + path.sep + "pg");
const args = process.argv.slice(2); const APPLY = args.includes("--apply");
const norm = (h) => String(h ?? "").replace("-pooler", "");
function liveHost() {
  try {
    const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const line = env.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL=") || l.startsWith("DIRECT_URL="));
    return line ? new URL(line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")).host : null;
  } catch { return null; }
}
(async () => {
  const url = process.env.ST_DB_URL; if (!url) throw new Error("Set ST_DB_URL (the database to change).");
  const host = new URL(url).host; const isLive = norm(host) === norm(liveHost());
  if (isLive && !args.includes("--allow-live")) throw new Error("REFUSING: this is the live database. Needs --allow-live and the owner's approval.");
  console.log(`database: ${isLive ? "LIVE" : "not live"} (${host.slice(0, 24)})  mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);
  const db = new Client({ connectionString: url }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const labels = (await q(`select e.enumlabel l from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='UserStatus'`)).map((r) => r.l);
  if (!labels.includes("TERMINATED")) throw new Error("The database has no TERMINATED value yet: apply migration 20261122100000_user_status_terminated_absconded first.");
  const rows = await q(`select u.id, u."employeeCode", u."firstName", u."lastName", u.role::text role, u."platformId", u."exitDate", p.name company from users u join platforms p on p.id=u."platformId" where u.status::text='SUSPENDED' order by p.name, u."employeeCode"`);
  for (const r of rows) console.log(`${APPLY ? "->" : "would move"} ${r.employeeCode} ${r.firstName} ${r.lastName} (${r.role}, ${r.company}): SUSPENDED -> TERMINATED`);
  console.log(`\n${rows.length} account(s).`);
  if (!APPLY || rows.length === 0) { console.log(APPLY ? "nothing to do" : "DRY RUN: nothing written."); await db.end(); return; }
  try {
    await db.query("begin");
    for (const r of rows) {
      const n = (await db.query(`update users set status='TERMINATED', "exitDate"=coalesce("exitDate", current_date), "updatedAt"=now() where id=$1 and status::text='SUSPENDED'`, [r.id])).rowCount;
      if (n !== 1) throw new Error(`${r.employeeCode} changed while running; nothing was written`);
      await db.query(`insert into audit_logs (id,"platformId","actorId",method,path,status,module,action,"recordType","recordId","targetUserId",summary,before,after,"createdAt") values (gen_random_uuid(),$1,null,'SCRIPT','/scripts/suspended-to-terminated',200,'Employees','UPDATE','Employee',$2::text,$2::uuid,$3,$4::jsonb,$5::jsonb,now())`,
        [r.platformId, r.id, `Employment status changed from Suspended to Terminated (${r.employeeCode})`, JSON.stringify({ status: "SUSPENDED" }), JSON.stringify({ status: "TERMINATED" })]);
    }
    await db.query("commit"); console.log("done: committed.");
  } catch (e) { await db.query("rollback").catch(() => {}); console.error("FAILED, nothing was written:", e.message); process.exitCode = 1; }
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
