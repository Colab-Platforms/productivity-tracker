// The HR details sheet layout (33 columns) through Update Employees, over real HTTP against the throwaway backend (5012) and DB. Synthetic people only.
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/import-sheet-layout.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const fs = require("node:fs"), path = require("node:path");
require("./_guard.cjs");
const API = process.env.TEST_API || "http://localhost:5012/api";
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch { j = txt; } return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Pdt@12345678";
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  // start from a clean personal table so the edited migration is what is tested
  await q(`drop table if exists employee_personal_details`);
  await q(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261128100000_employee_personal_details", "migration.sql"), "utf8"));
  await new Promise((r) => setTimeout(r, 16000));
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const ids = `(select id from users where "employeeCode" like 'ISL-%')`;
  const wipe = async () => {
    await q(`delete from employee_personal_details where "userId" in ${ids}`).catch(() => {});
    await q(`delete from reporting_manager_links where "userId" in ${ids}`).catch(() => {});
    await q(`delete from employee_profiles where "userId" in ${ids}`).catch(() => {});
    await q(`delete from company_access where "userId" in ${ids}`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from login_events where "employeeCode" like 'ISL-%'`).catch(() => {});
    await q(`delete from teams where name like 'ISL-%'`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'ISL-%'`).catch((e) => console.log("wipe:", e.message.slice(0, 80)));
  };
  await wipe();
  const mk = async (code, role, first, last, boss = null) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'ACTIVE',false,$8,now(),now()) returning id`, [A, code.toLowerCase() + "@isl.test", hash, first, last, code, role, boss]))[0].id;
  const adm = await mk("ISL-AD", "ADMIN", "Ada", "Admin");
  const hr = await mk("ISL-HR", "HR", "Hana", "Hr");
  const m1 = await mk("ISL-M1", "MANAGER", "Mona", "Boss");
  const e1 = await mk("ISL-E1", "EMPLOYEE", "Eve", "One", m1);
  const e2 = await mk("ISL-E2", "EMPLOYEE", "Eli", "Two");
  await q(`insert into teams (id,"platformId",name,"isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'ISL-Team',true,now(),now())`, [A]);
  const T = {}; for (const c of ["AD", "HR"]) T[c] = (await call("POST", "/auth/login", null, { email: "ISL-" + c, password: PW })).b.token;

  // the exact headings of the HR details sheet
  const H = ["Emp Id", "Email ID", "Full Name", "Phone Code", "Mobile No.", "Gender", "DOB (yyyy-mm-dd)", "Marital Status", "Secondary Phone Code", "Secondary Contact Number", "Address Line 1", "AddressLine2", "State", "City", "Country", "Designation", "Department", "Employee Type", "Employee Status (FullTime/part Time)", "Office Timings", "Joining Date", "Reporting Office", "Entity", "Primary Manager", "Team Name", "Secondary Manager", "Grade", "Vertical", "Extra Field 1", "Extra Field 2", "Extra Field 3", "Extra Field 4", "Extra Field 5"];
  const row = (o) => H.map((h) => o[h] ?? "");
  const r1 = row({ "Emp Id": "ISL-E1", "Email ID": "eve.one@isl.test", "Full Name": "Eve One", "Phone Code": "91", "Mobile No.": "9000000001", Gender: "Female", "DOB (yyyy-mm-dd)": "1994-03-02", "Marital Status": "Married", "Secondary Phone Code": "91", "Secondary Contact Number": "9000000002", "Address Line 1": "1 Test Road", AddressLine2: "Block B", State: "Teststate", City: "Testcity", Country: "India", Department: "Sales Ops", "Employee Type": "Permanent", "Employee Status (FullTime/part Time)": "Full Time", "Reporting Office": "Test HQ", Entity: "Avatar", "Primary Manager": "Mona Boss", "Team Name": "ISL-Team", "Secondary Manager": "Ada Admin (ISL-AD)", Grade: "G1", Vertical: "Retail", "Extra Field 1": "alpha", "Extra Field 5": "omega" });
  const csv = Buffer.from([H, r1].map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n")).toString("base64");

  console.log("## template and heading recognition");
  const tpl = await fetch(API + "/admin/employees/template", { headers: { authorization: "Bearer " + T.HR } });
  const tplText = await tpl.text();
  const need = ["Company", "Full name", "Employee ID", "Work email", "Phone code", "Gender", "Date of birth (YYYY-MM-DD)", "Marital status", "Secondary phone code", "Secondary contact number", "Address line 1", "Address line 2", "State", "City", "Country", "Department", "Employee type", "Employee status (Full time / Part time)", "Office timings", "Reporting office", "Secondary manager", "Grade", "Vertical", "Extra field 1", "Extra field 5", "Notes", "Shift start", "Working days"];
  ok("template downloads with every column (old and new)", tpl.status === 200 && need.every((h) => tplText.split("\n")[0].includes(h)), tplText.split("\n")[0]);
  const parsed = await call("POST", "/admin/employees/parse", T.HR, { fileName: "sheet.csv", contentBase64: csv });
  ok("parse accepts the sheet", parsed.s === 200, parsed);
  const sm = parsed.b.suggestedMapping || {};
  const idx = (h) => H.indexOf(h);
  ok("all 33 headings are recognised", sm.employeeId === idx("Emp Id") && sm.email === idx("Email ID") && sm.fullName === idx("Full Name") && sm.phoneCode === idx("Phone Code") && sm.mobile === idx("Mobile No.") && sm.gender === idx("Gender") && sm.dateOfBirth === idx("DOB (yyyy-mm-dd)") && sm.maritalStatus === idx("Marital Status") && sm.secondaryPhoneCode === idx("Secondary Phone Code") && sm.secondaryPhone === idx("Secondary Contact Number") && sm.addressLine1 === idx("Address Line 1") && sm.addressLine2 === idx("AddressLine2") && sm.state === idx("State") && sm.city === idx("City") && sm.country === idx("Country") && sm.designation === idx("Designation") && sm.department === idx("Department") && sm.employmentType === idx("Employee Type") && sm.employeeStatusType === idx("Employee Status (FullTime/part Time)") && sm.officeTimings === idx("Office Timings") && sm.dateOfJoining === idx("Joining Date") && sm.reportingOffice === idx("Reporting Office") && sm.company === idx("Entity") && sm.reportsToName === idx("Primary Manager") && sm.team === idx("Team Name") && sm.secondaryManager === idx("Secondary Manager") && sm.grade === idx("Grade") && sm.vertical === idx("Vertical") && sm.extraField1 === idx("Extra Field 1") && sm.extraField5 === idx("Extra Field 5"), sm);
  ok("Department is NOT the team when a Team Name column exists", sm.team === idx("Team Name") && sm.department === idx("Department"));

  const mapping = sm;
  const body = (rows, extra = {}) => ({ rows: rows.map((cells, i) => ({ rowNumber: i + 3, cells })), mapping, ...extra });

  console.log("\n## preview (writes nothing)");
  const pv = await call("POST", "/admin/employees/update/preview", T.AD, body([r1]));
  ok("preview 200", pv.s === 200, pv);
  const f = (pv.b.rows?.[0]?.changes || []).map((c) => c.field);
  ok("personal, type and secondary manager are proposed", ["gender", "dateOfBirth", "addressLine1", "city", "department", "extraField1", "extraField5", "phoneCode", "employmentType", "secondaryManager", "grade"].every((x) => f.includes(x)), f);
  ok("nothing stored yet", (await q(`select count(*)::int c from employee_personal_details where "userId"=$1`, [e1]))[0].c === 0 && (await q(`select count(*)::int c from reporting_manager_links where "userId"=$1`, [e1]))[0].c === 0);
  { const hrRow = (await call("POST", "/admin/employees/update/preview", T.HR, body([r1]))).b.rows[0]; console.log("   HR row issues:", JSON.stringify(hrRow.issues).slice(0, 400)); ok("HR: the secondary manager and team parts are skipped with a note, the rest of the row still saves", hrRow.issues.length === 0 && hrRow.notes.some((n) => /Secondary manager was NOT changed: only an Admin/.test(n)) && !hrRow.changes.some((c) => c.field === "secondaryManager") && hrRow.changes.some((c) => c.field === "gender"), hrRow); }

  console.log("\n## commit");
  const cm = await call("POST", "/admin/employees/update/commit", T.AD, { ...body([r1]), confirm: true });
  ok("commit 200", cm.s === 200, cm);
  const pd = (await q(`select * from employee_personal_details where "userId"=$1`, [e1]))[0];
  ok("every personal field is stored", pd && pd.gender === "FEMALE" && pd.city === "Testcity" && pd.state === "Teststate" && pd.country === "India" && pd.addressLine2 === "Block B" && pd.department === "Sales Ops" && pd.phoneCode === "91" && pd.secondaryPhone === "9000000002" && pd.reportingOffice === "Test HQ" && pd.grade === "G1" && pd.vertical === "Retail" && pd.employeeStatusType === "FULL_TIME" && pd.extraField1 === "alpha" && pd.extraField5 === "omega" && pd.extraField2 === null, pd);
  ok("employee type stored in the existing profile table", (await q(`select "employmentType"::text t from employee_profiles where "userId"=$1`, [e1]))[0]?.t === "PERMANENT");
  ok("secondary manager stored as an additional manager", (await q(`select "managerId" m from reporting_manager_links where "userId"=$1`, [e1]))[0]?.m === adm);
  ok("main reporting manager untouched", (await q(`select "reportsToId" r from users where id=$1`, [e1]))[0].r === m1);
  ok("team set from Team Name", (await q(`select count(*)::int c from team_members tm join teams t on t.id=tm."teamId" where tm."userId"=$1 and t.name='ISL-Team'`, [e1]))[0].c === 1);
  ok("name never changed", (await q(`select "firstName" f from users where id=$1`, [e1]))[0].f === "Eve");
  ok("the other person is untouched", (await q(`select count(*)::int c from employee_personal_details where "userId"=$1`, [e2]))[0].c === 0);

  console.log("\n## repeat, blanks, conflicts, bad values");
  const again = await call("POST", "/admin/employees/update/preview", T.AD, body([r1]));
  ok("same sheet again changes nothing new (only the differing work email is a conflict, left alone)", again.b.rows[0].changes.length === 1 && again.b.rows[0].changes[0].field === "email" && again.b.rows[0].changes[0].kind === "conflict" && !again.b.rows[0].changes[0].applied, again.b.rows[0]);
  const blanks = row({ "Emp Id": "ISL-E1" });
  ok("a row of blanks erases nothing", (await call("POST", "/admin/employees/update/preview", T.AD, body([blanks]))).b.rows[0].status === "NO_CHANGE");
  const conf = row({ "Emp Id": "ISL-E1", City: "Othercity", "Extra Field 1": "beta" });
  const cp = (await call("POST", "/admin/employees/update/preview", T.AD, body([conf]))).b.rows[0];
  ok("different stored values are conflicts, not applied", cp.changes.length === 2 && cp.changes.every((c) => c.kind === "conflict" && !c.applied), cp.changes);
  const bad = row({ "Emp Id": "ISL-E2", "Employee Type": "Wizard", "Secondary Manager": "Nobody Here", "Office Timings": "whenever", Gender: "Robot" });
  const bp = (await call("POST", "/admin/employees/update/preview", T.AD, body([bad]))).b.rows[0];
  const codes = bp.issues.map((i) => i.code).join();
  ok("bad type, unknown secondary manager, bad timings and bad gender are reported", bp.status === "INVALID" && /BAD_EMPLOYEE_TYPE/.test(codes) && /SECONDARY_NOT_FOUND/.test(codes) && /BAD_OFFICE_TIMINGS/.test(codes) && /BAD_GENDER/.test(codes), codes);

  console.log("\n## office timings");
  const tm = row({ "Emp Id": "ISL-E2", "Office Timings": "10:00 AM - 7:00 PM" });
  const tp = (await call("POST", "/admin/employees/update/preview", T.AD, body([tm]))).b.rows[0];
  ok("timings with no shift and no working days use Monday to Saturday and say so", tp.notes.some((n) => /Monday to Saturday/.test(n)), tp);
  const tm2 = row({ "Emp Id": "ISL-E2", "Office Timings": "10:00 AM - 7:00 PM" }); tm2[0] = "ISL-E2";
  const withDays = { ...mapping, workingDays: H.length };
  const tp2 = (await call("POST", "/admin/employees/update/preview", T.AD, { rows: [{ rowNumber: 3, cells: [...tm2, "Mon to Fri"].slice(0, H.length + 1) }], mapping: withDays, options: { createMissingShifts: true } })).b.rows[0];
  ok("timings plus Working days become a shift", tp2.changes.some((c) => c.field === "shift" && /10:00-19:00/.test(c.proposed)), tp2);

  console.log("\n## duplicates and strangers");
  const dup = (await call("POST", "/admin/employees/update/preview", T.AD, body([r1, r1]))).b.rows;
  ok("the same Employee ID twice is refused for both rows", dup.every((x) => x.issues.some((i) => i.code === "DUPLICATE_IN_FILE")));
  ok("an unknown Employee ID creates nobody", (await call("POST", "/admin/employees/update/preview", T.AD, body([row({ "Emp Id": "ISL-NOPE" })]))).b.rows[0].status === "INVALID" && (await q(`select count(*)::int c from users where "employeeCode"='ISL-NOPE'`))[0].c === 0);

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
