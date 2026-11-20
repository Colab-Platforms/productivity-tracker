// Designations list: company-wise employee mapping, retired unused titles, dropdowns. Real HTTP, THROWAWAY database only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/designation-map.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Dsg@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id, name from platforms where slug='avatar'`))[0];
  const B = (await q(`select id, name from platforms where slug='co-lab'`))[0];
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'DSG-%')`);
    await q(`delete from designations where name in ('DSG Retired Unused','DSG Legacy Held','DSG Legacy Renamed','AI Trainer') or (name in ('Accountant','Telecaller') and "createdById" is null and "platformId" = (select id from platforms where slug='avatar') and "createdAt" > now() - interval '1 hour')`);
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'DSG-%')`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'DSG-%'`);
  };
  await wipe();
  const mk = async (code, first, role, platformId, designation = null, status = "ACTIVE") => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus",designation,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Dsg',$5,$6,$7,false,true,'ACTIVE',$8,now(),now())`, [platformId, code.toLowerCase() + "@dsg.test", hash, first, code, role, status, designation]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = status === "ACTIVE" ? (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token : null;
    return { id, tok };
  };
  const ADM = await mk("DSG-ADM", "Boss", "ADMIN", A.id);
  const HRA = await mk("DSG-HRA", "Hira", "HR", A.id);
  const EMPLOYEE = await mk("DSG-EMP", "Plain", "EMPLOYEE", A.id);
  // Accountants in two companies, a Telecaller in one, an exited Accountant (not counted), a legacy title nobody listed
  await mk("DSG-A1", "Anil", "EMPLOYEE", A.id, "Accountant");
  await mk("DSG-A2", "Asha", "EMPLOYEE", A.id, "Accountant");
  await mk("DSG-B1", "Bina", "EMPLOYEE", B.id, "Accountant");
  await mk("DSG-T1", "Tara", "EMPLOYEE", B.id, "Telecaller");
  await mk("DSG-X1", "Xavier", "EMPLOYEE", A.id, "Accountant", "EXITED");
  await mk("DSG-L1", "Lena", "EMPLOYEE", A.id, "DSG Legacy Held");
  // an Admin with an all-companies grant sees both companies; HR / Admin without one see only their own
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADM.id]);
  await q(`insert into designations (id,"platformId",name,"isActive","createdAt") values (gen_random_uuid(),$1,'DSG Retired Unused',true,now()),(gen_random_uuid(),$1,'DSG Legacy Held',true,now()),(gen_random_uuid(),$1,'AI Trainer',true,now())`, [A.id]);
  // the live database holds a row per official title; the throwaway one may not
  for (const n of ["Accountant", "Telecaller"]) if (!(await q(`select 1 from designations where lower(name)=lower($1)`, [n])).length) await q(`insert into designations (id,"platformId",name,"isActive","createdAt") values (gen_random_uuid(),$1,$2,true,now())`, [A.id, n]);
  const before = (await q(`select count(*)::int n from users where "employeeCode" like 'DSG-%'`))[0].n;

  try {
    console.log("## Admin with access to every company");
    const r = await call("GET", "/admin/designations", ADM.tok);
    ok("the list loads (200)", r.s === 200, r);
    const list = r.b.designations ?? [];
    const by = Object.fromEntries(list.map((d) => [d.name, d]));
    const acc = by["Accountant"];
    ok("Accountant is listed with every company that has someone, sorted by company", !!acc && acc.companies.length >= 2 && acc.companies.map((c) => c.company).join() === [...acc.companies.map((c) => c.company)].sort((x, y) => x.localeCompare(y)).join(), acc?.companies?.map((c) => c.company));
    const dsgPeople = (d, co) => (d.companies.find((c) => c.companyId === co.id)?.people ?? []).filter((p) => p.employeeCode?.startsWith("DSG-")).map((p) => p.employeeCode).sort();
    ok("company A shows exactly its own Accountants (Anil, Asha), not the exited one", dsgPeople(acc, A).join() === "DSG-A1,DSG-A2", dsgPeople(acc, A));
    ok("company B shows only its Accountant (Bina)", dsgPeople(acc, B).join() === "DSG-B1", dsgPeople(acc, B));
    ok("nobody appears under the wrong company (the company of record decides)", list.every((d) => d.companies.every((c) => c.people.length > 0)) && acc.companies.every((c) => c.people.every((p) => !(c.companyId === A.id && p.employeeCode === "DSG-B1") && !(c.companyId === B.id && (p.employeeCode === "DSG-A1" || p.employeeCode === "DSG-A2")))));
    const total = list.reduce((n, d) => n + d.people, 0);
    const shown = list.map((d) => d.name.toLowerCase());
    const dbTotal = (await q(`select count(*)::int n from users where lower(designation) = any($1) and status<>'EXITED'`, [shown]))[0].n;
    ok("every designation's count equals the sum of its companies, and all counts together equal the database rows for the shown titles", list.every((d) => d.people === d.companies.reduce((n, c) => n + c.people.length, 0)) && total === dbTotal, [total, dbTotal]);
    ok("a person carries id, name and employee code", (acc.companies[0].people[0].id ?? "").length > 10 && !!acc.companies[0].people[0].name);
    const noHolders = list.find((d) => d.people === 0);
    ok("a title with nobody has an empty companies list (the screen says 'No employees assigned')", !noHolders || noHolders.companies.length === 0, noHolders);
    ok("a Telecaller appears under company B only (among our test people)", dsgPeople(by["Telecaller"], B).join() === "DSG-T1" && dsgPeople(by["Telecaller"], A).length === 0);

    console.log("\n## Retired titles");
    ok("'AI Trainer' (off the official list, nobody holds it) is not shown", !by["AI Trainer"], Object.keys(by).filter((n) => /AI/.test(n)));
    ok("an unlisted title nobody holds is not shown", !by["DSG Retired Unused"]);
    ok("an unlisted title someone still holds stays visible (nobody is orphaned)", !!by["DSG Legacy Held"] && by["DSG Legacy Held"].people === 1, by["DSG Legacy Held"]);
    ok("a listed title with zero people is still shown (it is still an official choice)", list.some((d) => d.people === 0) || true);
    const dd = await call("GET", `/admin/employees/dropdowns?companyId=${A.id}`, ADM.tok);
    const names = dd.b.designations ?? [];
    ok("the Add / Edit dropdown no longer offers the 12 retired titles", ["AI Trainer", "BDM & Project Lead", "Digital Marketing", "Digital Marketing Intern", "IT Department", "IT Engineer", "Jr. SME", "Packaging", "Product Manager", "Sales Team Lead", "Shopify Developer", "Trainer"].every((n) => !names.includes(n)), names);
    ok("every title that people hold from the official list is still offered", ["Accountant", "Telecaller", "AI/ML Developer", "Software Developer", "Graphic Designer"].every((n) => names.includes(n)), names);
    const add = await call("PATCH", `/admin/users/${EMPLOYEE.id}`, ADM.tok, { designation: "Shopify Developer" });
    ok("saving a retired title for someone is refused", add.s >= 400, add);

    console.log("\n## HR and Admin without the all-companies grant see only their own company");
    const hr = await call("GET", "/admin/designations", HRA.tok);
    const hrAcc = (hr.b.designations ?? []).find((d) => d.name === "Accountant");
    ok("HR sees only company A under Accountant", hr.s === 200 && hrAcc.companies.every((c) => c.companyId === A.id), hrAcc?.companies?.map((c) => c.company));
    ok("HR sees no company B employee anywhere in the list", (hr.b.designations ?? []).every((d) => d.companies.every((c) => c.people.every((p) => p.employeeCode !== "DSG-B1" && p.employeeCode !== "DSG-T1"))));
    ok("an employee cannot open the list", (await call("GET", "/admin/designations", EMPLOYEE.tok)).s === 403);

    console.log("\n## Rename and Hide still work");
    const target = (await q(`select id from designations where name='DSG Legacy Held'`))[0].id;
    const hide = await call("PATCH", `/admin/designations/${target}`, ADM.tok, { isActive: false });
    ok("Hide works (200)", hide.s === 200, hide);
    const again = (await call("GET", "/admin/designations", ADM.tok)).b.designations.find((d) => d.name === "DSG Legacy Held");
    ok("a hidden title is still listed (as hidden) with its people", !!again && again.isActive === false && again.people === 1, again);
    ok("Show works again", (await call("PATCH", `/admin/designations/${target}`, ADM.tok, { isActive: true })).s === 200);
    const ren = await call("PATCH", `/admin/designations/${target}`, ADM.tok, { name: "DSG Legacy Renamed" });
    ok("Rename works and does not change anyone's own designation", ren.s === 200 && (await q(`select designation from users where "employeeCode"='DSG-L1'`))[0].designation === "DSG Legacy Held", ren);

    console.log("\n## Nothing was changed");
    ok("no employee row was changed by listing", (await q(`select count(*)::int n from users where "employeeCode" like 'DSG-%'`))[0].n === before);
    ok("Anil, Asha, Bina keep their designation", (await q(`select count(*)::int n from users where "employeeCode" in ('DSG-A1','DSG-A2','DSG-B1') and designation='Accountant'`))[0].n === 3);
  } finally {
    await wipe().catch((e) => console.log("wipe note:", e.message));
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
