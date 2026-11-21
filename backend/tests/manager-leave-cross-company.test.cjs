// A manager's leave approval list must show every pending request that NAMES them, whatever company the employee belongs to (half and full day).
// Regression for: a Take Health employee's half-day request, tagged to Faizan (Colab Esports), was missing from his list. Real HTTP, THROWAWAY DB only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/manager-leave-cross-company.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 500))); };
const PW = "Mlc@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from leave_days where "userId" in (select id from users where "employeeCode" like 'MLC-%')`);
    await q(`delete from leave_requests where "userId" in (select id from users where "employeeCode" like 'MLC-%')`);
    await q(`delete from notifications where "userId" in (select id from users where "employeeCode" like 'MLC-%')`);
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'MLC-%')`).catch(() => {});
    await q(`update users set "reportsToId"=null where "employeeCode" like 'MLC-%'`);
    await q(`delete from users where "employeeCode" like 'MLC-%'`);
  };
  await wipe();
  const mk = async (code, role, plat, boss = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Mlc',$4,$5,'ACTIVE',false,true,'ACTIVE',$6,now(),now())`, [plat, code.toLowerCase() + "@x.test", hash, code, role, boss]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const r = await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) });
    return { id, tok: (await r.json()).token };
  };
  try {
    const M = await mk("MLC-MGR", "MANAGER", A);      // "Faizan": a manager in company A
    const M2 = await mk("MLC-MGR2", "MANAGER", A);    // another manager
    const M3 = await mk("MLC-MGR3", "MANAGER", A);    // a manager with nobody
    const HRB = await mk("MLC-HRB", "HR", B);          // HR of the employees' company
    const EC1 = await mk("MLC-EC1", "EMPLOYEE", B, M.id);  // other company, reports to M (half day)
    const EC2 = await mk("MLC-EC2", "EMPLOYEE", B, M.id);  // other company, reports to M (full day)
    const ES = await mk("MLC-ES", "EMPLOYEE", A, M.id);    // same company as M (half day)
    const EO = await mk("MLC-EO", "EMPLOYEE", B, M2.id);   // other company, reports to M2
    const ask = (u, from, to, half) => call("POST", "/leave/requests", u.tok, { from, to, leaveType: "CASUAL", reason: "Personal work", ...(half ? { isHalfDay: true, isFirstHalf: true } : {}) });

    console.log("## requests are created and tagged to the reporting manager");
    const r1 = await ask(EC1, "2026-12-01", "2026-12-01", true), r2 = await ask(ES, "2026-12-02", "2026-12-02", true), r3 = await ask(EC2, "2026-12-03", "2026-12-04", false), r4 = await ask(EO, "2026-12-07", "2026-12-07", true);
    ok("all four requests were submitted", [r1, r2, r3, r4].every((r) => r.s === 200), [r1, r2, r3, r4].map((r) => r.s + " " + JSON.stringify(r.b).slice(0, 80)));
    const rows = await q(`select r."isHalfDay" h, r."platformId"::text p, a."approverIds" a, a.status s, u."employeeCode" c from leave_requests r join users u on u.id=r."userId" join request_approvals a on a.kind='LEAVE' and a."requestId"=r.id where u."employeeCode" like 'MLC-%'`);
    const row = (c) => rows.find((x) => x.c === c);
    ok("the other-company half day is tagged to M (approver id = M's user id), pending", row("MLC-EC1") && row("MLC-EC1").h === true && row("MLC-EC1").a.includes(M.id) && row("MLC-EC1").s === "PENDING" && row("MLC-EC1").p === B, row("MLC-EC1"));
    ok("the other-company full day is tagged to M too", row("MLC-EC2").h === false && row("MLC-EC2").a.includes(M.id));
    ok("the same-company half day is tagged to M", row("MLC-ES").a.includes(M.id));
    ok("the other-company employee of M2 is tagged to M2, not M", row("MLC-EO").a.length === 1 && row("MLC-EO").a[0] === M2.id);

    console.log("\n## the manager's approval list (the bug)");
    const list = await call("GET", "/leave/manager/requests", M.tok);
    const codes = (list.b.pending ?? []).map((r) => r.person.employeeCode).sort();
    ok("M sees the other-company HALF-DAY request", codes.includes("MLC-EC1"), codes);
    ok("M sees the other-company FULL-DAY request", codes.includes("MLC-EC2"), codes);
    ok("M sees the same-company half-day request", codes.includes("MLC-ES"), codes);
    ok("M sees exactly his three and not M2's employee", JSON.stringify(codes) === JSON.stringify(["MLC-EC1", "MLC-EC2", "MLC-ES"]), codes);
    const e1 = list.b.pending.find((r) => r.person.employeeCode === "MLC-EC1");
    ok("the row says half day and carries the person's name and ID", e1 && e1.isHalfDay === true && e1.person.name === "MLC-EC1 Mlc" && !!e1.takenThisYear, e1);
    const ov = await call("GET", "/leave/overview", M.tok);
    ok("the 'waiting for me' badge equals the list (3)", ov.b.awaitingMyLeaveApproval === 3 && list.b.pending.length === 3, [ov.b.awaitingMyLeaveApproval, list.b.pending.length]);

    console.log("\n## leave taken is counted per person, whatever company");
    await q(`insert into leave_days (id,"platformId","userId","date","leaveType","isHalfDay","isFirstHalf","markedById","createdAt") values (gen_random_uuid(),$1,$2,'2026-03-03','CASUAL',false,true,$3,now())`, [B, EC1.id, HRB.id]);
    const again = await call("GET", "/leave/manager/requests", M.tok);
    ok("the other-company employee's earlier leave shows in 'taken this year'", again.b.pending.find((r) => r.person.employeeCode === "MLC-EC1").takenThisYear.total === 1, again.b.pending.find((r) => r.person.employeeCode === "MLC-EC1").takenThisYear);

    console.log("\n## isolation between managers");
    const l2 = (await call("GET", "/leave/manager/requests", M2.tok)).b.pending.map((r) => r.person.employeeCode);
    ok("M2 sees only his own employee's request", JSON.stringify(l2) === JSON.stringify(["MLC-EO"]), l2);
    ok("M3 (nobody reports to him) sees nothing", (await call("GET", "/leave/manager/requests", M3.tok)).b.pending.length === 0);
    ok("an employee cannot open the manager list (403)", (await call("GET", "/leave/manager/requests", EC1.tok)).s === 403);
    const rid = (c) => q(`select r.id from leave_requests r join users u on u.id=r."userId" where u."employeeCode"=$1`, [c]).then((x) => x[0].id);
    ok("M cannot decide M2's employee's request (404)", (await call("POST", `/leave/manager/requests/${await rid("MLC-EO")}/decide`, M.tok, { decision: "APPROVE" })).s === 404);
    ok("M3 cannot decide M's request (404)", (await call("POST", `/leave/manager/requests/${await rid("MLC-EC1")}/decide`, M3.tok, { decision: "APPROVE" })).s === 404);

    console.log("\n## deciding, and nothing else changes");
    const ap = await call("POST", `/leave/manager/requests/${await rid("MLC-EC1")}/decide`, M.tok, { decision: "APPROVE", note: "ok" });
    ok("M approves the other-company half day: it now waits for HR", ap.s === 200 && (await q(`select status::text s from request_approvals where "requestId"=$1`, [await rid("MLC-EC1")]))[0].s === "APPROVED", ap);
    ok("approval writes NO leave day yet (HR is still to decide)", (await q(`select count(*)::int n from leave_days where "userId"=$1 and "date"='2026-12-01'`, [EC1.id]))[0].n === 0);
    const rej = await call("POST", `/leave/manager/requests/${await rid("MLC-EC2")}/decide`, M.tok, { decision: "REJECT", note: "Busy week" });
    ok("M rejects the other-company full day with a reason", rej.s === 200 && (await q(`select status::text s from leave_requests where id=$1`, [await rid("MLC-EC2")]))[0].s === "REJECTED");
    const after = (await call("GET", "/leave/manager/requests", M.tok)).b;
    ok("decided requests leave 'pending' and appear under answered", after.pending.map((r) => r.person.employeeCode).join() === "MLC-ES" && after.answered.length === 2, [after.pending.length, after.answered.length]);
    ok("the HR of the employee's company still sees the request", JSON.stringify((await call("GET", "/leave/requests", HRB.tok)).b).includes("MLC-EC1"));
    ok("reporting lines were not changed by any of this", (await q(`select count(*)::int n from users where "employeeCode" in ('MLC-EC1','MLC-EC2','MLC-ES') and "reportsToId"=$1`, [M.id]))[0].n === 3);
  } finally { await wipe().catch((e) => console.log("wipe", e.message)); await db.end(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
