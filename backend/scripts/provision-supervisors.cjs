// Give the Productivity Supervisor monitoring view to EXACTLY two existing accounts (Saurabh Jadhav CP-01, Chirag Parmar AWL-06).
// This is the only way the role is ever assigned: no API route writes the table. The accounts keep their user id, password, role (EMPLOYEE),
// company and every record; only one row is added to `productivity_supervisors`.
//
// DRY RUN BY DEFAULT: prints what it would do and writes nothing. Add --apply to write (one transaction, all or nothing).
// The database comes from SUP_DB_URL (never from .env). The live database is refused unless --allow-live is also given; do that ONLY with the
// owner's explicit approval, and only after the migration 20261119120000_productivity_supervisors has been applied there.
//
//   SUP_DB_URL=... node scripts/provision-supervisors.cjs [--apply] [--allow-live]
const fs = require("node:fs"), path = require("node:path");
const B = path.join(__dirname, "..", "node_modules") + path.sep;
const { Client } = require(B + "pg");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const APPLY = flag("--apply");

// Matched by employee ID AND name, so a changed or reused ID can never give the role to somebody else.
const TARGETS = [
  { code: "CP-01", first: "Saurabh", last: "Jadhav" },
  { code: "AWL-06", first: "Chirag", last: "Parmar" },
];

function liveHost() {
  try {
    const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const line = env.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL=") || l.startsWith("DIRECT_URL="));
    return line ? new URL(line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")).host : null;
  } catch { return null; }
}

(async () => {
  const url = process.env.SUP_DB_URL;
  if (!url) throw new Error("Set SUP_DB_URL (the database to change).");
  const host = new URL(url).host;
  const isLive = host === liveHost();
  if (isLive && !flag("--allow-live")) throw new Error("REFUSING: SUP_DB_URL is the live database. Needs --allow-live and the owner's approval.");
  console.log(`database: ${isLive ? "LIVE" : "not live"} (${host.slice(0, 24)})  mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const db = new Client({ connectionString: url }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const problems = [];
  const plan = [];

  const table = (await q(`select to_regclass('productivity_supervisors') t`))[0].t;
  if (!table) problems.push("the table productivity_supervisors does not exist (apply migration 20261119120000_productivity_supervisors first)");

  for (const t of TARGETS) {
    const u = await q(`select u.id, u."employeeCode", u."firstName", u."lastName", u.role::text role, u.status::text status, u."platformId", p.name company from users u join platforms p on p.id=u."platformId" where lower(u."employeeCode") = lower($1)`, [t.code]);
    if (u.length !== 1) { problems.push(`${t.code}: expected exactly one account, found ${u.length}`); continue; }
    const x = u[0];
    if (x.firstName.trim().toLowerCase() !== t.first.toLowerCase() || x.lastName.trim().toLowerCase() !== t.last.toLowerCase()) { problems.push(`${t.code}: the name is "${x.firstName} ${x.lastName}", not ${t.first} ${t.last}`); continue; }
    if (x.role !== "EMPLOYEE") { problems.push(`${t.code}: the role is ${x.role}, expected EMPLOYEE (the supervisor view is for an Employee account)`); continue; }
    if (x.status !== "ACTIVE") { problems.push(`${t.code}: the account is ${x.status}, expected ACTIVE`); continue; }
    const has = table ? (await q(`select 1 from productivity_supervisors where "userId"=$1`, [x.id])).length > 0 : false;
    if (has) { console.log(`= ${t.code} ${x.firstName} ${x.lastName} (${x.company}): already a Productivity Supervisor, nothing to do`); continue; }
    plan.push({ ...x, code: t.code });
    console.log(`+ ${t.code} ${x.firstName} ${x.lastName} (${x.company}): add the Productivity Supervisor view; account, password and role stay as they are`);
  }

  if (problems.length) { console.log("\nSTOP, nothing written:\n  - " + problems.join("\n  - ")); await db.end(); process.exit(1); }
  if (!APPLY) { console.log(`\nDRY RUN: ${plan.length} row(s) would be added. Nothing was written.`); await db.end(); return; }
  if (plan.length === 0) { console.log("\nNothing to do."); await db.end(); return; }

  try {
    await db.query("begin");
    for (const p of plan) {
      await db.query(`insert into productivity_supervisors (id, "userId", note, "createdAt") values (gen_random_uuid(), $1, $2, now())`, [p.id, "Provisioned by script: organisation-wide read-only monitoring"]);
      await db.query(
        `insert into audit_logs (id,"platformId","actorId",method,path,status,module,action,"recordType","recordId","targetUserId",summary,after,"createdAt") values (gen_random_uuid(),$1,null,'SCRIPT','/scripts/provision-supervisors',200,'Employees','PERMISSION','Employee',$2::text,$3::uuid,$4,$5::jsonb,now())`,
        [p.platformId, p.id, p.id, `Productivity Supervisor view granted to ${p.firstName} ${p.lastName} (${p.code}); read-only, role and password unchanged`, JSON.stringify({ productivitySupervisor: true })]
      );
    }
    await db.query("commit");
  } catch (e) { await db.query("rollback").catch(() => {}); console.log("ROLLED BACK:", e.message); await db.end(); process.exit(1); }
  console.log(`\nDONE: ${plan.length} account(s) are now Productivity Supervisors.`);
  await db.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
