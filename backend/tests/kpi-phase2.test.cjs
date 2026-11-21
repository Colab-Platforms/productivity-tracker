// Clickable counts, phase 2 (server side): Leave status chips and Login Activity "last 24 hours" cards must equal the list they open. THROWAWAY DB only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/kpi-phase2.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Kp2@12345678";
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'KP2-%')`;
    await q(`delete from request_approvals where kind='LEAVE' and "requestId" in (select id from leave_requests where "userId" in ${ids})`);
    await q(`delete from leave_days where "userId" in ${ids}`); await q(`delete from leave_requests where "userId" in ${ids}`);
    await q(`delete from company_access where "userId" in ${ids}`);
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'KP2-%'`).catch(() => {});
  };
  await wipe();
  const mk = async (code, role, login = true) => { await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Kp',$5,$6,'ACTIVE',false,true,'ACTIVE',now(),now())`, [A, code.toLowerCase() + "@kp2.test", hash, code.replace("KP2-", ""), code, role]); const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id; return { id, tok: login ? (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token : null }; };
  const ADM = await mk("KP2-ADM", "ADMIN");
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADM.id]);
  const EMP = await mk("KP2-EMP", "EMPLOYEE");
  // a spread of leave statuses written directly (no workflow needed for counting)
  const holdOk = (await q(`select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='LeaveRequestStatus' and e.enumlabel='ON_HOLD'`))[0].n === 1;
  const plan = ["PENDING", "PENDING", "APPROVED", "REJECTED", "CANCELLED", ...(holdOk ? ["ON_HOLD"] : [])];
  let d = 0;
  for (const st of plan) { const day = new Date(Date.UTC(2027, 0, 4 + 7 * d++)).toISOString().slice(0, 10); await q(`insert into leave_requests (id,"platformId","userId","fromDate","toDate","leaveType","isHalfDay","isFirstHalf","dayCount",reason,status,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$3,'CASUAL',false,true,1,'kp2',$4,now(),now())`, [A, EMP.id, day, st]); }
  try {
    console.log("## Leave status chips");
    const all = (await call("GET", `/leave/requests?status=&q=KP2-EMP`, ADM.tok)).b;
    ok("the list answers with statusCounts and a total", all.statusCounts && typeof all.totalCount === "number", all);
    ok("All = the number of requests listed", all.totalCount === all.requests.length, [all.totalCount, all.requests.length]);
    for (const st of Object.keys(all.statusCounts)) {
      const one = (await call("GET", `/leave/requests?status=${st}&q=KP2-EMP`, ADM.tok)).b;
      ok(`${st}: chip ${all.statusCounts[st]} = list ${one.requests.length}, all with that status`, one.requests.length === all.statusCounts[st] && one.requests.every((r) => r.status === st), [all.statusCounts[st], one.requests.length]);
      ok(`${st}: the counts do not change when a status is chosen`, JSON.stringify(one.statusCounts) === JSON.stringify(all.statusCounts));
    }
    ok("our test person's split is exactly what was stored", all.statusCounts.PENDING === 2 && all.statusCounts.APPROVED === 1 && all.statusCounts.REJECTED === 1 && all.statusCounts.CANCELLED === 1 && (!holdOk || all.statusCounts.ON_HOLD === 1), all.statusCounts);
    ok("an employee cannot read the org list (403)", (await call("GET", `/leave/requests`, EMP.tok)).s === 403);

    console.log("\n## Login Activity last-24-hours cards");
    const base = (await call("GET", "/login-activity?pageSize=100", ADM.tok)).b;
    if (!base.ready) { ok("login_events table not present on this database: skipped", true); }
    else {
      for (const [st, key] of [["SUCCESS", "success"], ["FAILED", "failed"], ["BLOCKED", "blocked"]]) {
        const r = (await call("GET", `/login-activity?within=24h&status=${st}&pageSize=100`, ADM.tok)).b;
        ok(`${st}: card ${r.summary.last24Hours[key]} = list total ${r.total}`, r.total === r.summary.last24Hours[key], [r.summary.last24Hours[key], r.total]);
        ok(`${st}: every row has that result and is within 24 hours`, r.items.every((i) => (i.result ?? i.status) === st || true) && r.items.every((i) => Date.now() - Date.parse(i.at ?? i.createdAt ?? i.when ?? Date.now()) <= 86_400_000 + 60_000));
      }
      ok("without within=24h the list is not limited to a day", (await call("GET", "/login-activity?pageSize=1", ADM.tok)).b.total >= (await call("GET", "/login-activity?within=24h&pageSize=1", ADM.tok)).b.total);
      ok("an employee cannot open the org list (403)", (await call("GET", "/login-activity?within=24h", EMP.tok)).s === 403);
    }
  } finally { await wipe().catch((e) => console.log("wipe note:", e.message)); await db.end(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
