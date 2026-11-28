// Employee personal details over real HTTP against the throwaway test backend (5012) and DB. Runs BEFORE the migration (nothing breaks, 503 on save), applies the
// migration SQL itself, then checks reads, writes, permissions, validation, no data loss and the audit log. Invented values only.
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/personal-details.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const fs = require("node:fs");
const path = require("node:path");
require("./_guard.cjs");
const API = process.env.TEST_API || "http://localhost:5012/api";
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); return { s: r.status, b: await r.json().catch(() => ({})) }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Pdt@12345678";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id, B = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  await q(`drop table if exists employee_personal_details`);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'PDT-%')`;
    await q(`delete from company_access where "userId" in ${ids}`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from login_events where "employeeCode" like 'PDT-%'`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'PDT-%'`).catch((e) => console.log("cleanup:", e.message.slice(0, 80)));
  };
  await wipe();
  const mk = async (code, role, plat, boss = null) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Pdt',$4,$4,$5,'ACTIVE',false,true,'ACTIVE',$6,now(),now()) returning id`, [plat, code.toLowerCase() + "@pdt.test", hash, code, role, boss]))[0].id;
  const adm = await mk("PDT-AD", "ADMIN", A); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [adm]);
  const hrA = await mk("PDT-HRA", "HR", A), hrB = await mk("PDT-HRB", "HR", B), mgr = await mk("PDT-M", "MANAGER", A);
  const e1 = await mk("PDT-E1", "EMPLOYEE", A, mgr), e2 = await mk("PDT-E2", "EMPLOYEE", A, mgr), eb = await mk("PDT-EB", "EMPLOYEE", B);
  const T = {}; for (const c of ["AD", "HRA", "HRB", "M", "E1", "E2"]) T[c] = (await call("POST", "/auth/login", null, { email: "PDT-" + c, password: PW })).b.token;
  const user = async (id) => JSON.stringify((await q(`select "firstName","lastName",email,phone,designation,"dateOfJoining","reportsToId","shiftId",role,status,"employeeCode" from users where id=$1`, [id]))[0]);
  const userBefore = await user(e1), othersBefore = await user(e2);

  console.log("\n## BEFORE the migration: nothing breaks, nothing can be saved");
  const pre = await call("GET", "/personal-details/me", T.E1);
  ok("reading says 'not ready' instead of failing", pre.s === 200 && pre.b.ready === false && pre.b.entered === false && pre.b.canEdit === false, pre);
  ok("saving answers 503 with a plain message", await (async () => { const r = await call("PUT", `/personal-details/${e1}`, T.HRA, { city: "Pune" }); return r.s === 503 && /not set up/.test(r.b.error); })());
  ok("the rest of the profile still loads", (await call("GET", "/auth/me/profile", T.E1)).s === 200);

  console.log("\n## apply the migration");
  await q(fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261128100000_employee_personal_details", "migration.sql"), "utf8"));
  await sleep(16000); // the server re-checks a missing table every 15 s

  console.log("\n## who can read");
  const empty = await call("GET", `/personal-details/${e1}`, T.HRA);
  ok("HR of the company reads a person with nothing entered yet: empty, ready, can edit", empty.s === 200 && empty.b.ready && empty.b.canEdit && empty.b.entered === false && Object.values(empty.b.values).every((v) => v === null), empty.b);
  ok("the person reads their own", (await call("GET", "/personal-details/me", T.E1)).b.ready === true && (await call("GET", `/personal-details/${e1}`, T.E1)).s === 200);
  ok("the person cannot edit their own (canEdit false)", (await call("GET", "/personal-details/me", T.E1)).b.canEdit === false);
  ok("a colleague cannot read someone else's (404)", (await call("GET", `/personal-details/${e1}`, T.E2)).s === 404);
  ok("a manager cannot, even for their own team (404)", (await call("GET", `/personal-details/${e1}`, T.M)).s === 404);
  ok("HR of ANOTHER company cannot (404)", (await call("GET", `/personal-details/${e1}`, T.HRB)).s === 404);
  ok("an all-companies Admin can", (await call("GET", `/personal-details/${e1}`, T.AD)).s === 200 && (await call("GET", `/personal-details/${eb}`, T.AD)).s === 200);
  ok("no token = 401, bad id = 404", (await call("GET", "/personal-details/me", null)).s === 401 && (await call("GET", "/personal-details/not-a-uuid", T.HRA)).s === 404);

  console.log("\n## who can write");
  const body = { gender: "Female", dateOfBirth: "1999-05-30T00:00:00.000Z", maritalStatus: "Unmarried", secondaryPhoneCode: 91, secondaryPhone: 9876500001, addressLine1: "B/12, Test Society, Sample Road, Opp. Test School, Near Sample Market", addressLine2: "Sample East", city: "Testville", state: "Sampleshire", country: "India", employeeStatusType: "Full time", reportingOffice: "Sample Office", grade: "G3", vertical: "Operations" };
  for (const [who, tok, label] of [["the person", T.E1, "employee"], ["a colleague", T.E2, "colleague"], ["a manager", T.M, "manager"], ["HR of another company", T.HRB, "other HR"]]) ok(`${who} cannot save (404)`, (await call("PUT", `/personal-details/${e1}`, tok, body)).s === 404, label);
  ok("nothing was written by those refusals", (await q(`select count(*)::int n from employee_personal_details`))[0].n === 0);
  const saved = await call("PUT", `/personal-details/${e1}`, T.HRA, body);
  ok("HR of the company saves all fourteen fields", saved.s === 200 && saved.b.changed.length === 14 && saved.b.unchanged === false, saved);

  console.log("\n## no data lost, nothing mis-mapped");
  const back = (await call("GET", `/personal-details/${e1}`, T.HRA)).b.values;
  ok("every value comes back exactly as stored (words as codes, long address whole)", back.gender === "FEMALE" && back.dateOfBirth === "1999-05-30" && back.maritalStatus === "SINGLE" && back.secondaryPhoneCode === "91" && back.secondaryPhone === "9876500001" && back.addressLine1 === body.addressLine1 && back.addressLine2 === "Sample East" && back.city === "Testville" && back.state === "Sampleshire" && back.country === "India" && back.employeeStatusType === "FULL_TIME" && back.reportingOffice === "Sample Office" && back.grade === "G3" && back.vertical === "Operations", back);
  ok("the person sees the same record on their own screen", JSON.stringify((await call("GET", "/personal-details/me", T.E1)).b.values) === JSON.stringify(back));
  ok("a date of birth is stored as the exact day (no time-zone shift)", (await q(`select "dateOfBirth"::text d from employee_personal_details where "userId"=$1`, [e1]))[0].d === "1999-05-30");
  ok("exactly one row for the person; nobody else got one", (await q(`select count(*)::int n from employee_personal_details`))[0].n === 1 && (await q(`select count(*)::int n from employee_personal_details where "userId"=$1`, [e2]))[0].n === 0);
  ok("the person's account fields (name, email, phone, role, manager...) are untouched", (await user(e1)) === userBefore);
  ok("another employee in the same company is untouched", (await user(e2)) === othersBefore);

  console.log("\n## blank leaves it, a partial save keeps the rest, null clears on purpose");
  const part = await call("PUT", `/personal-details/${e1}`, T.HRA, { city: "Newtown", state: "", country: "   ", grade: undefined });
  const afterPart = (await call("GET", `/personal-details/${e1}`, T.HRA)).b.values;
  ok("only the city changed; the blank state and country kept their values", part.b.changed.join() === "City" && afterPart.city === "Newtown" && afterPart.state === "Sampleshire" && afterPart.country === "India" && afterPart.addressLine1 === body.addressLine1);
  ok("saving the same values again changes nothing", (await call("PUT", `/personal-details/${e1}`, T.HRA, { city: "Newtown", gender: "female" })).b.unchanged === true);
  ok("an all-blank save is refused, not silently accepted", (await call("PUT", `/personal-details/${e1}`, T.HRA, { city: "", state: "  " })).s === 400);
  const cleared = await call("PUT", `/personal-details/${e1}`, T.HRA, { grade: null });
  ok("null clears just that field", cleared.s === 200 && (await call("GET", `/personal-details/${e1}`, T.HRA)).b.values.grade === null && (await call("GET", `/personal-details/${e1}`, T.HRA)).b.values.vertical === "Operations");

  console.log("\n## validation: nothing is guessed, nothing is saved on error");
  const before = JSON.stringify((await call("GET", `/personal-details/${e1}`, T.HRA)).b.values);
  const bad = async (o, label) => { const r = await call("PUT", `/personal-details/${e1}`, T.HRA, o); ok(label, r.s === 400 && r.b.code === "INVALID_DETAILS" && r.b.fields.length >= 1 && typeof r.b.error === "string", r); };
  await bad({ gender: "boy" }, "an unknown gender is refused with a plain message");
  await bad({ dateOfBirth: "2000-02-30" }, "an impossible date of birth is refused");
  await bad({ dateOfBirth: "2031-01-01" }, "a future date of birth is refused");
  await bad({ dateOfBirth: "1st July 1999" }, "a date written in words is refused, not guessed");
  await bad({ maritalStatus: "complicated" }, "an unknown marital status is refused");
  await bad({ secondaryPhone: "12ab" }, "a bad phone number is refused");
  await bad({ secondaryPhoneCode: "IN" }, "a bad phone code is refused");
  await bad({ employeeStatusType: "Contractor" }, "an unknown employee status is refused");
  await bad({ addressLine1: "X".repeat(201) }, "an over-long address line is refused");
  await bad({ city: "<b>x</b>" }, "markup in a text field is refused");
  await bad({ gender: "male", city: "Fine", dateOfBirth: "bad" }, "one bad field stops the WHOLE save (good fields are not half-saved)");
  ok("after all those, the stored record is exactly as before", JSON.stringify((await call("GET", `/personal-details/${e1}`, T.HRA)).b.values) === before);
  ok("the database itself refuses a bad code (its own check)", await (async () => { try { await q(`update employee_personal_details set gender='X' where "userId"=$1`, [e1]); return false; } catch { return true; } })());
  ok("unknown fields (salary, role, userId) in the request are ignored, never stored", await (async () => { const r = await call("PUT", `/personal-details/${e1}`, T.HRA, { city: "Newtown", salary: 999999, role: "ADMIN", userId: e2 }); return r.s === 200 && (await user(e1)) === userBefore && (await q(`select count(*)::int n from employee_personal_details where "userId"=$1`, [e2]))[0].n === 0; })());

  console.log("\n## audit: which fields changed, never the sensitive values");
  await sleep(1200);
  const au = await q(`select summary, before, after, "targetUserId"::text t, "actorId"::text a from audit_logs where module='Employees' and path like '/api/personal-details/%' and "targetUserId"=$1 order by "createdAt"`, [e1]);
  const first = au[0];
  ok("each save is an audit line naming the person and the HR who did it", au.length >= 3 && first.t === e1 && first.a === hrA && /Updated personal details of Pdt PDT-E1/.test(first.summary), au.map((x) => x.summary));
  const all = JSON.stringify(au);
  ok("the line lists the field NAMES that changed", /Date of birth/.test(first.summary) && /Address line 1/.test(first.summary));
  ok("but never the address, the phone, the date of birth, gender or marital status values", !/Test Society|9876500001|1999-05-30|Testville|Sampleshire|FEMALE|SINGLE|Female/.test(all), all.slice(0, 200));
  ok("non-sensitive work labels (grade, vertical) may appear as before/after", /Operations/.test(JSON.stringify(first.after)));

  await wipe(); await q(`drop table if exists employee_personal_details`); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
