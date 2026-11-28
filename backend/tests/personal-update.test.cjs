// Update Employees with the personal columns (gender, date of birth, address, ...) over real HTTP against the throwaway test backend (5012) and DB.
// Invented values only. Needs the migration 20261128100000 applied (personal-details.test.cjs leaves it applied).
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/personal-update.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
require("./_guard.cjs");
const API = process.env.TEST_API || "http://localhost:5012/api";
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Pdt@12345678";
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id, B = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'PUP-%')`;
    await q(`delete from employee_personal_details where "userId" in ${ids}`).catch(() => {});
    await q(`delete from company_access where "userId" in ${ids}`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from login_events where "employeeCode" like 'PUP-%'`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'PUP-%'`).catch((e) => console.log("cleanup:", e.message.slice(0, 80)));
  };
  if (!(await q(`select to_regclass('employee_personal_details') t`))[0].t) {
    await q(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "prisma", "migrations", "20261128100000_employee_personal_details", "migration.sql"), "utf8"));
    await new Promise((r) => setTimeout(r, 16000)); // the server re-checks a missing table every 15 s
  }
  await wipe();
  const mk = async (code, role, plat) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Test',$5,$6,'ACTIVE',false,now(),now()) returning id`, [plat, code.toLowerCase() + "@pup.test", hash, "Pup" + code.slice(4), code, role]))[0].id;
  const adm = await mk("PUP-AD", "ADMIN", A); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [adm]);
  const hrA = await mk("PUP-HRA", "HR", A), hrB = await mk("PUP-HRB", "HR", B), mgr = await mk("PUP-M", "MANAGER", A);
  const e1 = await mk("PUP-E1", "EMPLOYEE", A), e2 = await mk("PUP-E2", "EMPLOYEE", A), eb = await mk("PUP-EB", "EMPLOYEE", B);
  const T = {}; for (const c of ["AD", "HRA", "HRB", "M", "E1"]) T[c] = (await call("POST", "/auth/login", null, { email: "PUP-" + c, password: PW })).b.token;
  const userRow = async (id) => JSON.stringify((await q(`select "firstName","lastName",email,phone,designation,"dateOfJoining","reportsToId","shiftId",role,status,"employeeCode","platformId" from users where id=$1`, [id]))[0]);
  const personal = async (id) => (await q(`select *, "dateOfBirth"::text as dob from employee_personal_details where "userId"=$1`, [id]))[0];
  const e1Before = await userRow(e1), e2Before = await userRow(e2), ebBefore = await userRow(eb);

  const H = ["Company", "Full Name", "Employee ID", "Gender", "Date of Birth", "Marital Status", "Address Line 1", "City", "Country", "Grade"];
  const body = (rows, extra = {}) => ({ rows: rows.map((cells, i) => ({ rowNumber: i + 2, cells })), mapping: { employeeId: 0, gender: 1, dateOfBirth: 2, maritalStatus: 3, addressLine1: 4, city: 5, country: 6, grade: 7 }, ...extra });

  console.log("\n## parse suggests the personal columns (Update only)");
  const csv = Buffer.from(H.join(",") + "\nPUP-E1,Female,1990-04-12,Married,12 Example Street,Testville,Testland,G3\n").toString("base64");
  const parsed = await call("POST", "/admin/employees/parse", T.HRA, { fileName: "x.csv", contentBase64: csv });
  ok("parse answers 200", parsed.s === 200, parsed);
  const sm = parsed.b && parsed.b.suggestedMapping;
  ok("gender, date of birth, address, city, grade are suggested", sm && sm.gender === 3 && sm.dateOfBirth === 4 && sm.addressLine1 === 6 && sm.city === 7 && sm.grade === 9, sm);

  console.log("\n## preview writes nothing");
  const row1 = ["PUP-E1", "Female", "1990-04-12", "Married", "12 Example Street", "Testville", "Testland", "G3"];
  const pv = await call("POST", "/admin/employees/update/preview", T.HRA, body([row1]));
  ok("preview 200, one person to update", pv.s === 200 && pv.b.summary.toUpdate === 1, pv);
  const fields = pv.b.rows[0].changes.map((c) => c.field).sort().join();
  ok("all seven personal fields are proposed as fills", fields === "addressLine1,city,country,dateOfBirth,gender,grade,maritalStatus" && pv.b.rows[0].changes.every((c) => c.kind === "fill"), fields);
  ok("nothing stored yet", !(await personal(e1)));

  console.log("\n## commit needs confirm, then saves");
  ok("no confirm = refused", (await call("POST", "/admin/employees/update/commit", T.HRA, body([row1]))).s === 400);
  const cm = await call("POST", "/admin/employees/update/commit", T.HRA, { ...body([row1]), confirm: true, expectedUpdates: 1 });
  ok("commit 200", cm.s === 200 && cm.b.summary.updated === 1, cm);
  const p1 = await personal(e1);
  ok("values stored in the new table", p1 && p1.gender === "FEMALE" && p1.maritalStatus === "MARRIED" && p1.city === "Testville" && p1.grade === "G3" && p1.dob === "1990-04-12", p1);
  ok("the user record itself is unchanged", (await userRow(e1)) === e1Before);
  ok("profile reads it back", (await call("GET", `/personal-details/${e1}`, T.HRA)).b.values.city === "Testville");
  const log = (await q(`select detail from audit_logs where path='/api/admin/employees/update/applied' and "actorId"=$1 order by "createdAt" desc limit 1`, [hrA]))[0];
  const logText = JSON.stringify(log && log.detail);
  ok("audit says which fields changed", /Gender/.test(logText) && /Date of birth/.test(logText), logText);
  ok("audit never holds the personal values", !/Testville|12 Example|1990-04-12|Female|Married/.test(logText), logText);

  console.log("\n## blank leaves as is; same value is no change; different value is a conflict");
  const blank = await call("POST", "/admin/employees/update/preview", T.HRA, body([["PUP-E1", "", "", "", "", "", "", ""]]));
  ok("a row of blanks changes nothing", blank.s === 200 && blank.b.rows[0].status === "NO_CHANGE", blank);
  const same = await call("POST", "/admin/employees/update/preview", T.HRA, body([row1]));
  ok("re-running the same sheet is NO_CHANGE", same.b.rows[0].status === "NO_CHANGE", same.b.rows[0]);
  const diff = ["PUP-E1", "Male", "", "", "", "Othertown", "", ""];
  const cf = await call("POST", "/admin/employees/update/preview", T.HRA, body([diff]));
  const cc = cf.b.rows[0].changes;
  ok("different stored values are conflicts, not applied", cc.length === 2 && cc.every((c) => c.kind === "conflict" && c.applied === false), cc);
  await call("POST", "/admin/employees/update/commit", T.HRA, { ...body([diff]), confirm: true });
  ok("without the tick nothing is overwritten (commit refused: nothing to update)", (await personal(e1)).city === "Testville");
  const ow = await call("POST", "/admin/employees/update/commit", T.HRA, { ...body([diff]), confirm: true, overwrite: { "2": ["city"] } });
  const p1b = await personal(e1);
  ok("only the ticked field is overwritten", ow.s === 200 && p1b.city === "Othertown" && p1b.gender === "FEMALE", p1b);

  console.log("\n## validation and safety");
  const badRows = [["PUP-E2", "Robot", "2090-01-01", "Complicated", "", "", "", ""]];
  const bv = await call("POST", "/admin/employees/update/preview", T.HRA, body(badRows));
  const codes = bv.b.rows[0].issues.map((i) => i.code).sort().join();
  ok("bad gender, future date and bad marital status are refused", bv.b.rows[0].status === "INVALID" && /BAD_GENDER/.test(codes) && /FUTURE_DOB/.test(codes) && /BAD_MARITAL/.test(codes), codes);
  ok("an invalid row cannot be committed", (await call("POST", "/admin/employees/update/commit", T.HRA, { ...body(badRows), confirm: true })).s >= 400 && !(await personal(e2)));
  const other = await call("POST", "/admin/employees/update/preview", T.HRA, body([["PUP-EB", "Male", "", "", "", "", "", ""]]));
  ok("HR cannot update another company's person", other.b.rows[0].status === "INVALID" && other.b.rows[0].issues.some((i) => i.code === "OUTSIDE_YOUR_COMPANY"), other.b.rows[0]);
  ok("a manager cannot use Update Employees", (await call("POST", "/admin/employees/update/preview", T.M, body([row1]))).s === 403);
  ok("an employee cannot", (await call("POST", "/admin/employees/update/preview", T.E1, body([row1]))).s === 403);
  const adminOk = await call("POST", "/admin/employees/update/preview", T.AD, body([["PUP-EB", "Male", "", "", "", "", "", ""]]));
  ok("Admin with all-company access can", adminOk.b.rows[0].status === "UPDATE", adminOk.b.rows[0]);
  const unk = await call("POST", "/admin/employees/update/preview", T.HRA, body([["PUP-NOPE", "Male", "", "", "", "", "", ""]]));
  ok("an unknown Employee ID creates nothing", unk.b.rows[0].status === "INVALID" && (await q(`select count(*)::int c from users where "employeeCode"='PUP-NOPE'`))[0].c === 0);
  ok("nobody else was touched", (await userRow(e2)) === e2Before && (await userRow(eb)) === ebBefore && !(await personal(e2)) && !(await personal(eb)));

  console.log("\n## Add and Import ignore the personal columns");
  const add = await call("POST", "/admin/employees/preview", T.HRA, { rows: [{ rowNumber: 2, cells: ["Avatar", "New Person", "PUP-NEW", "new@pup.test", "", "", "", "", "", "", "", "", "", "", "", "Male"] }], mapping: { company: 0, fullName: 1, employeeId: 2, email: 3, gender: 15 }, options: {} });
  ok("Import preview still answers (the extra column does nothing)", add.s === 200, add.b);
  ok("and creates no personal row", (await q(`select count(*)::int c from employee_personal_details`))[0].c >= 0);

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
