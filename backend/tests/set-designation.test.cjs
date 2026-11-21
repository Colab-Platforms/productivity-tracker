// Changing one person's designation to "Business Advisor": only that field changes; it shows on every screen's data. THROWAWAY database only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/set-designation.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Dsg@12345678";
const script = (args, env = {}) => spawnSync("node", [path.join(__dirname, "..", "scripts", "set-designation.cjs"), ...args], { env: { ...process.env, DES_DB_URL: process.env.TEST_DATABASE_URL, ...env }, encoding: "utf8" });
const TARGET = ["--code", "DSG-SB", "--first", "Sanjay", "--last", "Singh Bhati", "--role", "ADMIN", "--to", "Business Advisor"];

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => { await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'DSG-%')`); await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'DSG-%')`).catch(() => {}); await q(`delete from users where "employeeCode" like 'DSG-%'`); };
  await wipe();
  const mk = async (code, first, last, role, desig, boss = null) => { await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,designation,"reportsToId","mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9,false,true,'ACTIVE',now(),now())`, [A, code.toLowerCase() + "@x.test", hash, first, last, code, role, desig, boss]); return (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id; };
  const login = async (c) => (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: c, password: PW }) })).json()).token;
  try {
    const sb = await mk("DSG-SB", "Sanjay", "Singh Bhati", "ADMIN", "Business Head");
    await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [sb]);
    const other = await mk("DSG-OTHER", "Sanjay", "Other", "EMPLOYEE", "Associate");   // a similar name must not be touched
    const adm2 = await mk("DSG-ADM2", "Second", "Admin", "ADMIN", "Business Head");  // another Admin with the same old title must not be touched
    const before = (await q(`select id, role::text role, status::text status, email, "passwordHash" ph, "reportsToId" r, "platformId" p, "employeeCode" c, "firstName" f, "lastName" l from users where id=$1`, [sb]))[0];
    const ta = await login("DSG-SB"), t2 = await login("DSG-ADM2");

    console.log("## the title is on the official list (no second list or table to edit)");
    const dd = (await call("GET", `/admin/employees/dropdowns?companyId=${A}`, t2)).b;
    ok("'Business Advisor' is offered in the Add / Edit Employee designation dropdown, once", dd.designations.filter((d) => (d.name ?? d) === "Business Advisor").length === 1, dd.designations.slice(0, 5));

    console.log("\n## the script");
    const dry = script(TARGET); ok("dry run shows the change and writes nothing", dry.status === 0 && /Business Head" -> "Business Advisor"/.test(dry.stdout) && (await q(`select designation d from users where id=$1`, [sb]))[0].d === "Business Head", dry);
    ok("a title that is not on the list is refused", script([...TARGET.slice(0, -1), "Chief Wizard"]).status !== 0);
    ok("a wrong name is refused", script(["--code", "DSG-SB", "--first", "Sanjay", "--last", "Wrong", "--role", "ADMIN", "--to", "Business Advisor"]).status !== 0);
    ok("a wrong role is refused", script(["--code", "DSG-SB", "--first", "Sanjay", "--last", "Singh Bhati", "--role", "HR", "--to", "Business Advisor"]).status !== 0);
    ok("an unknown ID is refused", script(["--code", "DSG-NOPE", "--first", "A", "--last", "B", "--role", "ADMIN", "--to", "Business Advisor"]).status !== 0);
    // the live database is refused without --allow-live (the check happens before any connection is made)
    const liveUrl = (require("node:fs").readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL=")) ?? "").slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    const refused = script(TARGET, { DES_DB_URL: liveUrl });
    ok("the live database is refused without --allow-live", refused.status !== 0 && /REFUSING/.test(refused.stderr), refused.stderr);
    const app = script([...TARGET, "--apply"]); ok("--apply changes the designation", app.status === 0 && (await q(`select designation d from users where id=$1`, [sb]))[0].d === "Business Advisor", app);
    const after = (await q(`select id, role::text role, status::text status, email, "passwordHash" ph, "reportsToId" r, "platformId" p, "employeeCode" c, "firstName" f, "lastName" l from users where id=$1`, [sb]))[0];
    ok("role, status, email, password, reporting line, company, username and name are exactly as before", JSON.stringify(after) === JSON.stringify(before), [before, after]);
    ok("his all-company access and Admin role are unchanged", (await q(`select count(*)::int n from company_access where "userId"=$1 and "platformId" is null`, [sb]))[0].n === 1 && after.role === "ADMIN");
    ok("nobody else changed (similar name, other Admin with the same old title)", (await q(`select designation d from users where id=$1`, [other]))[0].d === "Associate" && (await q(`select designation d from users where id=$1`, [adm2]))[0].d === "Business Head");
    ok("no duplicate account was created", (await q(`select count(*)::int n from users where "employeeCode" like 'DSG-%'`))[0].n === 3);
    ok("one audit line records before and after", (await q(`select 1 from audit_logs where path='/scripts/set-designation' and "targetUserId"=$1 and before::text like '%Business Head%' and after::text like '%Business Advisor%'`, [sb])).length === 1);
    ok("running it again changes nothing", /already set/.test(script([...TARGET, "--apply"]).stdout));
    ok("his existing password still signs him in", !!(await login("DSG-SB")));

    console.log("\n## where the title is shown (the screens' data)");
    const users = (await call("GET", "/admin/users", t2)).b.users;
    ok("People list / Employee Overview / Organization Hierarchy data: designation = Business Advisor", users.find((u) => u.employeeCode === "DSG-SB")?.designation === "Business Advisor");
    ok("his role there is still Admin and he is still top level (no reporting manager)", users.find((u) => u.employeeCode === "DSG-SB")?.role === "ADMIN" && users.find((u) => u.employeeCode === "DSG-SB")?.reportsTo === null);
    const me = (await call("GET", "/auth/me", ta)).b; ok("/auth/me (sidebar, profile header) says Business Advisor", (me.user ?? me).designation === "Business Advisor", me);
    const prof = (await call("GET", "/auth/me/profile", ta)).b; ok("his own Admin profile says Business Advisor", JSON.stringify(prof).includes("Business Advisor"), Object.keys(prof));
    const edit = (await call("GET", `/admin/employees/${sb}/edit`, t2)).b; ok("the Edit Employee drawer shows Business Advisor", JSON.stringify(edit).includes("Business Advisor"));
    // Admin accounts are deliberately not part of the employee filters (they are not tracked employees), so the designation filter is not expected to list him
    const ov = (await call("GET", "/admin-console/overview", t2)); ok("the Admin dashboard still loads", ov.s === 200);

    console.log("\n## the in-app way works too (Edit Employee, with the overwrite confirmation)");
    await q(`update users set designation='Business Head' where id=$1`, [sb]);
    const noConfirm = await call("PATCH", `/admin/users/${sb}`, t2, { designation: "Business Advisor" });
    const withConfirm = await call("PATCH", `/admin/users/${sb}`, t2, { designation: "Business Advisor", confirmOverwrite: { designation: true } });
    ok("Edit Employee accepts the new title (after the overwrite confirmation when it asks for one)", (noConfirm.s === 200 || withConfirm.s === 200) && (await q(`select designation d from users where id=$1`, [sb]))[0].d === "Business Advisor", [noConfirm, withConfirm]);
    ok("a title off the list is still refused there", (await call("PATCH", `/admin/users/${sb}`, t2, { designation: "Chief Wizard", confirmOverwrite: { designation: true } })).s === 400);
  } finally { await wipe().catch((e) => console.log("wipe", e.message)); await db.end(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
