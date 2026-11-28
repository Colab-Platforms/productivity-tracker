// "Content Creator" in the designation list: offered in the dropdowns, accepted by Add (import pipeline) and Edit for HR and Admin, stored in the
// list's own spelling, shown by the people list / filters / profile, never duplicated, and nobody else's designation changes.
// Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/designation-content-creator.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
const DB = process.env.TEST_DATABASE_URL;
require("./_guard.cjs").assertTestDb(DB);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Tcc@12345678";
const norm = (s) => String(s).toLowerCase().replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").trim();

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0];
  const companyName = (await q(`select name from platforms where id=$1`, [A.id]))[0].name;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from users where "employeeCode" like 'TCC-%' or email like '%@tcc.test'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, first, role, designation) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining",designation,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Tcc',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',$7,now(),now()) returning id`, [A.id, code.toLowerCase() + "@tcc.test", hash, first, code, role, designation ?? null]))[0].id;
  const login = async (code) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
  const AD = await mk("TCC-AD", "Admin", "ADMIN"), HR = await mk("TCC-HR", "Hrp", "HR");
  const E1 = await mk("TCC-E1", "Empone", "EMPLOYEE"), E2 = await mk("TCC-E2", "Emptwo", "EMPLOYEE", "Telecaller"), E3 = await mk("TCC-E3", "Empthree", "EMPLOYEE");
  const tAD = await login("TCC-AD"), tHR = await login("TCC-HR"), tE1 = await login("TCC-E1");
  // everyone who existed before: their designation must be exactly the same afterwards
  const fingerprint = async () => JSON.stringify(await q(`select id, designation from users where "employeeCode" not like 'TCC-%' order by id`));
  const before = await fingerprint();

  console.log("\n## the list the dropdowns use");
  for (const [who, tok] of [["HR", tHR], ["Admin", tAD]]) {
    const dd = await call("GET", `/admin/employees/dropdowns?companyId=${A.id}`, tok);
    const list = dd.b.designations ?? [];
    ok(`${who}: the Add/Edit dropdown offers "Content Creator" exactly once`, dd.s === 200 && list.filter((d) => d === "Content Creator").length === 1, [dd.s, list.length]);
    ok(`${who}: the list has no duplicates (ignoring capitals/spacing)`, new Set(list.map(norm)).size === list.length, list);
    ok(`${who}: the existing designations are still all there`, ["Accountant", "Graphic Designer", "HR Generalist", "Telecaller", "Video Editor", "Creative Head", "Business Operations & Legal"].every((d) => list.includes(d)), list);
    ok(`${who}: it sits in alphabetical order, between its neighbours`, list.indexOf("Content Creator") === list.indexOf("Business Operations & Legal") + 1 && list.indexOf("Content Creator") === list.indexOf("Creative Head") - 1, list.slice(0, 12));
  }
  const lookups = await call("GET", "/admin/employees/lookups", tHR);
  ok("the Add Employee / Import lookups offer it too", (lookups.b.allDesignations ?? []).includes("Content Creator"), lookups.s);
  const listSize = (await call("GET", `/admin/employees/dropdowns?companyId=${A.id}`, tAD)).b.designations.length;
  ok("the list has 37 titles (Content Creator, Business Advisor, then five more added 2026-11-28)", listSize === 37, listSize);

  console.log("\n## Edit employee (HR and Admin)");
  const hrEdit = await call("PATCH", `/admin/users/${E1}`, tHR, { designation: "  content   CREATOR " });
  ok("HR can set it on a person; it is stored in the list's own spelling", hrEdit.s === 200 && (await q(`select designation from users where id=$1`, [E1]))[0].designation === "Content Creator", hrEdit);
  const noConfirm = await call("PATCH", `/admin/users/${E2}`, tAD, { designation: "Content Creator" });
  ok("replacing an existing designation still asks for confirmation (unchanged rule)", noConfirm.s === 409 && (await q(`select designation from users where id=$1`, [E2]))[0].designation === "Telecaller", noConfirm);
  const adEdit = await call("PATCH", `/admin/users/${E2}`, tAD, { designation: "Content Creator", confirmOverwrite: { designation: true } });
  ok("Admin can replace a designation with it once confirmed", adEdit.s === 200 && (await q(`select designation from users where id=$1`, [E2]))[0].designation === "Content Creator", adEdit);
  const adEdit3 = await call("PATCH", `/admin/users/${E3}`, tAD, { designation: "Content Creator" });
  ok("Admin can set it on a person with no designation", adEdit3.s === 200 && (await q(`select designation from users where id=$1`, [E3]))[0].designation === "Content Creator", adEdit3);
  const typo = await call("PATCH", `/admin/users/${E3}`, tAD, { designation: "Content Creater", confirmOverwrite: { designation: true } });
  ok("a near-spelling is NOT accepted (no duplicate entry can be created)", typo.s === 400 && (await q(`select designation from users where id=$1`, [E3]))[0].designation === "Content Creator", typo);
  const empEdit = await call("PATCH", `/admin/users/${E1}`, tE1, { designation: "Telecaller", confirmOverwrite: { designation: true } });
  ok("an Employee cannot edit designations (403)", empEdit.s === 403, empEdit.s);

  console.log("\n## Add employee (import pipeline, as HR and as Admin)");
  const FIELDS = ["company", "fullName", "employeeId", "email", "mobile", "designation", "team", "projects", "role", "reportsToName", "reportsToId", "dateOfJoining", "shiftStart", "shiftEnd", "shiftDays"];
  const mapping = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
  const cells = (name, email, desig) => [companyName, name, "", email, "", desig, "", "", "Employee", "NONE", "NONE", "2024-05-01", "", "", ""];
  const req = (c) => ({ rows: [{ rowNumber: 1, cells: c }], mapping, options: { blankTeamIsNone: true, onboarding: "EXISTING", blankIdIsGenerated: true } });
  for (const [who, tok, email, desig] of [["HR", tHR, "newhr@tcc.test", "content creator"], ["Admin", tAD, "newad@tcc.test", "Content Creator"]]) {
    const pv = await call("POST", "/admin/employees/preview", tok, req(cells(`Added By${who}`, email, desig)));
    ok(`${who}: the preview accepts the designation`, pv.s === 200 && pv.b.rows[0].status === "VALID", pv.b.rows?.[0]);
    const done = await call("POST", "/admin/employees/commit", tok, { ...req(cells(`Added By${who}`, email, desig)), confirm: true, expectedValid: 1 });
    ok(`${who}: the new employee is saved with Content Creator`, (done.s === 200 || done.s === 201) && (await q(`select designation from users where email=$1`, [email]))[0]?.designation === "Content Creator", done);
  }
  const bad = await call("POST", "/admin/employees/preview", tHR, req(cells("Bad Person", "bad@tcc.test", "Content Creater")));
  ok("the Add form refuses a near-spelling with a clear reason", bad.b.rows[0].status === "INVALID" && bad.b.rows[0].issues.some((i) => i.code === "NOT_IN_LIST"), bad.b.rows?.[0]);

  console.log("\n## where it is displayed");
  const users = await call("GET", "/admin/users", tAD);
  const mine = (users.b.users ?? []).filter((u) => u.designation === "Content Creator");
  ok("the people list shows 'Content Creator' for those people", mine.length >= 4 && mine.every((u) => u.employeeCode?.startsWith("TCC-") || u.firstName === "Added"), mine.map((u) => u.employeeCode));
  const filtered = await call("GET", "/admin/users?designation=content%20creator", tHR);
  ok("the designation filter finds them (any capitals)", filtered.s === 200 && filtered.b.users.length >= 4 && filtered.b.users.every((u) => u.designation === "Content Creator"), filtered.b.users?.length);
  const opts = await call("GET", "/hr-filters/options", tAD);
  ok("the shared filter bar lists it with a headcount", (opts.b.designations ?? []).some((d) => d.name === "Content Creator" && d.people >= 4), opts.b.designations);
  const prof = await call("GET", "/auth/me/profile", await login("TCC-E1"));
  ok("the person's own profile shows it", prof.s === 200 && JSON.stringify(prof.b).includes("Content Creator"), prof.s);
  const rep = await call("GET", `/team-attendance/attendance?from=2026-11-01&to=2026-11-02`, tAD);
  ok("reports that list designation still load", rep.s === 200, rep.s);

  console.log("\n## nothing else changed");
  await wipe();
  const after = await fingerprint();
  ok("every pre-existing person has exactly the designation they had", after === before, 0);
  ok("the test's own people were cleaned up", (await q(`select count(*)::int n from users where "employeeCode" like 'TCC-%' or email like '%@tcc.test'`))[0].n === 0, 0);
  void HR; void AD;
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
