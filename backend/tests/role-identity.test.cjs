// The role a person is shown (and given permissions for) is the role stored for THEM: sign-in response, token, /auth/me and the permission
// check all agree, for all four roles, and they follow the database (a role change applies on the next request). Disposable database only.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/role-identity.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Rid@12345678";
const payload = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = () => q(`delete from users where "employeeCode" like 'RID-%'`);
  await wipe();
  const make = async (code, role, designation) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,designation,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Role',$5,$6,'ACTIVE',$7,false,true,'ACTIVE','2026-01-01',now(),now())`, [AV, code.toLowerCase() + "@rid.test", hash, code.replace("RID-", "R"), code, role, designation]);
    return (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
  };
  const people = [
    ["RID-AD", "ADMIN", "Director"],
    ["RID-HR", "HR", "HR Generalist"],
    ["RID-MG", "MANAGER", "Team Lead"],
    ["RID-EM", "EMPLOYEE", "Associate"],
  ];
  const ids = {};
  for (const [code, role, des] of people) ids[code] = await make(code, role, des);
  const login = async (code) => (await call("POST", "/auth/login", null, { email: code, password: PW }));

  console.log("\n## every role: sign-in, token, /auth/me and the database agree");
  const tokens = {};
  for (const [code, role] of people) {
    const l = await login(code);
    tokens[code] = l.b.token;
    ok(`${role}: the sign-in response carries the stored role`, l.s === 200 && l.b.user?.role === role, l.b.user);
    ok(`${role}: the token carries the stored role and this person's id`, payload(l.b.token).role === role && payload(l.b.token).userId === ids[code], payload(l.b.token));
    const me = await call("GET", "/auth/me", l.b.token);
    ok(`${role}: /auth/me answers with the stored role, name and employee ID`, me.b.role === role && me.b.employeeCode === code && me.b.firstName === code.replace("RID-", "R"), me.b);
  }

  console.log("\n## permissions follow the same role (HR is not Admin)");
  const adminOnly = (code) => call("GET", "/admin-console/overview", tokens[code]);
  ok("only the Admin account opens the Admin console", (await adminOnly("RID-AD")).s === 200 && (await adminOnly("RID-HR")).s === 403 && (await adminOnly("RID-MG")).s === 403 && (await adminOnly("RID-EM")).s === 403);
  const hrArea = (code) => call("GET", "/admin/users", tokens[code]);
  ok("Admin and HR open the people list; manager and employee do not", (await hrArea("RID-AD")).s === 200 && (await hrArea("RID-HR")).s === 200 && (await hrArea("RID-MG")).s === 403 && (await hrArea("RID-EM")).s === 403);
  ok("HR cannot create an HR or Admin account (only an Admin can)", (await call("POST", "/admin/users", tokens["RID-HR"], { email: "x1@rid.test", password: "Abcdefgh1!", firstName: "X", lastName: "Y", role: "ADMIN" })).s === 403);

  console.log("\n## the role comes from the database on every request");
  await q(`update users set role='EMPLOYEE' where id=$1`, [ids["RID-HR"]]); // demote the HR person; their old token is still valid
  const after = await call("GET", "/auth/me", tokens["RID-HR"]);
  ok("after a demotion /auth/me shows the new role at once (no stale role from the token)", after.b.role === "EMPLOYEE", after.b);
  ok("...and the HR-only area now refuses them", (await hrArea("RID-HR")).s === 403);
  await q(`update users set role='HR' where id=$1`, [ids["RID-HR"]]);
  ok("restored to HR: /auth/me says HR again, never Admin", (await call("GET", "/auth/me", tokens["RID-HR"])).b.role === "HR");

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
