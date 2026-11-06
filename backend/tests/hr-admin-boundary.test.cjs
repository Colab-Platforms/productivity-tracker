// HR and Admin use the same Employees screen but are NOT the same: HR keeps employee records, teams and leave; organization-wide rules (shifts,
// alert thresholds) and HR/Admin accounts stay with the Admin. Checked on the server for 4 Admins, 1 HR, 3 Managers and an Employee.
// Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/hr-admin-boundary.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body && m !== "GET" ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Hab@12345678";
const NOPE = "00000000-0000-4000-8000-000000000000";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = () => q(`delete from users where "employeeCode" like 'HAB-%'`);
  await wipe();
  const mk = async (code, role) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Hab',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',now(),now())`, [AV, code.toLowerCase() + "@hab.test", hash, code.replace("HAB-", "H"), code, role]);
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return tok;
  };
  const admins = [await mk("HAB-A1", "ADMIN"), await mk("HAB-A2", "ADMIN"), await mk("HAB-A3", "ADMIN"), await mk("HAB-A4", "ADMIN")];
  const hr = await mk("HAB-HR", "HR");
  const mgrs = [await mk("HAB-M1", "MANAGER"), await mk("HAB-M2", "MANAGER"), await mk("HAB-M3", "MANAGER")];
  const emp = await mk("HAB-E1", "EMPLOYEE");

  const status = async (m, p, t, body) => (await call(m, p, t, body)).s;

  console.log("\n## what HR keeps (employee records, teams, leave, reading shifts)");
  ok("HR opens the people list", (await status("GET", "/admin/users", hr)) === 200);
  ok("HR reads the teams and the shifts (to assign people)", (await status("GET", "/admin/teams", hr)) === 200 && (await status("GET", "/admin/shifts", hr)) === 200);
  ok("HR reads the leave marks", (await status("GET", "/admin/leave", hr)) === 200);
  ok("HR still opens the Edit Employee data", (await status("GET", "/admin/options", hr)) === 200);

  console.log("\n## what HR does NOT get: organization-wide rules");
  ok("HR cannot create a shift (403)", (await status("POST", "/admin/shifts", hr, { name: "HR shift" })) === 403);
  ok("HR cannot change a shift (403)", (await status("PATCH", `/admin/shifts/${NOPE}`, hr, { name: "x" })) === 403);
  ok("HR cannot change alert thresholds (403)", (await status("PATCH", `/admin/config/${NOPE}`, hr, { lateLoginGraceMinutes: 30 })) === 403);
  ok("HR cannot create an Admin or HR account (403)", (await status("POST", "/admin/users", hr, { email: "n1@hab.test", password: "Abcdefgh1!", firstName: "N", lastName: "One", role: "ADMIN" })) === 403);
  ok("HR cannot open the Admin console (403)", (await status("GET", "/admin-console/overview", hr)) === 403);

  console.log("\n## Admin keeps all of it (all four Admin accounts)");
  for (let i = 0; i < admins.length; i++) {
    const a = admins[i];
    ok(`Admin ${i + 1}: people list, shifts and teams`, (await status("GET", "/admin/users", a)) === 200 && (await status("GET", "/admin/shifts", a)) === 200 && (await status("GET", "/admin/teams", a)) === 200);
    ok(`Admin ${i + 1}: shift and threshold routes are open to them (a bad request, not a refusal)`, (await status("POST", "/admin/shifts", a, {})) === 400 && [400, 404].includes(await status("PATCH", `/admin/config/${NOPE}`, a, { lateLoginGraceMinutes: 30 })), null);
    ok(`Admin ${i + 1}: the Admin console opens`, (await status("GET", "/admin-console/overview", a)) === 200);
  }

  console.log("\n## managers and employees get none of it");
  const paths = [["GET", "/admin/users"], ["GET", "/admin/shifts"], ["POST", "/admin/shifts"], ["PATCH", `/admin/config/${NOPE}`], ["GET", "/admin-console/overview"]];
  for (let i = 0; i < mgrs.length; i++) ok(`Manager ${i + 1}: every one of those is refused (403)`, (await Promise.all(paths.map(([m, p]) => status(m, p, mgrs[i], {})))).every((s) => s === 403));
  ok("Employee: every one of those is refused (403)", (await Promise.all(paths.map(([m, p]) => status(m, p, emp, {})))).every((s) => s === 403));

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
