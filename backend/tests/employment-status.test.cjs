// Employment status: Active / Exited / Terminated / Absconded. Real HTTP, THROWAWAY database only. Proves BEFORE and AFTER migration
// 20261122100000_user_status_terminated_absconded (the migration is applied by this script part-way; to re-run, recreate the throwaway database).
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/employment-status.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Est@12345678";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'EST-%')`);
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'EST-%')`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'EST-%'`);
  };
  await wipe();
  const mk = async (code, role, status = "ACTIVE", login = false) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Est',$4,$4,$5,$6,false,true,'ACTIVE',now(),now())`, [A, code.toLowerCase() + "@x.test", hash, code, role, status]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    return { id, tok: login ? (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token : null };
  };
  const stat = async (id) => (await q(`select status::text s, "exitDate" d from users where id=$1`, [id]))[0];
  const hasNew = async () => (await q(`select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='UserStatus' and e.enumlabel in ('TERMINATED','ABSCONDED')`))[0].n === 2;
  try {
    ok("starts BEFORE the migration (no TERMINATED / ABSCONDED in the database)", !(await hasNew()));
    const ADM = await mk("EST-ADM", "ADMIN", "ACTIVE", true);
    await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADM.id]);
    const HR = await mk("EST-HR", "HR", "ACTIVE", true);
    const EMP = await mk("EST-EMP", "EMPLOYEE", "ACTIVE", true);
    const P1 = await mk("EST-P1", "EMPLOYEE"); const P2 = await mk("EST-P2", "EMPLOYEE"); const LEG = await mk("EST-LEG", "EMPLOYEE", "SUSPENDED");
    const edit = (tok, id, body) => call("PATCH", `/admin/users/${id}`, tok, body);

    console.log("## BEFORE the migration: nothing breaks");
    ok("the people list loads", (await call("GET", "/admin/users", ADM.tok)).s === 200);
    const c0 = await call("GET", "/admin/users/status-counts", ADM.tok); ok("status counts load", c0.s === 200 && c0.b.byStatus.SUSPENDED >= 1, c0.b);
    ok("filtering by Terminated answers 200 (no crash)", (await call("GET", "/admin/users?status=TERMINATED", ADM.tok)).s === 200);
    ok("the group filter with the new words still works", (await call("GET", "/admin/users?status=SUSPENDED,EXITED,TERMINATED,ABSCONDED", ADM.tok)).s === 200);
    ok("the shared HR filter by Absconded does not crash", (await call("GET", "/hr-filters/options?status=ABSCONDED", ADM.tok)).s < 500);
    const t0 = await edit(ADM.tok, P1.id, { status: "TERMINATED" }); ok("choosing Terminated is refused cleanly (503: not set up yet), nothing changes", t0.s === 503 && (await stat(P1.id)).s === "ACTIVE", t0);
    const s0 = await edit(ADM.tok, P1.id, { status: "SUSPENDED" }); ok("choosing Suspended is refused (400)", s0.s === 400, s0);
    const i0 = await edit(ADM.tok, P1.id, { status: "INVITED" }); ok("choosing Invited is refused (400)", i0.s === 400, i0);
    const e0 = await edit(ADM.tok, P1.id, { status: "EXITED" }); const s1 = await stat(P1.id); ok("Exited works and sets the exit date", e0.s === 200 && s1.s === "EXITED" && !!s1.d, [e0, s1]);
    ok("an Exited person cannot sign in", (await call("POST", "/auth/login", null, { email: "EST-P1", password: PW })).s === 403);
    const keep = await edit(ADM.tok, LEG.id, { status: "SUSPENDED", firstName: "Renamed" }); ok("a legacy Suspended person can be edited while the status stays unchanged", keep.s === 200 && (await stat(LEG.id)).s === "SUSPENDED", keep);
    ok("a legacy Suspended person still cannot sign in", (await call("POST", "/auth/login", null, { email: "EST-LEG", password: PW })).s === 403);
    const dd = (await call("GET", `/admin/employees/dropdowns?companyId=${A}`, ADM.tok)).b;
    ok("the dropdown lists exactly Active, Exited, Terminated, Absconded", JSON.stringify(dd.statuses) === JSON.stringify(["ACTIVE", "EXITED", "TERMINATED", "ABSCONDED"]), dd.statuses);
    const nu = await call("POST", "/admin/users", ADM.tok, { firstName: "New", lastName: "Person", email: "est-new@x.test", password: "Newpass@1234", role: "EMPLOYEE", companyId: A, employeeCode: "EST-NEW" });
    ok("a new account is created ACTIVE (not Invited)", nu.s < 300 && (await q(`select status::text s from users where "employeeCode"='EST-NEW'`))[0]?.s === "ACTIVE", nu);

    console.log("\n## apply the migration");
    await q(`ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'TERMINATED'`);
    await q(`ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'ABSCONDED'`);
    ok("the database now knows both values", await hasNew());
    await sleep(16000);

    console.log("\n## AFTER the migration");
    const tk = await edit(ADM.tok, P2.id, { status: "TERMINATED" }); const s2 = await stat(P2.id);
    ok("Admin can set Terminated: saved, exit date set", tk.s === 200 && s2.s === "TERMINATED" && !!s2.d, [tk, s2]);
    ok("a Terminated person cannot sign in", (await call("POST", "/auth/login", null, { email: "EST-P2", password: PW })).s === 403);
    const P3 = await mk("EST-P3", "EMPLOYEE", "ACTIVE", true);
    ok("an existing session works before the change", (await call("GET", "/auth/me", P3.tok)).s === 200);
    const ab = await edit(HR.tok, P3.id, { status: "ABSCONDED" }); ok("HR can set Absconded", ab.s === 200 && (await stat(P3.id)).s === "ABSCONDED", ab);
    ok("an existing session of an Absconded person is refused at once", (await call("GET", "/auth/me", P3.tok)).s === 401);
    const back = await edit(ADM.tok, P3.id, { status: "ACTIVE" }); const s3 = await stat(P3.id);
    ok("back to Active: access returns and the exit date is cleared", back.s === 200 && s3.s === "ACTIVE" && s3.d === null && (await call("POST", "/auth/login", null, { email: "EST-P3", password: PW })).s === 200, [back, s3]);
    ok("an Employee cannot change a status (403)", (await edit(EMP.tok, P3.id, { status: "EXITED" })).s === 403);
    ok("nobody can set Invited / Candidate / Suspended any more", (await Promise.all(["INVITED", "CANDIDATE", "SUSPENDED"].map((s) => edit(ADM.tok, P3.id, { status: s })))).every((r) => r.s === 400));
    ok("a made-up status is refused (400)", (await edit(ADM.tok, P3.id, { status: "FIRED" })).s === 400);
    const lt = (await call("GET", "/admin/users?status=TERMINATED", ADM.tok)).b.users ?? [];
    ok("filter Terminated lists exactly the terminated people", lt.length >= 1 && lt.every((u) => u.status === "TERMINATED") && lt.some((u) => u.employeeCode === "EST-P2"), lt.length);
    const c1 = (await call("GET", "/admin/users/status-counts", ADM.tok)).b;
    ok("status counts include Terminated and Absconded and add up", c1.byStatus.TERMINATED >= 1 && c1.byStatus.ABSCONDED === 0 && Object.values(c1.byStatus).reduce((a, b) => a + b, 0) === c1.total, c1);
    ok("the shared HR filter accepts Terminated", (await call("GET", "/hr-filters/options?status=TERMINATED", ADM.tok)).s === 200);
    const aud = await q(`select before, after, "actorId", "createdAt" from audit_logs where "targetUserId"=$1 and module='Employees' order by "createdAt" desc limit 10`, [P2.id]);
    ok("the change is in the Audit log with who, when, before and after", aud.some((r) => r.actorId === ADM.id && JSON.stringify(r.after).includes("TERMINATED") && JSON.stringify(r.before).includes("ACTIVE") && r.createdAt), aud.slice(0, 2));
    const att = await call("GET", "/team-attendance/live", ADM.tok);
    ok("the live board loads and omits Terminated people", att.s === 200 && !JSON.stringify(att.b).includes("EST-P2"), att.s);

    console.log("\n## script: Suspended -> Terminated");
    const env = { ...process.env, ST_DB_URL: process.env.TEST_DATABASE_URL };
    const run = (a) => execFileSync("node", [path.join(__dirname, "..", "scripts", "suspended-to-terminated.cjs"), ...a], { env, encoding: "utf8" });
    const d = run([]); ok("dry run lists the Suspended person and writes nothing", /EST-LEG/.test(d) && (await stat(LEG.id)).s === "SUSPENDED", d);
    const ap = run(["--apply"]); const sl = await stat(LEG.id);
    ok("--apply moves them to Terminated with an exit date", sl.s === "TERMINATED" && !!sl.d, [ap, sl]);
    ok("one audit line per person with before/after", (await q(`select 1 from audit_logs where path='/scripts/suspended-to-terminated' and "targetUserId"=$1 and before::text like '%SUSPENDED%' and after::text like '%TERMINATED%'`, [LEG.id])).length === 1);
    ok("running it again finds nothing", /0 account/.test(run(["--apply"])));
  } finally {
    await wipe().catch(() => {}); await q(`delete from users where "employeeCode"='EST-NEW'`).catch(() => {}); await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
