// Update Employees with a BLANK Employee ID: the person is found by work email or exact name (one match only), the existing ID is used.
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/update-by-name.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
require("./_guard.cjs");
const API = process.env.TEST_API || "http://localhost:5012/api";
const post = async (p, t, b) => { const r = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: JSON.stringify(b) }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  let OTHER = (await q(`select id from platforms where slug='name-co'`))[0]?.id;
  if (!OTHER) OTHER = (await q(`insert into platforms (id,name,slug,"updatedAt") values (gen_random_uuid(),'Name Co','name-co',now()) returning id`))[0].id;
  const wipe = async () => {
    await q(`delete from employee_personal_details where "userId" in (select id from users where "employeeCode" like 'NBN-%')`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'NBN-%')`).catch(() => {});
    await q(`delete from login_events where "employeeCode" like 'NBN-%'`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'NBN-%'`).catch((e) => console.log("wipe", e.message.slice(0, 60)));
  };
  await wipe();
  const hash = await bcrypt.hash("Nbn@12345678", 10);
  const mk = async (code, first, last, role, plat = A, email) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'ACTIVE',false,now(),now()) returning id`, [plat, email ?? code.toLowerCase() + "@nbn.test", hash, first, last, code, role]))[0].id;
  await mk("NBN-HR", "Hana", "Hr", "HR");
  const f = await mk("NBN-1", "Md", "Faizan Qureshi", "EMPLOYEE", A, "faizan.real@nbn.test");
  const r1 = await mk("NBN-2", "Rohit", "Saundalkar", "EMPLOYEE");
  await mk("NBN-3", "Sam", "Same", "EMPLOYEE");
  await mk("NBN-4", "Sam", "Same", "EMPLOYEE");
  await mk("NBN-5", "Foreign", "Person", "EMPLOYEE", OTHER);
  const e6 = await mk("NBN-6", "Quinn", "Mailer", "EMPLOYEE", A, "quinn.real@nbn.test");
  await mk("NBN-7", "Vera", "Oldname", "EMPLOYEE");
  await mk("NBN-AD", "Ada", "Boss", "ADMIN");
  const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "NBN-HR", password: "Nbn@12345678" }) })).json()).token;
  // columns: 0 ID (blank), 1 full name, 2 email, 3 gender, 4 city
  const mapping = { employeeId: 0, fullName: 1, email: 2, gender: 3, city: 4 };
  const rows = [
    ["", "Md. Faizan Qureshi", "", "Male", "Pune"],
    ["", "rohit SAUNDALKAR", "", "Male", "Mumbai"],
    ["", "Someone Else", "quinn.real@nbn.test", "Female", "Thane"],
    ["", "Sam Same", "", "Male", "Delhi"],
    ["", "Nobody Here", "", "Male", "Goa"],
    ["", "Foreign Person", "", "Male", "Rome"],
    ["", "Ada Boss", "", "Male", "Oslo"],
    ["", "", "", "Male", "Nowhere"],
    ["vera_old", "Vera Oldname", "", "Male", "Unknown-ID-row"],
    ["nobody_old", "Zed Nobody", "", "Male", "Nowhere"],
    ["NBN-3", "Anything Typed", "", "Male", "Exists-row"],
  ].map((cells, i) => ({ rowNumber: i + 2, cells }));
  const pv = (await post("/admin/employees/update/preview", tok, { rows, mapping })).b;
  const R = (n) => pv.rows[n];
  ok("name with a dot / different spacing finds the one person, existing ID used", R(0).employeeId === "NBN-1" && R(0).status === "UPDATE" && R(0).notes.some((n) => /matched by exact name, existing ID NBN-1/.test(n)), R(0));
  ok("capitals do not matter", R(1).employeeId === "NBN-2" && R(1).status === "UPDATE", R(1));
  ok("the work email finds the person (and the note says so)", R(2).employeeId === "NBN-6" && R(2).notes.some((n) => /found by work email/.test(n)), R(2));
  ok("two people with the same name are refused, nobody guessed", R(3).status === "INVALID" && R(3).issues.some((i) => /More than one person is called/.test(i.message)), R(3));
  ok("an unknown name is refused with a clear message", R(4).status === "INVALID" && /no existing employee matches/.test(R(4).issues[0].message), R(4));
  ok("another company's person is not reachable by name", R(5).status === "INVALID", R(5));
  ok("Admin accounts are never matched by name", R(6).status === "INVALID", R(6));
  ok("a row with no ID, name or email says what is missing", R(7).status === "INVALID" && /No name or email/.test(R(7).issues[0].message), R(7));
  ok("an ID that no account has (old username) is looked up by name; the real ID is used and the note says so", R(8).employeeId === "NBN-7" && R(8).notes.some((n) => /The ID "vera_old" in the sheet is not an HRMS ID: matched by exact name, existing ID NBN-7/.test(n)), R(8));
  ok("an unknown ID whose name matches nobody is refused and says what was tried", R(9).status === "INVALID" && /nobody_old/.test(R(9).issues[0].message) && /no existing employee matches/.test(R(9).issues[0].message), R(9));
  ok("an ID that EXISTS is used as typed, never second-guessed", R(10).employeeId === "NBN-3" && !R(10).notes.some((n) => /not an HRMS ID/.test(n)), R(10));
  ok("nothing was written by the preview", (await q(`select count(*)::int c from employee_personal_details where "userId" in ($1,$2)`, [f, r1]))[0].c === 0);
  const cm = await post("/admin/employees/update/commit", tok, { rows, mapping, confirm: true });
  ok("commit saves the matched people only", cm.s === 200 && cm.b.summary.updated >= 2, cm);
  const city = async (id) => (await q(`select city from employee_personal_details where "userId"=$1`, [id]))[0]?.city;
  ok("Faizan got his city", (await city(f)) === "Pune", await city(f));
  ok("the person found by email got theirs", (await city(e6)) === "Thane", await city(e6));
  ok("Rohit's city is stored", (await city(r1)) === "Mumbai");
  ok("the same-name, other-company and Admin people were not touched", (await q(`select count(*)::int c from employee_personal_details where "userId" in (select id from users where "employeeCode" in ('NBN-4','NBN-5','NBN-AD'))`))[0].c === 0);
  ok("nobody was created", (await q(`select count(*)::int c from users where "employeeCode" like 'NBN-%'`))[0].c === 9);
  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
