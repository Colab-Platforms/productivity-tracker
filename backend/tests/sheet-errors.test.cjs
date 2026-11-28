// The three errors from the HR sheet: HR repeating the current reporting manager, "05th October 2026", and "9:30 to 6:30".
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/sheet-errors.test.cjs
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
  const wipe = async () => { await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'SHE-%')`).catch(() => {}); await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'SHE-%')`).catch(() => {}); await q(`delete from login_events where "employeeCode" like 'SHE-%'`).catch(() => {}); await q(`delete from users where "employeeCode" like 'SHE-%'`).catch((e) => console.log("wipe", e.message.slice(0, 60))); };
  await wipe();
  let SHEOTHER = (await q(`select id from platforms where slug='she-co'`))[0]?.id;
  if (!SHEOTHER) SHEOTHER = (await q(`insert into platforms (id,name,slug,"updatedAt") values (gen_random_uuid(),'She Co','she-co',now()) returning id`))[0].id;
  let SHETHIRD = (await q(`select id from platforms where slug='she-co3'`))[0]?.id;
  if (!SHETHIRD) SHETHIRD = (await q(`insert into platforms (id,name,slug,"updatedAt") values (gen_random_uuid(),'She Co Three','she-co3',now()) returning id`))[0].id;
  const hash = await bcrypt.hash("She@12345678", 10);
  const mk = async (code, first, last, role, boss = null) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'ACTIVE',false,$8,now(),now()) returning id`, [A, code.toLowerCase() + "@she.test", hash, first, last, code, role, boss]))[0].id;
  await mk("SHE-HR", "Hana", "Hr", "HR");
  const boss = await mk("SHE-M1", "Mona", "Boss", "MANAGER");
  const other = await mk("SHE-M2", "Other", "Chief", "MANAGER");
  await mk("SHE-E1", "Eve", "One", "EMPLOYEE", boss);
  await mk("SHE-E2", "Eli", "Two", "EMPLOYEE", boss);
  const zorbo = await mk("SHE-ZA", "Zorbo", "Ahire", "ADMIN");
  await mk("SHE-Y1", "Yash", "Alpha", "MANAGER");
  await mk("SHE-Y2", "Yash", "Beta", "ADMIN");
  await mk("SHE-AD", "Adam", "Admin", "ADMIN");
  const mkIn = async (plat, code, first, last, role) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'ACTIVE',false,now(),now()) returning id`, [plat, code.toLowerCase() + "@she.test", hash, first, last, code, role]))[0].id;
  await mkIn(SHEOTHER, "SHE-Q1", "Qwerty", "Ahire", "ADMIN"); // an Admin in ANOTHER company
  await mkIn(SHEOTHER, "SHE-W1", "Wanda", "Chief", "ADMIN");
  await mkIn(SHETHIRD, "SHE-W2", "Wanda", "Other", "MANAGER");
  const grantor = await mkIn(A, "SHE-AD2", "Gina", "Grant", "ADMIN");
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [grantor]);
  const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "SHE-HR", password: "She@12345678" }) })).json()).token;
  // columns: 0 ID, 1 Primary Manager, 2 Joining Date, 3 Office Timings, 4 Working days
  const mapping = { employeeId: 0, reportsToName: 1, dateOfJoining: 2, officeTimings: 3, workingDays: 4 };
  const run = async (cells, options = {}) => (await post("/admin/employees/update/preview", tok, { rows: [{ rowNumber: 2, cells }], mapping, options: { createMissingShifts: true, ...options } })).b.rows[0];

  console.log("## 1. reporting manager");
  let r = await run(["SHE-E1", "Mona Boss", "", "", ""]);
  ok("HR repeating the CURRENT reporting manager: no error, no change", r.issues.length === 0 && r.status === "NO_CHANGE", r);
  r = await run(["SHE-E1", "Other Chief", "", "", ""]);
  ok("HR naming a DIFFERENT manager is still refused (Admin only)", r.status === "INVALID" && r.issues.some((i) => i.code === "ADMIN_ONLY_FIELD"), r);
  ok("the refusal says why", /different manager/.test(r.issues[0].message), r.issues);

  console.log("\n## 1b. a form of address after the manager's name (as an Admin, who may change reporting lines)");
  const admTok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "SHE-AD", password: "She@12345678" }) })).json()).token;
  const runA = async (cells) => (await post("/admin/employees/update/preview", admTok, { rows: [{ rowNumber: 2, cells }], mapping, options: {} })).b.rows[0];
  r = await runA(["SHE-E1", "zorbo sir", "", "", ""]);
  ok('"zorbo sir" is read as the one Admin called Zorbo, with a note', r.issues.length === 0 && r.changes.some((c) => c.field === "reportsTo" && /Zorbo Ahire/.test(c.proposed)) && r.notes.some((n) => /read as Zorbo Ahire/.test(n)), r);
  r = await runA(["SHE-E1", "Mr. Zorbo Ahire", "", "", ""]);
  ok("a title before a FULL name is dropped", r.issues.length === 0 && r.changes.some((c) => c.field === "reportsTo"), r);
  r = await runA(["SHE-E1", "yash sir", "", "", ""]);
  ok("two Managers/Admins called Yash: refused, nothing guessed", r.status === "INVALID" && r.issues.some((i) => i.code === "MANAGER_AMBIGUOUS"), r);
  r = await runA(["SHE-E1", "nobody sir", "", "", ""]);
  ok("an unknown first name is still not found", r.issues.some((i) => i.code === "MANAGER_NOT_FOUND"), r);
  r = await runA(["SHE-E1", "eli sir", "", "", ""]);
  ok("the first name of an ordinary employee is NOT accepted as a manager", r.issues.some((i) => i.code === "MANAGER_NOT_FOUND"), r);
  r = await run(["SHE-E1", "zorbo sir", "", "", ""]);
  ok("HR (not Admin) naming a different manager is still refused", r.issues.some((i) => i.code === "ADMIN_ONLY_FIELD"), r);

  console.log("\n## 1c. a manager who sits in ANOTHER company (reporting lines may cross companies)");
  const gTok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "SHE-AD2", password: "She@12345678" }) })).json()).token;
  const runG = async (cells) => (await post("/admin/employees/update/preview", gTok, { rows: [{ rowNumber: 2, cells }], mapping, options: {} })).b.rows[0];
  r = await runG(["SHE-E1", "Qwerty Ahire", "", "", ""]);
  ok("an Admin who may act on every company finds a manager in another company by full name, and the row says where", r.issues.length === 0 && r.changes.some((c) => c.field === "reportsTo" && /Qwerty Ahire/.test(c.proposed)) && r.notes.some((n) => /was found in She Co/.test(n)), r);
  r = await runG(["SHE-E1", "qwerty sir", "", "", ""]);
  ok('"qwerty sir" works across companies too, as the only Manager/Admin with that first name', r.issues.length === 0 && r.notes.some((n) => /read as Qwerty Ahire/.test(n) && /She Co/.test(n)), r);
  r = await runG(["SHE-E1", "wanda sir", "", "", ""]);
  ok("two Wandas in different companies: refused, nothing guessed", r.issues.some((i) => i.code === "MANAGER_AMBIGUOUS"), r);
  r = await runA(["SHE-E1", "Qwerty Ahire", "", "", ""]);
  ok("an Admin limited to their own company does NOT see another company's manager", r.issues.some((i) => i.code === "MANAGER_NOT_FOUND"), r);
  r = await runG(["SHE-E1", "zorbo sir", "", "", ""]);
  ok("the employee's own company is searched first", r.notes.some((n) => /read as Zorbo Ahire/.test(n)) && !r.notes.some((n) => /another company/.test(n)), r);

  console.log("\n## 2. dates written in words");
  for (const [txt, iso] of [["05th October 2026", "2026-10-05"], ["5 Oct 2026", "2026-10-05"], ["October 5, 2026", "2026-10-05"], ["1st July 2024", "2024-07-01"], ["22nd Nov 2025", "2025-11-22"], ["3rd March 2025", "2025-03-03"], ["05-Oct-2026", "2026-10-05"]]) {
    r = await run(["SHE-E2", "", txt, "", ""]);
    const c = r.changes.find((x) => x.field === "dateOfJoining");
    const dd = iso.split("-").reverse().join("-");
    ok(`"${txt}" is read as ${dd}`, !!c && c.proposed === dd && r.issues.length === 0, r);
  }
  r = await run(["SHE-E2", "", "31st February 2026", "", ""]);
  ok("an impossible day is still refused", r.issues.some((i) => i.code === "BAD_DATE"), r.issues);
  r = await run(["SHE-E2", "", "05th Octobre 2026", "", ""]);
  ok("an unknown month word is refused", r.issues.some((i) => i.code === "BAD_DATE"), r.issues);
  r = await run(["SHE-E2", "", "14-01-2025", "", ""]);
  ok("the old numeric format still works", r.changes.some((x) => x.field === "dateOfJoining" && x.proposed === "14-01-2025"), r);

  console.log("\n## 3. office timings 9:30 to 6:30 are a morning-to-evening shift (no tick); the separate shift columns still need it");
  r = await run(["SHE-E2", "", "", "9:30 to 6:30", "Mon to Sat"]);
  ok("Office timings 9:30 to 6:30 read as 09:30-18:30 with NO tick", r.issues.length === 0 && r.changes.some((x) => x.field === "shift" && /09:30-18:30/.test(x.proposed)), r);
  ok("and the row says it was read as morning to evening", r.notes.some((n) => /morning to evening/.test(n)), r.notes);
  const pv = (await post("/admin/employees/update/preview", tok, { rows: [{ rowNumber: 2, cells: ["SHE-E2", "", "", "9:30 to 6:30", "Mon to Sat"] }], mapping, options: { createMissingShifts: true } })).b;
  ok("so the preview does not ask for the PM tick", (pv.needsConfirmation.pmEndTimes ?? 0) === 0, pv.needsConfirmation);
  r = await run(["SHE-E2", "", "", "morning 9:30 to evening 6:30", "Mon to Sat"]);
  ok("\"morning 9:30 to evening 6:30\" works too", r.issues.length === 0 && r.changes.some((x) => x.field === "shift" && /09:30-18:30/.test(x.proposed)), r);
  r = await run(["SHE-E2", "", "", "9:30 AM to 6:30 PM", "Mon to Sat"]);
  ok("AM/PM written out needs no tick", r.issues.length === 0 && r.changes.some((x) => x.field === "shift"), r);
  r = await run(["SHE-E2", "", "", "10:00 to 6:30", "Mon to Sat"]);
  ok("any day range with an earlier end is read the same way (10:00 to 6:30 = 10:00-18:30)", r.changes.some((x) => x.field === "shift" && /10:00-18:30/.test(x.proposed)), r);
  r = await run(["SHE-E2", "", "", "22:00 to 06:00", "Mon to Sat"]);
  ok("a night shift written in 24-hour time is NOT turned into a day shift", r.status === "INVALID" && r.issues.some((i) => i.code === "END_BEFORE_START"), r);
  const sep = async (opts) => (await post("/admin/employees/update/preview", tok, { rows: [{ rowNumber: 2, cells: ["SHE-E2", "9:30", "6:30", "Mon to Sat"] }], mapping: { employeeId: 0, shiftStart: 1, shiftEnd: 2, workingDays: 3 }, options: { createMissingShifts: true, ...opts } })).b.rows[0];
  r = await sep({});
  ok("the separate Shift start / Shift end columns STILL need the PM tick", r.status === "INVALID" && r.issues.some((i) => i.code === "END_BEFORE_START"), r);
  r = await sep({ pmEndTimes: true });
  ok("...and work with it", r.issues.length === 0 && r.changes.some((x) => x.field === "shift" && /09:30-18:30/.test(x.proposed)), r);

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
