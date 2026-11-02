// HR & Company Management, Phase 1: company access, automatic employee IDs, Edit Employee, dropdowns, duplicate protection.
// Disposable Neon branch only (see _guard.cjs). Needs migration 20261102100000_company_access_and_codes applied there.
// Backend must run against that branch with OWNER_CODES unset or not containing any PH1- code.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/phase1-company-hr.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Phase1@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id, "employeeCodePrefix" as prefix from platforms where slug='avatar'`))[0];
  const B = (await q(`select id from platforms where slug='avance'`))[0];
  const C = (await q(`select id from platforms where slug='take-health'`))[0];
  const hash = await bcrypt.hash(PW, 10);

  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'PH1-%' or email like '%@ph1.test' or "firstName" = 'Pipeline')`;
    await q(`delete from company_access where "userId" in ${ids}`);
    await q(`delete from employee_profiles where "userId" in ${ids}`);
    await q(`delete from team_members where "userId" in ${ids}`);
    await q(`delete from leave_requests where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'PH1-%' or email like '%@ph1.test' or "firstName" = 'Pipeline'`);
    await q(`delete from designations where name like 'PH1 %'`);
    await q(`delete from team_members where "teamId" in (select id from teams where name like 'PH1 %')`);
    await q(`delete from team_configs where "teamId" in (select id from teams where name like 'PH1 %')`);
    await q(`delete from teams where name like 'PH1 %'`);
    await q(`delete from platforms where slug like 'ph1-%'`);
  };
  await wipe();
  const fingerprint = async () => (await q(`select count(*)::int n, md5(coalesce(string_agg(id::text || '|' || coalesce("monthlySalary"::text,'') || '|' || coalesce(designation,'') || '|' || coalesce("reportsToId"::text,'') || '|' || coalesce("employeeCode",'') || '|' || "platformId"::text, ',' order by id), '')) h from users where email not like '%@ph1.test' and "employeeCode" not like 'PH1-%' and "firstName" <> 'Pipeline'`))[0];
  const baseline = await fingerprint();

  const mk = async (code, role, platformId, over = {}) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId",designation,"monthlySalary","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Ph1',$5,$6,$7,false,true,'ACTIVE',$8,$9,$10,now(),now())`,
      [platformId, code.toLowerCase() + "@ph1.test", hash, over.first ?? code.replace("PH1-", "T"), code, role, over.status ?? "ACTIVE", over.reportsToId ?? null, over.designation ?? null, over.salary ?? null]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
    return { id, tok, code };
  };
  const grant = (userId, platformId) => q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,$2,now())`, [userId, platformId]);

  // ---- people ----
  const ADM = await mk("PH1-ADM", "ADMIN", A.id);                   // Admin of A, no grants
  const TOP = await mk("PH1-TOP", "ADMIN", A.id);                   // top management: all companies
  const HR1 = await mk("PH1-HR1", "HR", A.id);                      // HR of A, assigned B
  const HR2 = await mk("PH1-HR2", "HR", A.id);                      // HR of A, nothing else
  const MA = await mk("PH1-MA", "MANAGER", A.id);                   // manager in A
  const MB = await mk("PH1-MB", "MANAGER", B.id);                   // manager in B
  const EA = await mk("PH1-EA", "EMPLOYEE", A.id, { designation: "PH1 Analyst", salary: 30000, reportsToId: MA.id });
  const EB = await mk("PH1-EB", "EMPLOYEE", B.id, { designation: "PH1 Analyst", reportsToId: MB.id });
  const EC = await mk("PH1-EC", "EMPLOYEE", C.id);
  await grant(TOP.id, null);
  await grant(HR1.id, B.id);

  console.log("\n## 1. Company access: nobody reaches a company they were not given");
  const lA = await call("GET", "/admin/users", HR2.tok);
  ok("HR with no grants lists only their own company", lA.s === 200 && lA.b.users.every((u) => u.companyId === A.id) && lA.b.users.some((u) => u.id === EA.id) && !lA.b.users.some((u) => u.id === EB.id), lA.s);
  const l1 = await call("GET", "/admin/users", HR1.tok);
  ok("HR assigned B lists A and B", l1.b.users.some((u) => u.id === EA.id) && l1.b.users.some((u) => u.id === EB.id) && !l1.b.users.some((u) => u.id === EC.id));
  ok("and nobody from C", !l1.b.users.some((u) => u.companyId === C.id));
  ok("filtering to an unassigned company is refused (404)", (await call("GET", `/admin/users?companyId=${C.id}`, HR1.tok)).s === 404);
  ok("filtering to an assigned company works", (await call("GET", `/admin/users?companyId=${B.id}`, HR1.tok)).b.users.every((u) => u.companyId === B.id));
  ok("the company picker for HR1 lists A and B only", (await call("GET", "/admin/employees/companies", HR1.tok)).b.companies.map((c) => c.id).sort().join() === [A.id, B.id].sort().join());
  ok("HR2 has no picker", (await call("GET", "/admin/employees/companies", HR2.tok)).b.canSwitch === false);
  ok("top management lists everyone, all companies", (await call("GET", "/admin/users", TOP.tok)).b.users.some((u) => u.id === EC.id));
  // direct API access to a person of an unassigned company
  ok("HR1 cannot open the edit model of a person in C (404)", (await call("GET", `/admin/employees/${EC.id}/edit`, HR1.tok)).s === 404);
  ok("HR1 cannot edit a person in C (404)", (await call("PATCH", `/admin/users/${EC.id}`, HR1.tok, { phone: "9999999999" })).s === 404);
  ok("HR1 cannot reset a password in C (404)", (await call("POST", `/admin/users/${EC.id}/password`, HR1.tok, { password: "Another@1234" })).s === 404);
  ok("HR1 CAN open and edit a person in B", (await call("GET", `/admin/employees/${EB.id}/edit`, HR1.tok)).s === 200 && (await call("PATCH", `/admin/users/${EB.id}`, HR1.tok, { phone: "9876543210" })).s === 200);
  ok("HR2 cannot open a person of B (404)", (await call("GET", `/admin/employees/${EB.id}/edit`, HR2.tok)).s === 404);
  ok("dropdowns of an unassigned company are refused (404)", (await call("GET", `/admin/employees/dropdowns?companyId=${C.id}`, HR1.tok)).s === 404);
  ok("an employee cannot reach the admin APIs (403)", (await call("GET", "/admin/users", EA.tok)).s === 403 && (await call("GET", "/admin/employees/companies", EA.tok)).s === 403);
  ok("a manager cannot either (403)", (await call("GET", "/admin/users", MA.tok)).s === 403);

  console.log("\n## 2. Who can hand out company access");
  ok("HR cannot read the access list (403)", (await call("GET", "/admin/company-access", HR1.tok)).s === 403);
  ok("an Admin without all-company access cannot change it (403)", (await call("POST", `/admin/company-access/${HR2.id}`, ADM.tok, { all: false, companyIds: [B.id] })).s === 403);
  ok("top management cannot change their own (403)", (await call("POST", `/admin/company-access/${TOP.id}`, TOP.tok, { all: true })).s === 403);
  ok("access cannot be given to an employee (400)", (await call("POST", `/admin/company-access/${EA.id}`, TOP.tok, { all: false, companyIds: [B.id] })).s === 400);
  ok("top management gives HR2 company B", (await call("POST", `/admin/company-access/${HR2.id}`, TOP.tok, { all: false, companyIds: [B.id] })).s === 200);
  ok("it takes effect on the very next request", (await call("GET", `/admin/employees/${EB.id}/edit`, HR2.tok)).s === 200);
  ok("removing it takes effect at once too", (await call("POST", `/admin/company-access/${HR2.id}`, TOP.tok, { all: false, companyIds: [] })).s === 200 && (await call("GET", `/admin/employees/${EB.id}/edit`, HR2.tok)).s === 404);
  ok("an unknown company is refused", (await call("POST", `/admin/company-access/${HR2.id}`, TOP.tok, { all: false, companyIds: ["00000000-0000-4000-8000-000000000000"] })).s === 404);
  ok("the grant was written to the audit log", (await q(`select 1 from audit_logs where summary like 'Changed which companies%' and "targetUserId"=$1`, [HR2.id])).length >= 1);
  // the same rule feeds leave
  const lv = await q(`select id from shifts limit 1`);
  await q(`insert into leave_requests (id,"platformId","userId","fromDate","toDate","leaveType","isHalfDay","isFirstHalf","dayCount",reason,status,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,current_date+2,current_date+2,'CASUAL',false,true,1,'Family function','PENDING',now(),now())`, [B.id, EB.id]);
  ok("leave: HR assigned B sees B's request, HR2 does not", (await call("GET", "/leave/requests?status=PENDING", HR1.tok)).b.requests.some((r) => r.person.id === EB.id) && !(await call("GET", "/leave/requests?status=PENDING", HR2.tok)).b.requests.some((r) => r.person.id === EB.id));

  console.log("\n## 3. Employee IDs are generated, unique, and never changed");
  const before = (await q(`select "employeeCode" from users where "employeeCode" is not null order by 1`)).map((r) => r.employeeCode).join("|");
  const mkUser = (i) => call("POST", "/admin/users", ADM.tok, { email: `gen${i}@ph1.test`, firstName: `Gen${i}`, lastName: "Person", password: "Temp@12345678", role: "EMPLOYEE", skipOnboarding: true });
  const made = await Promise.all(Array.from({ length: 10 }, (_, i) => mkUser(i)));
  const codes = made.map((m) => m.b.user?.employeeCode);
  ok("ten people created at the same moment all succeed", made.every((m) => m.s === 201), made.map((m) => m.s));
  ok("every one got a different ID", new Set(codes).size === 10, codes);
  ok("each ID is the company prefix and a number", codes.every((c) => new RegExp(`^${A.prefix}-\\d{4,}$`).test(c)), codes);
  const nums = codes.map((c) => Number(c.split("-")[1])).sort((a, b) => a - b);
  ok("the numbers are consecutive (nothing skipped)", nums.every((n, i) => i === 0 || n === nums[i - 1] + 1), nums);
  ok("the database holds ten distinct codes for them", (await q(`select count(distinct "employeeCode") n from users where email like 'gen%@ph1.test'`))[0].n === "10");
  ok("no existing employee ID changed", (await q(`select "employeeCode" from users where "employeeCode" is not null and email not like 'gen%@ph1.test' order by 1`)).map((r) => r.employeeCode).join("|") === before.split("|").filter((c) => !codes.includes(c)).join("|"));
  const dupName = await call("POST", "/admin/users", ADM.tok, { email: "gen0b@ph1.test", firstName: "Gen0", lastName: "Person", password: "Temp@12345678", role: "EMPLOYEE", skipOnboarding: true });
  ok("the same name in the same company is refused as a duplicate person (409)", dupName.s === 409, dupName);
  ok("unless it is confirmed to be someone else", (await call("POST", "/admin/users", ADM.tok, { email: "gen0b@ph1.test", firstName: "Gen0", lastName: "Person", password: "Temp@12345678", role: "EMPLOYEE", skipOnboarding: true, confirmNotDuplicate: true })).s === 201);
  ok("a typed ID from HR is refused (403): only an Admin may type one", (await call("POST", "/admin/users", HR2.tok, { email: "typed1@ph1.test", firstName: "Typed", lastName: "One", password: "Temp@12345678", role: "EMPLOYEE", employeeCode: "PH1-TYPED1" })).s === 403);
  ok("an Admin can carry over an ID", (await call("POST", "/admin/users", ADM.tok, { email: "typed2@ph1.test", firstName: "Typed", lastName: "Two", password: "Temp@12345678", role: "EMPLOYEE", employeeCode: "PH1-TYPED2" })).s === 201);
  ok("a typed ID that already exists is refused (409)", (await call("POST", "/admin/users", ADM.tok, { email: "typed3@ph1.test", firstName: "Typed", lastName: "Three", password: "Temp@12345678", role: "EMPLOYEE", employeeCode: "ph1-typed2" })).s === 409);
  ok("an employee ID cannot be edited (403)", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { employeeCode: "PH1-NEW" })).s === 403);
  ok("sending the same ID back is harmless", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { employeeCode: "PH1-EA", phone: "9000000001" })).s === 200);
  ok("a person cannot be created in a company you cannot act on (404)", (await call("POST", "/admin/users", HR2.tok, { email: "cross@ph1.test", firstName: "Cross", lastName: "Co", password: "Temp@12345678", role: "EMPLOYEE", companyId: C.id })).s === 404);
  const inB = await call("POST", "/admin/users", HR1.tok, { email: "inb@ph1.test", firstName: "In", lastName: "Avance", password: "Temp@12345678", role: "EMPLOYEE", companyId: B.id });
  ok("HR assigned B can create into B, and the ID uses B's prefix", inB.s === 201 && /^AVANCE-/i.test(inB.b.user.employeeCode), inB);

  console.log("\n## 4. Prefixes");
  ok("HR cannot change a company prefix (403)", (await call("POST", `/companies/${A.id}`, HR1.tok, { employeeCodePrefix: "ZZA" })).s === 403);
  ok("an Admin can set a free prefix on their company", (await call("POST", `/companies/${A.id}`, ADM.tok, { employeeCodePrefix: "PHA" })).s === 200);
  const afterPrefix = await call("POST", "/admin/users", ADM.tok, { email: "pfx1@ph1.test", firstName: "Pfx", lastName: "One", password: "Temp@12345678", role: "EMPLOYEE" });
  ok("new people get the new prefix, counting from 0001", /^PHA-0001$/.test(afterPrefix.b.user?.employeeCode ?? ""), afterPrefix);
  ok("earlier IDs are untouched", (await q(`select 1 from users where "employeeCode"=$1`, [codes[0]])).length === 1);
  ok("a prefix another company uses is refused whatever the capitals (409)", (await call("POST", `/companies/${A.id}`, TOP.tok, { employeeCodePrefix: "avance" })).s === 409);
  ok("a one-letter prefix is refused (400)", (await call("POST", `/companies/${A.id}`, TOP.tok, { employeeCodePrefix: "X" })).s === 400);
  await call("POST", `/companies/${A.id}`, TOP.tok, { employeeCodePrefix: A.prefix }); // put it back
  ok("a company with an existing name (any capitals) is refused (409)", (await call("POST", "/companies", TOP.tok, { name: "AVATAR" })).s === 409);

  console.log("\n## 5. Edit Employee");
  const model = await call("GET", `/admin/employees/${EA.id}/edit`, ADM.tok);
  ok("the edit model has the person, permissions and THEIR company's dropdowns", model.s === 200 && model.b.person.companyId === A.id && Array.isArray(model.b.dropdowns.managers) && model.b.permissions.canEditSalary === true, model.b);
  ok("managers offered are from the person's company only", model.b.dropdowns.managers.every((m) => m.id !== EB.id && m.id !== MB.id) && model.b.dropdowns.managers.some((m) => m.id === MA.id));
  const modelHr = await call("GET", `/admin/employees/${EA.id}/edit`, HR2.tok);
  ok("HR is not shown the salary and cannot edit it", modelHr.b.person.monthlySalary === undefined && modelHr.b.permissions.canEditSalary === false);
  ok("HR changing a salary is refused (403)", (await call("PATCH", `/admin/users/${EA.id}`, HR2.tok, { monthlySalary: 99999 })).s === 403);
  ok("the Admin must confirm replacing an existing salary (409)", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { monthlySalary: 35000 })).s === 409);
  ok("with the confirmation it is saved", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { monthlySalary: 35000, confirmOverwrite: { salary: true } })).s === 200 && Number((await q(`select "monthlySalary" s from users where id=$1`, [EA.id]))[0].s) === 35000);
  ok("a bad salary is refused (400)", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { monthlySalary: -5, confirmOverwrite: { salary: true } })).s === 400);
  ok("someone with no salary can be given one without a confirmation", (await call("PATCH", `/admin/users/${EB.id}`, TOP.tok, { monthlySalary: 20000 })).s === 200);
  ok("changing an existing designation needs a confirmation (409)", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { designation: "PH1 Lead" })).s === 409);
  ok("a company with no designation list accepts typed text once confirmed", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { designation: "PH1 Lead", confirmOverwrite: { designation: true } })).s === 200);
  ok("add a designation to the company's list", (await call("POST", "/admin/designations", ADM.tok, { companyId: A.id, name: "PH1 Analyst" })).s === 201);
  ok("the same designation in other capitals is refused (409)", (await call("POST", "/admin/designations", ADM.tok, { companyId: A.id, name: "ph1  ANALYST" })).s === 409);
  ok("once the company has a list, a title outside it is refused (400)", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { designation: "PH1 Wizard", confirmOverwrite: { designation: true } })).s === 400);
  ok("a title from the list is accepted, in the list's own spelling", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { designation: "ph1 analyst", confirmOverwrite: { designation: true } })).s === 200 && (await q(`select designation from users where id=$1`, [EA.id]))[0].designation === "PH1 Analyst");
  ok("HR2 cannot add a designation to a company they cannot act on (404)", (await call("POST", "/admin/designations", HR2.tok, { companyId: B.id, name: "PH1 Sneaky" })).s === 404);
  ok("an unrelated edit does not trip the designation list", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { phone: "9000000002" })).s === 200);
  // reporting manager
  ok("a manager from another company is refused (400)", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { reportsToId: MB.id })).s === 400);
  ok("nobody can report to themselves (400)", (await call("PATCH", `/admin/users/${MA.id}`, ADM.tok, { reportsToId: MA.id })).s === 400);
  ok("an employee-role person cannot be chosen as a manager (400)", (await call("PATCH", `/admin/users/${MA.id}`, ADM.tok, { reportsToId: EA.id })).s === 400);
  await call("PATCH", `/admin/users/${MA.id}`, ADM.tok, { reportsToId: ADM.id });
  ok("a reporting loop is refused (400)", (await call("PATCH", `/admin/users/${ADM.id}`, TOP.tok, { reportsToId: MA.id })).s === 400);
  const MX = await mk("PH1-MX", "MANAGER", A.id, { status: "EXITED" });
  ok("an exited manager cannot be chosen (400)", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { reportsToId: MX.id })).s === 400);
  ok("the existing reporting line is kept when it is not edited", (await q(`select "reportsToId" r from users where id=$1`, [EA.id]))[0].r === MA.id);
  // status / type / joining / company
  ok("employee type can be set (and cleared)", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { employmentType: "PERMANENT" })).s === 200 && (await q(`select "employmentType" t from employee_profiles where "userId"=$1`, [EA.id]))[0].t === "PERMANENT" && (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { employmentType: null })).s === 200);
  ok("a bad employee type is refused (400)", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { employmentType: "GOD" })).s === 400);
  ok("joining date and status can be edited", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { dateOfJoining: "2024-04-01", status: "SUSPENDED" })).s === 200 && (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { status: "ACTIVE" })).s === 200);
  ok("a bad date is refused (400)", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { dateOfJoining: "2024-02-31" })).s === 400);
  ok("the company cannot be changed here (400)", (await call("PATCH", `/admin/users/${EA.id}`, TOP.tok, { companyId: B.id })).s === 400);
  ok("an email already used in the company is refused (409)", (await call("PATCH", `/admin/users/${EA.id}`, ADM.tok, { email: "ph1-ma@ph1.test" })).s === 409);
  ok("HR cannot change an HR or Admin account (403)", (await call("PATCH", `/admin/users/${ADM.id}`, HR2.tok, { phone: "9" })).s === 403);
  ok("HR cannot promote anyone to Admin (403)", (await call("PATCH", `/admin/users/${EA.id}`, HR2.tok, { role: "ADMIN" })).s === 403);

  console.log("\n## 6. Every edit is audited, and salary amounts are for Admins only");
  const logRow = (await q(`select id, before, after from audit_logs where "targetUserId"=$1 and summary like '%monthlySalary%' order by "createdAt" desc limit 1`, [EA.id]))[0];
  ok("the salary change is in the audit log with what it was and what it became", !!logRow && JSON.stringify(logRow.before).includes("30000") && JSON.stringify(logRow.after).includes("35000"), logRow);
  const asAdmin = await call("GET", `/audit-logs/${logRow.id}`, ADM.tok);
  ok("an Admin reads the amounts", JSON.stringify(asAdmin.b).includes("35000"), asAdmin);
  const asHr = await call("GET", `/audit-logs/${logRow.id}`, HR1.tok);
  ok("HR reading the same entry sees no amounts", asHr.s === 200 ? !JSON.stringify(asHr.b).includes("35000") && !JSON.stringify(asHr.b).includes("30000") : true, asHr);
  ok("a designation change is audited too", (await q(`select 1 from audit_logs where "targetUserId"=$1 and summary like '%designation%'`, [EA.id])).length >= 1);

  console.log("\n## 7. Dropdown choices and duplicates");
  const dd = await call("GET", `/admin/employees/dropdowns?companyId=${B.id}`, TOP.tok);
  ok("choosing a company filters departments and managers to it", dd.s === 200 && dd.b.managers.every((m) => m.id !== MA.id) && dd.b.managers.some((m) => m.id === MB.id), dd.b);
  ok("statuses and employee types come from the server", dd.b.statuses.includes("ACTIVE") && dd.b.employeeTypes.includes("CONTRACT"));
  await q(`insert into teams (id,"platformId",name,"teamType","isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'PH1 Dept','OTHER',true,now(),now())`, [A.id]);
  ok("a department with an existing name (any capitals) is refused (409)", (await call("POST", "/admin/teams", ADM.tok, { name: "ph1 dept" })).s === 409);
  ok("the same department name in ANOTHER company is allowed", (await call("POST", "/admin/teams", TOP.tok, { name: "PH1 Dept" })).s !== 500);

  console.log("\n## 8. Add Employee (import pipeline): blank ID is generated only when confirmed");
  const cells = (id, email) => ["Avatar", "Pipeline Person", id, email, "", "PH1 Analyst", "", "", "Employee", "NONE", "NONE", "2024-05-01", "", "", ""];
  const FIELDS = ["company", "fullName", "employeeId", "email", "mobile", "designation", "team", "projects", "role", "reportsToName", "reportsToId", "dateOfJoining", "shiftStart", "shiftEnd", "shiftDays"];
  const mapping = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
  const req = (c, options) => ({ rows: [{ rowNumber: 1, cells: c }], mapping, options: { blankTeamIsNone: true, onboarding: "EXISTING", ...options } });
  const prevNo = await call("POST", "/admin/employees/preview", ADM.tok, req(cells("", "pipe1@ph1.test"), {}));
  ok("a blank ID is rejected until generation is confirmed", prevNo.b.rows[0].status === "INVALID" && prevNo.b.rows[0].issues.some((i) => i.code === "ID_MISSING"), prevNo.b);
  const prevYes = await call("POST", "/admin/employees/preview", ADM.tok, req(cells("", "pipe1@ph1.test"), { blankIdIsGenerated: true }));
  ok("with the confirmation the row is valid", prevYes.b.rows[0].status === "VALID", prevYes.b);
  const done = await call("POST", "/admin/employees/commit", ADM.tok, { ...req(cells("", "pipe1@ph1.test"), { blankIdIsGenerated: true }), confirm: true, expectedValid: 1 });
  ok("saved: the person got the company's next ID", done.s === 200 && /^[A-Z]+-\d{4,}$/.test(done.b.credentials?.[0]?.employeeId ?? ""), done);
  ok("the stored ID matches what was reported", (await q(`select 1 from users where email='pipe1@ph1.test' and "employeeCode"=$1`, [done.b.credentials?.[0]?.employeeId])).length === 1);
  const typed = await call("POST", "/admin/employees/commit", ADM.tok, { ...req(cells("PH1-PIPE2", "pipe2@ph1.test"), {}), confirm: true, expectedValid: 1 });
  ok("a typed ID is kept exactly as given", typed.s === 200 && typed.b.credentials[0].employeeId === "PH1-PIPE2");
  const ph = await call("POST", "/admin/employees/commit", ADM.tok, { ...req(cells("", ""), { blankIdIsGenerated: true, blankEmailUsesPlaceholder: true }), confirm: true, expectedValid: 1 });
  ok("no email + generated ID: the sign-in placeholder uses the REAL ID", ph.s === 200 && ph.b.credentials[0].signInWith.toLowerCase() === ph.b.credentials[0].employeeId.toLowerCase(), ph);
  ok("an HR cannot add people to a company they cannot act on (row refused)", (await call("POST", "/admin/employees/preview", HR2.tok, req(["Take Health", "Cross Person", "", "x@ph1.test", "", "PH1 Analyst", "", "", "Employee", "NONE", "NONE", "2024-05-01", "", "", ""], { blankIdIsGenerated: true }))).b.rows[0].status === "INVALID");

  await wipe();
  console.log("\n## 9. Nothing that existed before was rewritten");
  const final = await fingerprint();
  ok("every existing person keeps the same ID, company, salary, designation and reporting line", final.n === baseline.n && final.h === baseline.h, { baseline, final });
  ok("the test's own people and lists were all cleaned up", (await q(`select count(*)::int n from users where "employeeCode" like 'PH1-%' or email like '%@ph1.test' or "firstName" = 'Pipeline'`))[0].n === 0);
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
