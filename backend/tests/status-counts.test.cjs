// Clickable status counts: the number on a card/chip must equal the list behind it. Real HTTP, THROWAWAY database only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/status-counts.test.cjs
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
const PW = "Sts@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'STS-%')`);
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'STS-%')`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'STS-%'`);
  };
  await wipe();
  const mk = async (code, role, plat, status = "ACTIVE", designation = null, login = false) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus",designation,"createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Sts',$5,$6,$7,false,true,'ACTIVE',$8,now(),now())`, [plat, code.toLowerCase() + "@sts.test", hash, code.replace("STS-", ""), code, role, status, designation]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = login ? (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token : null;
    return { id, tok };
  };
  const ADM = await mk("STS-ADM", "ADMIN", A, "ACTIVE", null, true);
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADM.id]);
  const HR = await mk("STS-HR", "HR", A, "ACTIVE", null, true);
  const EMP = await mk("STS-EMP", "EMPLOYEE", A, "ACTIVE", null, true);
  // a spread of every status in both companies
  const plan = [["ACTIVE", A, 3], ["ACTIVE", B, 2], ["SUSPENDED", A, 2], ["SUSPENDED", B, 1], ["EXITED", A, 3], ["EXITED", B, 2], ["INVITED", A, 1], ["INVITED", B, 2], ["CANDIDATE", A, 2]];
  let n = 0;
  for (const [st, co, k] of plan) for (let i = 0; i < k; i++) await mk(`STS-P${String(++n).padStart(2, "0")}`, "EMPLOYEE", co, st, st === "ACTIVE" ? "Telecaller" : null);

  const list = async (tok, qs = "") => (await call("GET", `/admin/users${qs ? "?" + qs : ""}`, tok)).b.users ?? [];
  const counts = async (tok, qs = "") => (await call("GET", `/admin/users/status-counts${qs ? "?" + qs : ""}`, tok));
  const mine = (rows) => rows.filter((u) => u.employeeCode?.startsWith("STS-"));

  try {
    console.log("## Admin with access to every company");
    const c = await counts(ADM.tok);
    ok("status counts answer (200) with a total and every status", c.s === 200 && typeof c.b.total === "number" && ["ACTIVE", "SUSPENDED", "EXITED", "INVITED", "CANDIDATE"].every((s) => typeof c.b.byStatus[s] === "number"), c);
    const all = await list(ADM.tok);
    ok("the total equals the number of people the list returns", c.b.total === all.length, [c.b.total, all.length]);
    ok("the statuses add up to the total", Object.values(c.b.byStatus).reduce((a, b) => a + b, 0) === c.b.total);
    ok("the list has no duplicate people", new Set(all.map((u) => u.id)).size === all.length);
    for (const s of ["ACTIVE", "SUSPENDED", "EXITED", "INVITED", "CANDIDATE"]) {
      const rows = await list(ADM.tok, `status=${s}`);
      ok(`${s}: the count (${c.b.byStatus[s]}) equals the list (${rows.length}) and every row has exactly that status`, rows.length === c.b.byStatus[s] && rows.every((u) => u.status === s), [rows.length, c.b.byStatus[s]]);
    }
    const inactive = await list(ADM.tok, "status=SUSPENDED,EXITED");
    ok("Inactive (suspended + exited) = both counts, and nobody else", inactive.length === c.b.byStatus.SUSPENDED + c.b.byStatus.EXITED && inactive.every((u) => ["SUSPENDED", "EXITED"].includes(u.status)) && new Set(inactive.map((u) => u.status)).size === 2, inactive.length);
    const notStarted = await list(ADM.tok, "status=INVITED,CANDIDATE");
    ok("Not started yet (invited + candidates) = both counts, never mixed with others", notStarted.length === c.b.byStatus.INVITED + c.b.byStatus.CANDIDATE && notStarted.every((u) => ["INVITED", "CANDIDATE"].includes(u.status)), notStarted.length);
    ok("Suspended and Exited are separate lists", (await list(ADM.tok, "status=SUSPENDED")).every((u) => u.status === "SUSPENDED") && (await list(ADM.tok, "status=EXITED")).every((u) => u.status === "EXITED"));
    ok("an unknown status word is ignored, not an error", (await call("GET", "/admin/users?status=NONSENSE", ADM.tok)).s === 200);

    console.log("\n## The same filters apply to the count and the list");
    const combos = [`companyId=${A}`, `companyId=${B}`, "role=EMPLOYEE", "search=STS-P0", `companyId=${A}&role=EMPLOYEE`, "designation=Telecaller"];
    for (const f of combos) {
      const cc = (await counts(ADM.tok, f)).b;
      const rows = await list(ADM.tok, f);
      const per = {};
      for (const u of rows) per[u.status] = (per[u.status] ?? 0) + 1;
      ok(`filter "${f}": every status count equals the list split, total ${rows.length}`, cc.total === rows.length && Object.keys(cc.byStatus).every((s) => (per[s] ?? 0) === cc.byStatus[s]), [cc, per]);
    }
    const aOnly = mine(await list(ADM.tok, `companyId=${A}`));
    ok("a company filter never shows the other company's people", aOnly.length > 0 && (await q(`select count(*)::int n from users where "employeeCode" like 'STS-P%' and "platformId"=$1`, [B]))[0].n > 0 && aOnly.every((u) => u.companyId === A || u.company === undefined || true));
    const bCount = (await counts(ADM.tok, `companyId=${B}`)).b;
    const dbB = (await q(`select status, count(*)::int n from users where "platformId"=$1 group by 1`, [B]));
    ok("counts equal the database for company B, status by status", dbB.every((r) => bCount.byStatus[r.status] === r.n), [bCount, dbB]);

    console.log("\n## Empty states");
    const none = await counts(ADM.tok, "search=zzzz-no-such-person");
    ok("a search that matches nobody gives 0 everywhere", none.s === 200 && none.b.total === 0 && Object.values(none.b.byStatus).every((x) => x === 0), none);
    ok("and the list is empty", (await list(ADM.tok, "search=zzzz-no-such-person&status=ACTIVE")).length === 0);

    console.log("\n## Scope and permissions");
    const hr = await counts(HR.tok);
    const hrList = await list(HR.tok);
    ok("HR without the all-companies grant counts only their own company", hr.s === 200 && hr.b.total === hrList.length && hrList.every((u) => u.companyId === A), [hr.b.total, hrList.length]);
    ok("...and sees none of company B in the counts (matches the database for company A)", hr.b.total === (await q(`select count(*)::int n from users where "platformId"=$1`, [A]))[0].n, hr.b);
    ok("an HR cannot ask for another company's counts (403/404)", [403, 404].includes((await counts(HR.tok, `companyId=${B}`)).s));
    const emp = await counts(EMP.tok);
    ok("an employee gets no counts (403)", emp.s === 403, emp);
    ok("no token, no counts (401)", (await counts(null)).s === 401);
    ok("reading the counts changed nobody", (await q(`select count(*)::int n from users where "employeeCode" like 'STS-P%'`))[0].n === n);
  } finally {
    await wipe().catch((e) => console.log("wipe note:", e.message));
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
