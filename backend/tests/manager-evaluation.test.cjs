// Manager Evaluation (adjust score / status / productivity for one period) over real HTTP: throwaway DB + test backend (5012) only.
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/manager-evaluation.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
require("./_guard.cjs");
const API = process.env.TEST_API || "http://localhost:5012/api";
const call = async (m, p, t, b) => { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined }); const j = await r.json().catch(() => ({})); return { s: r.status, b: j }; };
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Evl@12345678";
(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id, B = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const T0 = (await q(`select to_char(now(), 'YYYY-MM-DD HH24:MI:SS.US') t`))[0].t; // audit rows are permanent: count only this run's
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'EVL-%')`;
    await q(`delete from daily_tasks where "userId" in ${ids}`).catch(() => {});
    await q(`delete from notifications where "userId" in ${ids}`).catch(() => {});
    await q(`delete from company_access where "userId" in ${ids}`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in ${ids}`).catch(() => {});
    await q(`delete from login_events where "employeeCode" like 'EVL-%'`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'EVL-%'`).catch((e) => console.log("cleanup:", e.message.slice(0, 80)));
  };
  await wipe();
  const mk = async (code, role, plat, boss = null) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Evl',$4,$4,$5,'ACTIVE',false,true,'ACTIVE',$6,now(),now()) returning id`, [plat, code.toLowerCase() + "@evl.test", hash, code, role, boss]))[0].id;
  const adm = await mk("EVL-AD", "ADMIN", A); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [adm]);
  const m1 = await mk("EVL-M1", "MANAGER", A), m2 = await mk("EVL-M2", "MANAGER", A), hr = await mk("EVL-HR", "HR", A), hrB = await mk("EVL-HRB", "HR", B);
  const e1 = await mk("EVL-E1", "EMPLOYEE", A, m1), e2 = await mk("EVL-E2", "EMPLOYEE", A, m2), eb = await mk("EVL-EB", "EMPLOYEE", B, null);
  const T = {}; for (const c of ["AD", "M1", "M2", "HR", "HRB", "E1"]) T[c] = (await call("POST", "/auth/login", null, { email: "EVL-" + c, password: PW })).b.token;
  const today = (await call("GET", "/tasks/previous", T.M1)).b.today;
  // E1 has two approved, completed, unrated tasks today => Awaiting evaluation (completion counted, rating not given yet)
  for (const who of [e1, e1, e2]) await q(`insert into daily_tasks (id,"platformId","userId",date,title,weight,status,"approvalStatus","approvedById","approvedAt","completedAt","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,'Task for evaluation','MEDIUM','COMPLETED','APPROVED',$4,now(),now(),now(),now())`, [A, who, today, m1]);
  const Q = `from=${today}&to=${today}`;
  const row = async (tok, uid) => ((await call("GET", `/team-attendance/productivity?${Q}`, tok)).b.people ?? []).find((p) => p.userId === uid);
  const taskRows = async () => JSON.stringify(await q(`select id, title, status, "approvalStatus", outcome, to_char("updatedAt",'HH24:MI:SS.US') u from daily_tasks where "userId" in ($1,$2) order by id`, [e1, e2]));
  const rowsBefore = await taskRows();

  console.log("\n## before any adjustment");
  const base = await row(T.M1, e1);
  ok("the system figures exist (Awaiting evaluation, completion counted)", base && base.weighted.status === "AWAITING_EVALUATION" && base.weighted.completionPercent === 100 && base.evaluation === null, base?.weighted);
  const sysPct = base.weighted.percent, sysProd = base.overallPercent;
  ok("before anything is saved the state is Not Evaluated for everyone", base.evalState.state === "NOT_EVALUATED" && base.evalState.count === 0 && (await row(T.M2, e2)).evalState.state === "NOT_EVALUATED" && (await row(T.HR, e1)).evalState.state === "NOT_EVALUATED", base.evalState);

  console.log("\n## who may adjust");
  const body = (o = {}) => ({ userId: e1, from: today, to: today, score: 82.5, status: "FINAL", productivity: 91, reason: "Strong delivery reviewed with the team", ...o });
  ok("an employee cannot", (await call("POST", "/team-attendance/evaluation", T.E1, body())).s === 403);
  ok("HR cannot (403, with a clear message)", await (async () => { const r = await call("POST", "/team-attendance/evaluation", T.HR, body()); return r.s === 403 && /Only a manager/.test(r.b.error); })());
  ok("Admin cannot", (await call("POST", "/team-attendance/evaluation", T.AD, body())).s === 403);
  ok("another manager cannot adjust someone outside their reporting scope (404)", (await call("POST", "/team-attendance/evaluation", T.M2, body())).s === 404);
  ok("a manager cannot adjust themselves", (await call("POST", "/team-attendance/evaluation", T.M1, body({ userId: m1 }))).s === 403);
  ok("a person in another company is out of reach (404)", (await call("POST", "/team-attendance/evaluation", T.M1, body({ userId: eb }))).s === 404);
  ok("no token = 401", (await call("POST", "/team-attendance/evaluation", null, body())).s === 401);
  ok("nothing was saved by the refusals", (await q(`select count(*)::int n from audit_logs where module='Evaluation' and "createdAt" >= $1::timestamp`, [T0]))[0].n === 0);

  console.log("\n## validation");
  const bad = async (o, label) => { const r = await call("POST", "/team-attendance/evaluation", T.M1, body(o)); ok(label, r.s === 400 && typeof r.b.error === "string" && !/Something went wrong/.test(r.b.error), r); };
  await bad({ reason: "" }, "a reason is required");
  await bad({ reason: "abc" }, "a 3-character reason is refused");
  await bad({ reason: "x".repeat(301) }, "a 301-character reason is refused");
  await bad({ score: 101 }, "score above 100 refused");
  await bad({ score: -1 }, "negative score refused");
  await bad({ score: "abc" }, "non-numeric score refused");
  await bad({ productivity: 150 }, "productivity above 100 refused");
  await bad({ status: "GREAT" }, "an invented status is refused (only the four existing ones)");
  await bad({ from: "2020-01-01", to: today }, "a period that is not the one shown is refused");
  await bad({ to: "2999-01-01" }, "a future end date is refused");
  ok("still nothing saved", (await q(`select count(*)::int n from audit_logs where module='Evaluation' and "createdAt" >= $1::timestamp`, [T0]))[0].n === 0);

  console.log("\n## saving an adjustment");
  const saved = await call("POST", "/team-attendance/evaluation", T.M1, body());
  ok("the manager saves score, status, productivity and a reason", saved.s === 200 && saved.b.score === 82.5 && saved.b.status === "FINAL" && saved.b.productivity === 91, saved);
  const after = await row(T.M1, e1);
  ok("first save: the state becomes Evaluated (saved once, by this manager)", after.evalState.state === "EVALUATED" && after.evalState.count === 1 && after.evalState.lastByName === "Evl EVL-M1" && !!after.evalState.lastAt, after.evalState);
  ok("the table now shows the adjusted values as the effective ones", after.weighted.percent === 82.5 && after.weighted.status === "FINAL" && after.overallPercent === 91 && after.weighted.provisional === false, [after.weighted.percent, after.weighted.status, after.overallPercent]);
  ok("the system values are kept beside them", after.evaluation.original.status === "AWAITING_EVALUATION" && after.evaluation.original.score === sysPct && after.evaluation.original.productivity === sysProd && after.weighted.adjusted.original.status === "AWAITING_EVALUATION", after.evaluation);
  ok("the underlying calculation is untouched (completion %, counts, ratings)", after.weighted.completionPercent === base.weighted.completionPercent && after.weighted.completed === base.weighted.completed && after.weighted.tasks === base.weighted.tasks && after.weighted.awaitingRating === base.weighted.awaitingRating);
  ok("HR sees the same effective values and the adjustment info", await (async () => { const r = await row(T.HR, e1); return r.weighted.percent === 82.5 && r.evaluation?.reason === "Strong delivery reviewed with the team"; })());
  ok("Admin sees them too", (await row(T.AD, e1)).weighted.percent === 82.5);
  ok("another employee in the same report is unaffected", (await row(T.AD, e2)).evaluation === null);
  ok("an adjustment for a DIFFERENT period does not show (exact dates only)", await (async () => { const y = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10); const r = (await call("GET", `/team-attendance/productivity?from=${y}&to=${today}`, T.M1)).b.people.find((p) => p.userId === e1); return r.evaluation === null; })());
  ok("the employee's task records are byte-for-byte unchanged", (await taskRows()) === rowsBefore);

  console.log("\n## other screens use the effective values");
  const rep = await call("GET", `/reports?${Q}&groupBy=person`, T.M1);
  const rp = (rep.b.people ?? rep.b.rows ?? []).find((p) => p.userId === e1);
  ok("Reports shows the adjusted score and status for that period", rp && rp.weighted.percent === 82.5 && rp.weighted.status === "FINAL", rp?.weighted);
  const hist = await call("GET", `/tracker/history?${Q}`, T.E1);
  ok("the employee's own My History summary uses it too", hist.b.summary?.weighted?.percent === 82.5 && hist.b.summary.weighted.status === "FINAL", hist.b.summary?.weighted);
  const wbk = await call("GET", `/team-attendance/team-report?${Q}`, T.M1);
  ok("the team workbook data carries the effective performance", wbk.s === 200 && wbk.b.performance?.[e1]?.percent === 82.5, wbk.b.performance?.[e1]);

  console.log("\n## history");
  const hs = await call("GET", `/team-attendance/evaluation/history?userId=${e1}&${Q}`, T.M1);
  const h0 = hs.b.entries?.[0];
  ok("the history holds the original value, the new value, who, when and why", hs.s === 200 && hs.b.entries.length === 1 && h0.before.status === "AWAITING_EVALUATION" && h0.after.score === 82.5 && h0.after.status === "FINAL" && h0.byName === "Evl EVL-M1" && h0.by === m1 && !!h0.at && /Strong delivery/.test(h0.reason), hs);
  ok("HR and Admin can read the history", (await call("GET", `/team-attendance/evaluation/history?userId=${e1}&${Q}`, T.HR)).b.entries?.length === 1 && (await call("GET", `/team-attendance/evaluation/history?userId=${e1}&${Q}`, T.AD)).b.entries?.length === 1);
  ok("another manager and another company's HR cannot read it", (await call("GET", `/team-attendance/evaluation/history?userId=${e1}&${Q}`, T.M2)).s === 404 && (await call("GET", `/team-attendance/evaluation/history?userId=${e1}&${Q}`, T.HRB)).s === 404);
  const al = (await q(`select module, action, "recordType", "targetUserId"::text t, "actorId"::text a, before, after from audit_logs where module='Evaluation' and "createdAt" >= $1::timestamp`, [T0]));
  ok("exactly one audit-log row per save, naming manager and employee", al.length === 1 && al[0].a === m1 && al[0].t === e1 && al[0].before.status === "AWAITING_EVALUATION" && al[0].after.reason, al);
  ok("the audit row cannot be edited or deleted (database trigger)", await (async () => { let blocked = 0; try { await q(`update audit_logs set summary='x' where module='Evaluation' and "createdAt" >= $1::timestamp`, [T0]); } catch { blocked++; } try { await q(`delete from audit_logs where module='Evaluation' and "createdAt" >= $1::timestamp`, [T0]); } catch { blocked++; } return blocked === 2; })());

  console.log("\n## re-adjusting and resetting");
  await call("POST", "/team-attendance/evaluation", T.M1, body({ score: 70, status: "PROVISIONAL", productivity: null, reason: "Rating still pending, lowering" }));
  const second = await row(T.M1, e1);
  ok("saving again (changing an earlier evaluation) makes it Updated", second.evalState.state === "UPDATED" && second.evalState.count === 2, second.evalState);
  ok("a later adjustment replaces the earlier one as the effective value", second.weighted.percent === 70 && second.weighted.status === "PROVISIONAL" && second.weighted.provisional === true && second.overallPercent === sysProd, [second.weighted.percent, second.weighted.status, second.overallPercent]);
  ok("and the original recorded is still the SYSTEM value, not the earlier adjustment", (await call("GET", `/team-attendance/evaluation/history?userId=${e1}&${Q}`, T.M1)).b.entries[0].before.status === "AWAITING_EVALUATION");
  ok("history now lists both, newest first", (await call("GET", `/team-attendance/evaluation/history?userId=${e1}&${Q}`, T.M1)).b.entries.map((e) => e.after.score).join() === "70,82.5");
  const sameAsSystem = await call("POST", "/team-attendance/evaluation", T.M1, body({ score: null, status: "AWAITING_EVALUATION", productivity: sysProd, reason: "Reset to the system values" }));
  ok("sending the system values back resets the adjustment", sameAsSystem.s === 200 && sameAsSystem.b.score === null && sameAsSystem.b.status === null && sameAsSystem.b.productivity === null, sameAsSystem.b);
  const reset = await row(T.M1, e1);
  ok("a reset is another save: still Updated, even though the system values are shown again", reset.evalState.state === "UPDATED" && reset.evalState.count === 3 && reset.evaluation === null, reset.evalState);
  ok("HR and Admin see the same status", (await row(T.HR, e1)).evalState.state === "UPDATED" && (await row(T.AD, e1)).evalState.count === 3);

  console.log("\n## evaluated with NO changed value (review only)");
  const sysE2 = await row(T.M2, e2);
  const rv = await call("POST", "/team-attendance/evaluation", T.M2, { userId: e2, from: today, to: today, score: sysE2.weighted.percent, status: sysE2.weighted.status, productivity: sysE2.overallPercent, reason: "Reviewed, system figures are fair" });
  ok("the manager can save a review that keeps every system value", rv.s === 200 && rv.b.score === null && rv.b.status === null && rv.b.productivity === null, rv);
  const e2After = await row(T.M2, e2);
  ok("the state is Evaluated, the figures are the system ones and there is no 'adjusted' marker", e2After.evalState.state === "EVALUATED" && e2After.evaluation === null && e2After.weighted.percent === sysE2.weighted.percent && e2After.weighted.status === sysE2.weighted.status, [e2After.evalState, e2After.evaluation]);
  ok("it is recorded in the history with the reason", (await call("GET", `/team-attendance/evaluation/history?userId=${e2}&${Q}`, T.M2)).b.entries.length === 1);
  ok("the first manager's evaluation of someone else is unaffected", (await row(T.M1, e1)).evalState.count === 3);
  ok("an evaluation for a different period does not make this period Evaluated", await (async () => { const y = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10); const r = (await call("GET", `/team-attendance/productivity?from=${y}&to=${today}`, T.M2)).b.people.find((p) => p.userId === e2); return r.evalState.state === "NOT_EVALUATED"; })());

  ok("after the reset the table shows the system values again and no adjusted tag", reset.evaluation === null && reset.weighted.status === "AWAITING_EVALUATION" && reset.weighted.percent === sysPct);
  ok("the history still keeps all three entries", (await call("GET", `/team-attendance/evaluation/history?userId=${e1}&${Q}`, T.M1)).b.entries.length === 3);
  ok("task records still unchanged after all of it", (await taskRows()) === rowsBefore);

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
