// Provision the four individual Admin accounts (Sanjay, Jayesh, Devang, Aayush).
//
//   RENAME  sanjay.bhati / jayesh.ahire : the EXISTING Admin records (SSB-01, JAY-01) keep their user id, company, role, history and
//           company-access grant; only the sign-in ID (employeeCode), the placeholder email derived from it, and the password change.
//   CREATE  devang.master / aayush.master : new Admin users + an all-company grant (company_access, platformId null).
//
// DRY RUN BY DEFAULT: prints what it would do and writes nothing. Add --apply to write (one transaction, all or nothing).
// The database comes from ADMIN_DB_URL (never from .env). The live database is refused unless --allow-live is also given;
// do that ONLY with the owner's explicit approval.
//
//   ADMIN_DB_URL=... node scripts/provision-admins.cjs --company-devang=<slug> --company-aayush=<slug> [--apply] [--allow-live]
const fs = require("node:fs"), path = require("node:path");
const B = path.join(__dirname, "..", "node_modules") + path.sep;
const { Client } = require(B + "pg");
const bcrypt = require(B + "bcryptjs");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => (args.find((a) => a.startsWith(n + "=")) || "").slice(n.length + 1) || null;
const APPLY = flag("--apply");

const RENAMES = [
  { from: "SSB-01", username: "sanjay.bhati", password: "Sanjay" },
  { from: "JAY-01", username: "jayesh.ahire", password: "Jayesh" },
];
const CREATES = [
  { username: "devang.master", first: "Devang", last: "Master", password: "Devang", companySlug: val("--company-devang") },
  { username: "aayush.master", first: "Aayush", last: "Master", password: "Aayush", companySlug: val("--company-aayush") },
];

