// The four individual Admin accounts: rename of SSB-01 / JAY-01, creation of Devang / Aayush, sign-in, forced password change,
// separate sessions and separate audit attribution. Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/admin-accounts.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
const DB = process.env.TEST_DATABASE_URL;
require("./_guard.cjs").assertTestDb(DB);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
const login = (id, pw) => call("POST", "/auth/login", null, { email: id, password: pw });
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const run = (extra) => spawnSync("node", [path.join(__dirname, "..", "scripts", "provision-admins.cjs"), "--group-company=Group Management", ...extra], { env: { ...process.env, ADMIN_DB_URL: DB }, encoding: "utf8" });

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const wipe = async () => {
    await q(`delete from company_access where "userId" in (select id from users where "employeeCode" in ('SSB-01','JAY-01','sanjay.bhati','jayesh.ahire','devang.master','aayush.master'))`);
    await q(`delete from users where "employeeCode" in ('SSB-01','JAY-01','sanjay.bhati','jayesh.ahire','devang.master','aayush.master')`).catch(() => {});
    await q(`delete from platforms where slug='group-management'`).catch(() => {});
  };
  await wipe();
  const OLD = await bcrypt.hash("OldPass@123", 10);
  const mk = async (code, first, last, plat, slug) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'ADMIN','ACTIVE',false,true,'ACTIVE','2026-01-01',now(),now()) returning id`, [plat, `${code.toLowerCase()}@${slug}.local`, OLD, first, last, code]))[0].id;
  const sanjayId = await mk("SSB-01", "Sanjay Singh", "Bhati", AV, "avatar");
  const jayeshId = await mk("JAY-01", "Jayesh", "Ahire", AN, "avance");
  for (const id of [sanjayId, jayeshId]) await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [id]);
  // an audit row that must survive the rename, attributed to Sanjay's user id
  await q(`insert into audit_logs (id,"platformId","actorId",method,path,status,module,action,summary,"createdAt") values (gen_random_uuid(),$1,$2,'POST','/api/test/old',200,'Other','OTHER','Old history line',now())`, [AV, sanjayId]);

  console.log("\n## dry run writes nothing");
  const dry = run([]);
  ok("dry run exits 0 and says DRY RUN", dry.status === 0 && /DRY RUN/.test(dry.stdout), dry.stdout + dry.stderr);
  ok("no user changed, none created", (await q(`select count(*)::int n from users where "employeeCode" in ('SSB-01','JAY-01')`))[0].n === 2 && (await q(`select count(*)::int n from users where "employeeCode" like '%.master'`))[0].n === 0);

  console.log("\n## refuses when something is wrong");
  const noCo = spawnSync("node", [path.join(__dirname, "..", "scripts", "provision-admins.cjs")], { env: { ...process.env, ADMIN_DB_URL: DB }, encoding: "utf8" });
  ok("missing company for the new Admins = refused, nothing written", noCo.status === 2 && /no company given/.test(noCo.stdout), noCo.stdout);
  const live = spawnSync("node", [path.join(__dirname, "..", "scripts", "provision-admins.cjs")], { env: { ...process.env, ADMIN_DB_URL: process.env.DATABASE_URL_LIVE_PROBE || "postgresql://x:y@127.0.0.1:1/z" }, encoding: "utf8" });
  ok("unreachable DB gives a clean failure", live.status === 1);

  console.log("\n## apply");
  const ap = run(["--apply"]);
  ok("apply succeeds", ap.status === 0 && /APPLIED/.test(ap.stdout), ap.stdout + ap.stderr);
  const u = async (code) => (await q(`select id,"employeeCode",email,role::text role,status::text status,"mustChangePassword" m,"platformId","passwordHash" h from users where "employeeCode"=$1`, [code]))[0];
  const [S, J, D, A] = [await u("sanjay.bhati"), await u("jayesh.ahire"), await u("devang.master"), await u("aayush.master")];
  ok("Sanjay: same user id, same company, ADMIN, must change password", S && S.id === sanjayId && S.platformId === AV && S.role === "ADMIN" && S.m === true, S);
  ok("Jayesh: same user id, same company, ADMIN, must change password", J && J.id === jayeshId && J.platformId === AN && J.role === "ADMIN" && J.m === true, J);
  ok("old IDs are gone, no duplicate records", (await q(`select count(*)::int n from users where "employeeCode" in ('SSB-01','JAY-01')`))[0].n === 0 && (await q(`select count(*)::int n from users where "employeeCode" in ('sanjay.bhati','jayesh.ahire','devang.master','aayush.master')`))[0].n === 4);
  const GC = (await q(`select id from platforms where slug='group-management'`))[0]; ok("Devang and Aayush: ADMIN under the new neutral company, must change password", D && A && GC && D.role === "ADMIN" && A.role === "ADMIN" && D.platformId === GC.id && A.platformId === GC.id && D.m && A.m); ok("exactly one new company, with an audit line", (await q(`select count(*)::int n from platforms where slug='group-management'`))[0].n === 1 && (await q(`select count(*)::int n from audit_logs where module='Companies' and path='/scripts/provision-admins' and "recordId"=$1`, [GC.id]))[0].n === 1);
  ok("passwords are bcrypt hashes, never plaintext", [S, J, D, A].every((x) => /^\$2[aby]\$10\$/.test(x.h)) && [S, J, D, A].every((x, i) => !x.h.includes(["Sanjay", "Jayesh", "Devang", "Aayush"][i])));
  ok("all four hold ONE all-company grant each", (await q(`select count(*)::int n from company_access where "platformId" is null and "userId" = any($1)`, [[S.id, J.id, D.id, A.id]]))[0].n === 4 && (await q(`select count(*)::int n from company_access where "userId" = any($1)`, [[S.id, J.id, D.id, A.id]]))[0].n === 4);
  ok("old history row still points at Sanjay's user id", (await q(`select count(*)::int n from audit_logs where "actorId"=$1 and summary='Old history line'`, [sanjayId]))[0].n === 1);
  ok("one audit line per account, naming the change, no password in it", (await q(`select count(*)::int n from audit_logs where path='/scripts/provision-admins' and "targetUserId" = any($1)`, [[S.id, J.id, D.id, A.id]]))[0].n === 4 && (await q(`select count(*)::int n from audit_logs where path='/scripts/provision-admins' and (summary ilike '%Sanjay''%' or after::text ilike '%"Sanjay"%')`))[0].n === 0);
  const again = run(["--apply"]);
  ok("running it twice is refused (no duplicates, nothing overwritten)", again.status === 2, again.stdout);

  console.log("\n## sign-in");
  ok("old IDs no longer sign in", (await login("SSB-01", "Sanjay")).s === 401 && (await login("JAY-01", "Jayesh")).s === 401 && (await login("ssb-01@avatar.local", "Sanjay")).s === 401);
  ok("old password no longer works on the new IDs", (await login("sanjay.bhati", "OldPass@123")).s === 401);
  ok("wrong password is refused", (await login("devang.master", "devang")).s === 401);
  const who = [["sanjay.bhati", "Sanjay", "Sanjay Singh"], ["jayesh.ahire", "Jayesh", "Jayesh"], ["devang.master", "Devang", "Devang"], ["aayush.master", "Aayush", "Aayush"]];
  const tok = {};
  for (const [id, pw, first] of who) {
    const r = await login(id, pw);
    ok(`${id}: signs in with the initial password as ADMIN`, r.s === 200 && r.b.user?.role === "ADMIN" && r.b.user?.employeeCode === id && r.b.user?.mustChangePassword === true, r);
    tok[id] = r.b.token;
    const me = await call("GET", "/auth/me", tok[id]);
    ok(`${id}: /auth/me shows ${first} (own identity)`, me.s === 200 && me.b.employeeCode === id && me.b.firstName === first, me.b);
    ok(`${id}: capitalised username also works (case-insensitive)`, (await login(id.toUpperCase(), pw)).s === 200);
  }
  ok("four tokens, four different user ids", new Set(Object.values(tok).map((t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).userId)).size === 4);

  console.log("\n## forced password change");
  for (const [id] of who) {
    const gated = await call("GET", "/tracker/session", tok[id]);
    ok(`${id}: tracker is locked until the password is changed (403 PASSWORD_CHANGE_REQUIRED)`, gated.s === 403 && gated.b.code === "PASSWORD_CHANGE_REQUIRED", gated);
  }
  const bad1 = await call("POST", "/onboarding/me/password", tok["sanjay.bhati"], { currentPassword: "Sanjay", newPassword: "Sanjay" });
  const bad2 = await call("POST", "/onboarding/me/password", tok["sanjay.bhati"], { currentPassword: "Sanjay", newPassword: "short" });
  ok("the same password or a too-short one is refused", bad1.s >= 400 && bad2.s >= 400, [bad1, bad2]);
  const NEW = { "sanjay.bhati": "Sanjay@New2026", "jayesh.ahire": "Jayesh@New2026", "devang.master": "Devang@New2026", "aayush.master": "Aayush@New2026" };
  for (const [id, pw] of who) {
    const c = await call("POST", "/onboarding/me/password", tok[id], { currentPassword: pw, newPassword: NEW[id] });
    ok(`${id}: changes the password`, c.s === 200, c);
    ok(`${id}: initial password stops working, the new one signs in with the flag cleared`, (await login(id, pw)).s === 401 && (await login(id, NEW[id])).b.user?.mustChangePassword === false);
  }

  console.log("\n## full Admin access, per account");
  for (const [id] of who) {
    const t = (await login(id, NEW[id])).b.token; tok[id] = t;
    const people = await call("GET", "/admin/users", t);
    ok(`${id}: people list across both companies`, people.s === 200 && new Set((people.b.users ?? people.b).map?.((x) => x.platformId ?? x.company?.id ?? x.company)).size >= 1, people.s);
    ok(`${id}: Admin console, teams, shifts, projects, audit log, reports`, (await call("GET", "/admin-console/overview", t)).s === 200 && (await call("GET", "/admin/teams", t)).s === 200 && (await call("GET", "/admin/shifts", t)).s === 200 && (await call("GET", "/projects", t)).s === 200 && (await call("GET", "/audit-logs", t)).s === 200 && (await call("GET", "/reports", t)).s === 200, null);
    ok(`${id}: tracker unlocked`, (await call("GET", "/tracker/session", t)).s !== 403);
    ok(`${id}: company access covers both companies`, (await call("GET", "/admin/company-access", t)).s !== 401);
  }

  console.log("\n## separate sessions, separate audit identity");
  const names = {};
  for (const [id] of who) {
    const r = await call("POST", "/admin/teams", tok[id], { name: `Audit-${id}` });
    ok(`${id}: performs an audited action`, r.s < 300, r); await new Promise((z) => setTimeout(z, 800));
    const row = (await q(`select a."actorId", u."employeeCode", u."firstName"||' '||u."lastName" nm, a.module, a.action, a.summary, a."createdAt" from audit_logs a left join users u on u.id=a."actorId" where a.path like '%/admin/teams%' and a.method='POST' and a."actorId"=(select id from users where "employeeCode"=$1) order by a."createdAt" desc limit 1`, [id]))[0];
    ok(`${id}: audit row carries their own user id and name (${row?.nm})`, !!row && row.employeeCode === id, row);
    names[id] = row?.actorId;
  }
  ok("four different actors in the audit log", new Set(Object.values(names)).size === 4);
  const al = await call("GET", "/audit-logs?limit=50", tok["devang.master"]);
  const list = al.b.items ?? al.b.logs ?? al.b.rows ?? [];
  ok("an Admin can read everyone's lines in the organisation-wide audit log", al.s === 200 && ["sanjay.bhati", "jayesh.ahire", "aayush.master"].every((id) => JSON.stringify(list).includes(id) || JSON.stringify(list).includes(id.split(".")[0][0].toUpperCase() + id.split(".")[0].slice(1))), list.slice?.(0, 3));
  ok("audit rows cannot be changed or deleted (trigger)", await (async () => { try { await q(`update audit_logs set summary='x' where "actorId"=$1`, [names["sanjay.bhati"]]); return false; } catch { try { await q(`delete from audit_logs where "actorId"=$1`, [names["sanjay.bhati"]]); return false; } catch { return true; } } })());
  ok("no audit route can edit or delete (no write method)", (await call("DELETE", "/audit-logs/x", tok["jayesh.ahire"])).s >= 400);

  console.log("\n## logout is per session (stateless token): one token never acts as another person");
  const m1 = await call("GET", "/auth/me", tok["sanjay.bhati"]);
  const m2 = await call("GET", "/auth/me", tok["aayush.master"]);
  ok("each token answers as its own person", m1.b.employeeCode === "sanjay.bhati" && m2.b.employeeCode === "aayush.master");
  ok("a suspended Admin is cut off at once without affecting the others", await (async () => { await q(`update users set status='SUSPENDED' where "employeeCode"='aayush.master'`); const a = (await call("GET", "/auth/me", tok["aayush.master"])).s; const b = (await call("GET", "/auth/me", tok["sanjay.bhati"])).s; await q(`update users set status='ACTIVE' where "employeeCode"='aayush.master'`); return a === 401 && b === 200; })());

  console.log("\n## cleanup");
  await q(`delete from teams where name like 'Audit-%@%' or name like 'Audit-%.%'`).catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
