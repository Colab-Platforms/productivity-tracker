// Summary-card employee lists (GET /admin/users/page): the card number must equal the list behind it. Real HTTP, THROWAWAY database only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/user-page.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const call = async (m, p, t) => { const r = await fetch(API + p, { method: m, headers: t ? { authorization: "Bearer " + t } : {} }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Upg@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from team_members where "userId" in (select id from users where "employeeCode" like 'UPG-%')`);
    await q(`delete from teams where name like 'UPG %'`);
    await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'UPG-%')`);
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'UPG-%')`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'UPG-%'`);
  };
  await wipe();
  let n = 0;
  const mk = async (code, role, plat, status, first, joined) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Pager',$5,$6,$7,false,true,'ACTIVE',$8,now(),now())`, [plat, code.toLowerCase() + "@x.test", hash, first, code, role, status, joined]);
    return (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
  };
  try {
    const ADM = await mk("UPG-ADM", "ADMIN", A, "ACTIVE", "Zed", null);
    await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADM]);
    const HR = await mk("UPG-HR", "HR", A, "ACTIVE", "Hera", null); const EMP = await mk("UPG-EMP", "EMPLOYEE", A, "ACTIVE", "Emma", null);
    const plan = [["ACTIVE", 3], ["EXITED", 2], ["TERMINATED", 2], ["ABSCONDED", 1], ["SUSPENDED", 1], ["INVITED", 1], ["CANDIDATE", 1]];
    const ids = {};
    for (const [st, k] of plan) for (let i = 0; i < k; i++) { n++; const code = `UPG-P${String(n).padStart(2, "0")}`; ids[code] = await mk(code, "EMPLOYEE", A, st, `Name${String.fromCharCode(64 + n)}`, n % 3 === 0 ? null : `2025-0${(n % 9) + 1}-15`); ids[code + "_st"] = st; }
    const OB = await mk("UPG-XB", "EMPLOYEE", B, "EXITED", "Other", "2024-01-01");
    const team = (await q(`insert into teams (id,"platformId",name,"createdAt","updatedAt") values (gen_random_uuid(),$1,'UPG Sales',now(),now()) returning id`, [A]).catch(() => null))?.[0]?.id;
    if (team) { await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [team, ids["UPG-P01"]]).catch((e) => console.log("(team member skipped " + e.message.slice(0, 60) + ")")); }
    const login = async (c) => (await call("POST", "/auth/login", null)).b; // placeholder to keep helper symmetrical
    const tok = async (c) => { const r = await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: c, password: PW }) }); return (await r.json()).token; };
    const ta = await tok("UPG-ADM"), th = await tok("UPG-HR"), te = await tok("UPG-EMP");
    const page = async (t, qs = "") => call("GET", `/admin/users/page?employeesOnly=1&${qs}`, t);

    console.log("## counts equal the lists");
    const all = await page(ta, "view=ALL&pageSize=100"); const c = all.b.counts;
    ok("the endpoint answers for the Admin", all.s === 200 && Array.isArray(all.b.rows), all);
    for (const [v, key] of [["ALL", "all"], ["ACTIVE", "active"], ["INACTIVE", "inactive"], ["NOT_STARTED", "notStarted"]]) {
      const r = await page(ta, `view=${v}&pageSize=100`);
      ok(`${v}: card count (${c[key]}) = list total (${r.b.total}) = rows returned`, r.b.total === c[key] && r.b.viewTotal === c[key] && r.b.rows.length === Math.min(100, r.b.total), [r.b.total, c[key], r.b.rows.length]);
    }
    const usersAll = (await call("GET", "/admin/users?employeesOnly=1", ta)).b.users;
    const st = (s) => usersAll.filter((u) => s.includes(u.status)).length;
    ok("the same numbers as the existing people list (Total, Active, Inactive, Not started)", c.all === usersAll.length && c.active === st(["ACTIVE"]) && c.inactive === st(["EXITED", "TERMINATED", "ABSCONDED", "SUSPENDED"]) && c.notStarted === st(["INVITED", "CANDIDATE"]), [c, usersAll.length]);
    ok("Total = Active + Inactive + Not started", c.all === c.active + c.inactive + c.notStarted, c);

    console.log("\n## which statuses each card shows");
    const only = async (qs) => (await page(ta, qs + "&search=UPG-P&pageSize=100")).b.rows;
    const act = await only("view=ACTIVE"); ok("Active shows only Active", act.length === 3 && act.every((r) => r.status === "ACTIVE"), act.map((r) => r.status));
    const ina = await only("view=INACTIVE"); ok("Inactive shows Exited, Terminated, Absconded (and the older Suspended), nothing else", ina.length === 6 && ina.every((r) => ["EXITED", "TERMINATED", "ABSCONDED", "SUSPENDED"].includes(r.status)), ina.map((r) => r.status));
    const ns = await only("view=NOT_STARTED"); ok("Not started yet shows the invited/candidate records", ns.length === 2 && ns.every((r) => ["INVITED", "CANDIDATE"].includes(r.status)), ns.map((r) => r.status));
    for (const [s, k] of [["EXITED", 2], ["TERMINATED", 2], ["ABSCONDED", 1]]) { const r = await only(`view=INACTIVE&status=${s}`); ok(`Inactive > ${s}: ${k} people, all ${s}`, r.length === k && r.every((x) => x.status === s), r.map((x) => x.status)); }
    const alls = await only("view=ALL"); ok("Total shows every status", alls.length === 11, alls.length);
    ok("an Active-card status filter that does not belong to it shows nobody", (await only("view=ACTIVE&status=EXITED")).length === 0);
    ok("a made-up status shows nobody", (await only("view=ALL&status=FIRED")).length === 0);
    ok("other company's people are in the Admin's scope only because they hold the all-company grant", (await page(ta, "view=INACTIVE&search=UPG-XB")).b.rows.length === 1);

    console.log("\n## row content (real records)");
    const sample = (await page(ta, "view=ACTIVE&search=UPG-P01")).b.rows[0];
    ok("name, ID, designation field, status, joining date and departments are returned", sample.name === "NameA Pager" && sample.employeeCode === "UPG-P01" && sample.status === "ACTIVE" && "designation" in sample && sample.dateOfJoining && Array.isArray(sample.departments), sample);
    if (team) ok("the department comes from the person's team", sample.departments.some((d) => d.name === "UPG Sales"), sample.departments);

    console.log("\n## search, department, sort, paging");
    ok("search by employee ID", (await page(ta, "view=ALL&search=UPG-P03")).b.rows.map((r) => r.employeeCode).join() === "UPG-P03");
    ok("search by (part of) a name, any capitals", (await page(ta, "view=ALL&search=nameb")).b.rows.some((r) => r.employeeCode === "UPG-P02"));
    ok("search with no match returns an empty page", (await page(ta, "view=ALL&search=zzzznope")).b.total === 0);
    if (team) ok("department filter returns only that team's people", (await page(ta, `view=ALL&departmentId=${team}`)).b.rows.map((r) => r.employeeCode).join() === "UPG-P01");
    ok("a malformed department id is ignored, not an error", (await page(ta, "view=ALL&departmentId=abc")).s === 200);
    const byName = (await only("view=ALL&sort=name&dir=asc")).map((r) => r.name); ok("sort by name ascending", JSON.stringify(byName) === JSON.stringify([...byName].sort((a, b) => a.localeCompare(b))), byName);
    const byNameDesc = (await only("view=ALL&sort=name&dir=desc")).map((r) => r.name); ok("sort by name descending", JSON.stringify(byNameDesc) === JSON.stringify([...byNameDesc].sort((a, b) => b.localeCompare(a))), byNameDesc);
    const j = (await only("view=ALL&sort=joined&dir=asc")); const dated = j.filter((r) => r.dateOfJoining).map((r) => r.dateOfJoining);
    ok("sort by joining date: dated first in order, people without a date last", JSON.stringify(dated) === JSON.stringify([...dated].sort()) && j.slice(dated.length).every((r) => !r.dateOfJoining), j.map((r) => r.dateOfJoining));
    const p1 = await page(ta, "view=ALL&search=UPG-P&pageSize=5&page=1"), p2 = await page(ta, "view=ALL&search=UPG-P&pageSize=5&page=2"), p9 = await page(ta, "view=ALL&search=UPG-P&pageSize=5&page=9");
    ok("paging: 11 people in pages of 5", p1.b.rows.length === 5 && p2.b.rows.length === 5 && p1.b.pages === 3 && p1.b.total === 11, [p1.b.rows.length, p1.b.pages]);
    ok("paging: no person appears on two pages", new Set([...p1.b.rows, ...p2.b.rows].map((r) => r.id)).size === 10);
    ok("a page past the end is clamped to the last page", p9.b.page === 3 && p9.b.rows.length === 1);
    ok("page size is capped at 100", (await page(ta, "view=ALL&pageSize=5000")).b.pageSize === 100);

    console.log("\n## permissions");
    ok("HR can use it", (await page(th, "view=ACTIVE")).s === 200);
    ok("an Employee cannot (403)", (await page(te, "view=ACTIVE")).s === 403);
    ok("no token = 401", (await call("GET", "/admin/users/page?view=ALL")).s === 401);
    ok("HR without an all-company grant does not see the other company's person", (await page(th, "view=ALL&search=UPG-XB")).b.rows.length === 0);
    ok("Admin accounts are not in the employee lists (employeesOnly)", (await page(ta, "view=ALL&search=UPG-ADM")).b.rows.length === 0);
    ok("nothing was changed by reading (statuses intact)", (await q(`select count(*)::int n from users where "employeeCode" like 'UPG-P%' and status::text in ('SUSPENDED','INVITED','CANDIDATE')`))[0].n === 3);
  } finally { await wipe().catch((e) => console.log("wipe", e.message)); await db.end(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