function liveHost() {
  try {
    const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const line = env.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL=") || l.startsWith("DIRECT_URL="));
    return line ? new URL(line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")).host : null;
  } catch { return null; }
}

(async () => {
  const url = process.env.ADMIN_DB_URL;
  if (!url) throw new Error("Set ADMIN_DB_URL (the database to change).");
  const host = new URL(url).host;
  const isLive = host === liveHost();
  if (isLive && !flag("--allow-live")) throw new Error("REFUSING: ADMIN_DB_URL is the live database. Needs --allow-live and the owner's approval.");
  console.log(`database: ${isLive ? "LIVE" : "not live"} (${host.slice(0, 24)})  mode: ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const db = new Client({ connectionString: url }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const problems = [];
  const plan = [];
  const taken = async (name, exceptUserId) => {
    const n = name.toLowerCase();
    const r = await q(`select id, "employeeCode", email from users where (lower("employeeCode")=$1 or lower(email)=$1 or lower(split_part(email,'@',1))=$1) and id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000')`, [n, exceptUserId ?? null]);
    const alias = await q(`select "userId" from login_usernames where username=$1`, [n]).catch(() => []);
    return r.length > 0 || alias.length > 0;
  };

  for (const r of RENAMES) {
    const u = await q(`select u.id, u."employeeCode", u.email, u.role::text role, u.status::text status, u."platformId", p.slug from users u join platforms p on p.id=u."platformId" where upper(u."employeeCode")=upper($1)`, [r.from]);
    if (u.length !== 1) { problems.push(`${r.from}: expected exactly one user, found ${u.length}`); continue; }
    const x = u[0];
    if (x.role !== "ADMIN") problems.push(`${r.from} is ${x.role}, not ADMIN`);
    if (await taken(r.username, x.id)) problems.push(`${r.username} is already taken`);
    const alias = await q(`select username from login_usernames where "userId"=$1`, [x.id]).catch(() => []);
    if (alias.length) problems.push(`${r.from} has a login alias (${alias[0].username}) that would keep working; not touching it without approval`);
    // The email is a placeholder only when it is exactly <old code>@<company slug>.local; then it moves with the code.
    const placeholder = x.email.toLowerCase() === `${x.employeeCode.toLowerCase()}@${x.slug}.local`;
    const newEmail = placeholder ? `${r.username}@${x.slug}.local` : x.email;
    if (placeholder && (await q(`select 1 from users where "platformId"=$1 and lower(email)=$2 and id<>$3`, [x.platformId, newEmail, x.id])).length) problems.push(`${newEmail} already used`);
    if (!placeholder) console.log(`note: ${r.from}'s email (${x.email}) is a real address, left as is`);
    plan.push({ kind: "RENAME", user: x, ...r, newEmail });
  }
  // --group-company="Group Management": a neutral home for the group-level owners. Created only if no company has that slug yet.
  const groupName = val("--group-company");
  const groupSlug = groupName ? groupName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : null;
  let newCompany = null;
  if (groupName) {
    if ((await q(`select 1 from platforms where lower(name)=lower($1)`, [groupName])).length && !(await q(`select 1 from platforms where slug=$1`, [groupSlug])).length) problems.push(`a company named '${groupName}' exists under another slug`);
    else if (!(await q(`select 1 from platforms where slug=$1`, [groupSlug])).length) { newCompany = { name: groupName, slug: groupSlug }; plan.push({ kind: "COMPANY", ...newCompany }); }
  }
  for (const c of CREATES) {
    const slug = groupSlug ?? c.companySlug;
    if (!slug) { problems.push(`${c.username}: no company given (--company-${c.first.toLowerCase()}=<slug> or --group-company=<name>)`); continue; }
    const p = await q(`select id, slug from platforms where slug=$1 and "isActive"`, [slug]);
    if (p.length !== 1 && !(newCompany && slug === newCompany.slug)) { problems.push(`${c.username}: company '${slug}' not found/active`); continue; }
    if (await taken(c.username)) problems.push(`${c.username} is already taken`);
    if (p.length && (await q(`select 1 from users where "platformId"=$1 and lower("firstName")=lower($2) and lower("lastName")=lower($3)`, [p[0].id, c.first, c.last])).length) problems.push(`a person named ${c.first} ${c.last} already exists in ${slug}`);
    plan.push({ kind: "CREATE", platformId: p[0]?.id ?? null, slug, email: `${c.username}@${slug}.local`, ...c });
  }

  for (const p of plan) console.log(p.kind === "COMPANY" ? `CREATE COMPANY "${p.name}" (slug ${p.slug}): a neutral home for the group-level Admins` : p.kind === "RENAME" ? `RENAME ${p.user.employeeCode} -> ${p.username}  (user ${p.user.id.slice(0, 8)}, email ${p.user.email} -> ${p.newEmail}, password reset, must change at first sign-in)` : `CREATE ${p.username}  ${p.first} ${p.last}  ADMIN in ${p.slug}, email ${p.email}, all-company access, must change password at first sign-in`);
  if (problems.length) { console.log("\nPROBLEMS (nothing written):"); problems.forEach((x) => console.log("  - " + x)); await db.end(); process.exit(2); }
  if (!APPLY) { console.log("\nDry run only. Re-run with --apply to write."); await db.end(); return; }

  await db.query("BEGIN");
  try {
    let createdCompanyId = null;
    for (const p of plan) {
      if (p.kind === "COMPANY") {
        const cols = (await db.query(`select column_name from information_schema.columns where table_name='platforms'`)).rows.map((x) => x.column_name);
        const extra = ["createdAt", "updatedAt"].filter((c) => cols.includes(c));
        const r = await db.query(`insert into platforms (id,name,slug${extra.map((c) => `,"${c}"`).join("")}) values (gen_random_uuid(),$1,$2${extra.map(() => ",now()").join("")}) returning id`, [p.name, p.slug]);
        createdCompanyId = r.rows[0].id;
        await db.query(`insert into audit_logs (id,"platformId","actorId",method,path,status,module,action,"recordType","recordId",summary,after,"createdAt") values (gen_random_uuid(),$1::uuid,null,'SCRIPT','/scripts/provision-admins',200,'Companies','CREATE','Company',$1::text,$2,$3,now())`, [createdCompanyId, `Company "${p.name}" created as the home of the group-level Admins`, JSON.stringify({ name: p.name, slug: p.slug })]);
        continue;
      }
      if (p.kind === "CREATE" && !p.platformId) p.platformId = createdCompanyId;
      const hash = await bcrypt.hash(p.password, 10);
      let userId, platformId, summary, before = null, after;
      if (p.kind === "RENAME") {
        userId = p.user.id; platformId = p.user.platformId;
        await db.query(`update users set "employeeCode"=$2, email=$3, "passwordHash"=$4, "mustChangePassword"=true, "updatedAt"=now() where id=$1`, [userId, p.username, p.newEmail, hash]);
        before = { employeeCode: p.user.employeeCode, email: p.user.email };
        after = { employeeCode: p.username, email: p.newEmail, mustChangePassword: true };
        summary = `Admin sign-in ID changed from ${p.user.employeeCode} to ${p.username}; password reset (value not recorded)`;
      } else {
        const r = await db.query(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'ADMIN','ACTIVE',true,true,'ACTIVE',current_date,now(),now()) returning id`, [p.platformId, p.email, hash, p.first, p.last, p.username]);
        userId = r.rows[0].id; platformId = p.platformId;
        after = { employeeCode: p.username, role: "ADMIN", company: p.slug, mustChangePassword: true };
        summary = `Admin account ${p.username} created (${p.first} ${p.last}); password not recorded`;
      }
      const has = await db.query(`select 1 from company_access where "userId"=$1 and "platformId" is null`, [userId]);
      if (!has.rows.length) await db.query(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [userId]);
      await db.query(`insert into audit_logs (id,"platformId","actorId",method,path,status,module,action,"recordType","recordId","targetUserId",summary,before,after,"createdAt") values (gen_random_uuid(),$1,null,'SCRIPT','/scripts/provision-admins',200,'Employees',$2,'User',$3::text,$3::uuid,$4,$5,$6,now())`,
        [platformId, p.kind === "CREATE" ? "CREATE" : "UPDATE", userId, summary, before ? JSON.stringify(before) : null, JSON.stringify(after)]);
    }
    await db.query("COMMIT");
    console.log("\nAPPLIED.");
  } catch (e) { await db.query("ROLLBACK"); throw e; }
  await db.end();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
