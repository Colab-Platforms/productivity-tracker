// Give the TASK_ASSIGN_COMPANY capability to EXACTLY two existing accounts (Saurabh Jadhav CP-01, Chirag Parmar AWL-06): they may assign tasks to active
// employees of their own company through the existing assigned-task workflow. They stay Employees (nothing about role, password, company or records changes);
// only one row each is added to `user_capabilities`. This script is the only way a capability is ever granted: no API route writes the table.
//
// DRY RUN BY DEFAULT: prints what it would do and writes nothing. Add --apply to write (one transaction, all or nothing).
// The database comes from CAP_DB_URL (never from .env). The live database is refused unless --allow-live is also given; do that ONLY with the owner's
// explicit approval, and only after migration 20261124100000_user_capabilities has been applied there.
//
//   CAP_DB_URL=... node scripts/provision-capabilities.cjs [--apply] [--allow-live]
const fs = require("node:fs"), path = require("node:path");
const B = path.join(__dirname, "..", "node_modules") + path.sep;
const { Client } = require(B + "pg");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const APPLY = flag("--apply");
const CAPABILITY = "TASK_ASSIGN_COMPANY";

// Matched by employee ID AND name AND role AND status, so a changed or reused ID can never give the capability to somebody else.
const TARGETS = [
  { code: "CP-01", first: "Saurabh", last: "Jadhav" },
  { code: "AWL-06", first: "Chirag", last: "Parmar" },
];

// The pooled and the direct Neon host of the same database differ only by "-pooler": compare them as one.
const norm = (h) => (h || "").toLowerCase().replace("-pooler", "");
function liveHosts() {
  try {
    const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    return env.split(/\r?\n/).filter((l) => l.startsWith("DATABASE_URL=") || l.startsWith("DIRECT_URL=")).map((l) => norm(new URL(l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")).host));
  } catch { return []; }
}

(async () => {
  const url = process.env.CAP_DB_URL;
  if (!url) throw new Error("Set CAP_DB_URL (the database to change).");
  const host = new URL(url).host;
  const isLive = liveHosts().includes(norm(host));
  if (isLive && !flag("--allow-live")) throw new Error("REFUSING: CAP_DB_URL is the live database. Needs --allow-live and the owner's approval.");
  console.log(`database: ${isLive ? "LIVE" : "not live"} (${host.slice(0, 24)})  mode: ${APPLY ? "APPLY" : "DRY RUN"}  capability: ${CAPABILITY}\n`);

  const db = new Client({ connectionString: url }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const problems = [];
  const plan = [];

  const table = (await q(`select to_regclass('user_capabilities') t`))[0].t;
  if (!table) problems.push("the table user_capabilities does not exist (apply migration 20261124100000_user_capabilities first)");

  for (const t of TARGETS) {
    const u = await q(`select u.id, u."employeeCode", u."firstName", u."lastName", u.role::text role, u.status::text status, u."platformId", p.name company from users u join platforms p on p.id=u."platformId" where u."employeeCode" = $1`, [t.code]);
    if (u.length !== 1) { problems.push(`${t.code}: expected exactly one account, found ${u.length}`); continue; }
    const x = u[0];
    if (x.firstName.trim().toLowerCase() !== t.first.toLowerCase() || x.lastName.trim().toLowerCase() !== t.last.toLowerCase()) { problems.push(`${t.code}: the name is "${x.firstName} ${x.lastName}", expected "${t.first} ${t.last}"`); continue; }
    if (x.role !== "EMPLOYEE") { problems.push(`${t.code}: the role is ${x.role}, expected EMPLOYEE (the capability is for an Employee account that keeps its role)`); continue; }
    if (x.status !== "ACTIVE") { problems.push(`${t.code}: the account is ${x.status}, expected ACTIVE`); continue; }
    const has = table ? (await q(`select 1 from user_capabilities where "userId"=$1 and capability=$2`, [x.id, CAPABILITY])).length > 0 : false;
    if (has) { console.log(`= ${t.code} ${x.firstName} ${x.lastName} (${x.company}): already holds ${CAPABILITY}, nothing to do`); continue; }
    plan.push({ ...x, code: t.code });
    console.log(`+ ${t.code} ${x.firstName} ${x.lastName} (${x.company}): add ${CAPABILITY} (assign tasks to active employees of ${x.company}); role stays Employee`);
  }

  if (problems.length) { console.log("\nSTOP, nothing written:\n  - " + problems.join("\n  - ")); await db.end(); process.exit(1); }
  if (!APPLY) { console.log(`\nDRY RUN: ${plan.length} row(s) would be added. Nothing was written.`); await db.end(); return; }
  if (plan.length === 0) { console.log("\nNothing to do."); await db.end(); return; }

  try {
    await db.query("begin");
    for (const p of plan) {
      await db.query(`insert into user_capabilities (id, "userId", capability, note, "createdAt") values (gen_random_uuid(), $1, $2, $3, now())`, [p.id, CAPABILITY, "Provisioned by script: may assign tasks to active employees of their own company (no approval, rating or confirmation rights)"]);
      await db.query(
        `insert into audit_logs (id,"platformId","actorId",method,path,status,module,action,"recordType","recordId","targetUserId",summary,after,"createdAt") values (gen_random_uuid(),$1,null,'SCRIPT','/scripts/provision-capabilities',200,'Employees','PERMISSION','UserCapability',$2::text,$3::uuid,$4,$5::jsonb,now())`,
        [p.platformId, p.id, p.id, `Capability ${CAPABILITY} granted to ${p.firstName} ${p.lastName} (${p.code}); role and password unchanged`, JSON.stringify({ capability: CAPABILITY })],
      );
    }
    await db.query("commit");
  } catch (e) { await db.query("rollback").catch(() => {}); console.log("ROLLED BACK:", e.message); await db.end(); process.exit(1); }
  console.log(`\nDONE: ${plan.length} account(s) now hold ${CAPABILITY}.`);
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
