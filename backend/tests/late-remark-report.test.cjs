// Late Remark in the Attendance report (and My History): arrival classification, late duration, the reason, the Late/Half Day filter and who may see what.
// Disposable database only (see _guard.cjs). No migration needed: it reads existing attendance data and the existing late-remark table.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/late-remark-report.test.cjs
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
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 380))); };
const PW = "Lat@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const AV = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const AVN = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'LAT-%')`;
    await q(`delete from late_remarks where "userId" in ${ids}`);
    await q(`delete from work_sessions where "userId" in ${ids}`);
    await q(`delete from company_access where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'LAT-%'`);
  };
  await wipe();
  const login = async (code) => (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
  const mk = async (code, role, platformId, reportsToId = null) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","reportsToId","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Lat',$5,$6,'ACTIVE',false,true,'ACTIVE',$7,'2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@lat.test", hash, code.replace("LAT-", "T"), code, role, reportsToId]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    return { id, tok: await login(code) };
  };
  const M = await mk("LAT-M", "MANAGER", AV);
  const P1 = await mk("LAT-P1", "EMPLOYEE", AV, M.id); // 09:45 on time
  const P2 = await mk("LAT-P2", "EMPLOYEE", AV, M.id); // 09:46 late, with a reason
  const P3 = await mk("LAT-P3", "EMPLOYEE", AV, M.id); // 10:15 late, NO reason
  const P4 = await mk("LAT-P4", "EMPLOYEE", AV, M.id); // 10:16 half day
  const P5 = await mk("LAT-P5", "EMPLOYEE", AV, M.id); // never checked in: absent
  const X = await mk("LAT-X", "EMPLOYEE", AV);         // not M's report
  const HR = await mk("LAT-HR", "HR", AV);
  const HRB = await mk("LAT-HRB", "HR", AVN);
  const EB = await mk("LAT-EB", "EMPLOYEE", AVN);       // another company, checked in 09:50
  const EBB = await mk("LAT-EBB", "EMPLOYEE", AVN);     // another company, 09:40 (so that company was tracking)
  const HRA = await mk("LAT-HRA", "HR", AV);            // gets an assignment to company B below
  const DAY = "2026-10-28";
  const ist = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return new Date(Date.UTC(2026, 9, 28, h, m) - 330 * 60_000).toISOString(); };
  const seed = async (u, plat, inAt, outAt) => (await q(`insert into work_sessions (id,"platformId","userId",date,"loginAt","logoutAt",status,"productiveSeconds","breakSeconds","meetingSeconds","wasLateLogin","lateByMinutes","autoClosed","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3::date,$4,$5,'COMPLETED',$6,0,0,false,0,false,now(),now()) returning id`, [plat, u.id, DAY, ist(inAt), ist(outAt), 8 * 3600]))[0].id;
  await seed(P1, AV, "09:45", "18:00");
  const s2 = await seed(P2, AV, "09:46", "18:00");
  await seed(P3, AV, "10:15", "18:00");
  await seed(P4, AV, "10:16", "18:00");
  await seed(EB, AVN, "09:50", "18:00");
  await seed(EBB, AVN, "09:40", "18:00");
  await q(`insert into late_remarks (id,"platformId","userId","sessionId",remark,"lateByMinutes","createdAt") values (gen_random_uuid(),$1,$2,$3,'Bus broke down',1,now())`, [AV, P2.id, s2]);

  const rep = (tok, extra = "") => call("GET", `/team-attendance/attendance?from=${DAY}&to=${DAY}${extra}`, tok);
  const row = (res, u) => res.b.rows?.find((r) => r.userId === u.id);

  console.log("\n## 1. Classification of the four boundary check-ins");
  const m = await rep(M.tok);
  ok("the manager's report loads (200)", m.s === 200, m);
  ok("09:45 = On time", row(m, P1)?.arrival === "ON_TIME", row(m, P1));
  ok("09:46 = Late, 1 minute after 09:45", row(m, P2)?.arrival === "LATE" && row(m, P2).arrivalMinutes === 1, row(m, P2));
  ok("10:15 = Late, 30 minutes after 09:45", row(m, P3)?.arrival === "LATE" && row(m, P3).arrivalMinutes === 30, row(m, P3));
  ok("10:16 = Half Day, 31 minutes after 09:45", row(m, P4)?.arrival === "HALF_DAY" && row(m, P4).arrivalMinutes === 31, row(m, P4));
  ok("no check-in on a day the company was tracking = Absent", row(m, P5)?.arrival === "ABSENT" && row(m, P5).arrivalMinutes === null, row(m, P5));
  ok("the original check-in time is on the row, unchanged", row(m, P2).loginAt === ist("09:46") || new Date(row(m, P2).loginAt).getTime() === new Date(ist("09:46")).getTime(), row(m, P2).loginAt);

  console.log("\n## 2. The reason, and no invented reasons");
  ok("the reason the employee typed is on the row", row(m, P2).lateReason === "Bus broke down", row(m, P2));
  ok("a late person who gave no reason has none (the screen says 'No remark provided')", row(m, P3).lateReason === null && row(m, P4).lateReason === null);
  ok("an on-time person has no reason either", row(m, P1).lateReason === null);

  console.log("\n## 3. Existing columns and rules are untouched");
  const plain = row(m, P2);
  ok("the existing Status / Late arrival fields are still there with their own rules", "status" in plain && "statusLabel" in plain && "lateMinutes" in plain && "earlyDepartureMinutes" in plain && "workedHours" in plain && "tasksCompleted" in plain, Object.keys(plain));
  const noFilter = (await rep(M.tok)).b.rows.length;
  ok("the report still lists everyone (5 reports + the manager) with no filter", noFilter >= 5, noFilter);

  console.log("\n## 4. The Late / Half Day filter");
  const names = (res) => res.b.rows.map((r) => r.employeeCode).sort();
  const f1 = await rep(M.tok, "&arrival=LATE_OR_HALF");
  ok("Late and Half Day together = P2, P3, P4", JSON.stringify(names(f1).filter((c) => c.startsWith("LAT-P"))) === JSON.stringify(["LAT-P2", "LAT-P3", "LAT-P4"]) && f1.b.rows.every((r) => r.arrival === "LATE" || r.arrival === "HALF_DAY"), names(f1));
  ok("Late only = P2, P3", JSON.stringify(names(await rep(M.tok, "&arrival=LATE")).filter((c) => c.startsWith("LAT-P"))) === JSON.stringify(["LAT-P2", "LAT-P3"]));
  ok("Half Day only = P4", JSON.stringify(names(await rep(M.tok, "&arrival=HALF_DAY"))) === JSON.stringify(["LAT-P4"]));
  ok("On time only = P1 (and nobody late)", names(await rep(M.tok, "&arrival=ON_TIME")).includes("LAT-P1") && (await rep(M.tok, "&arrival=ON_TIME")).b.rows.every((r) => r.arrival === "ON_TIME"));
  ok("Absent only = P5", JSON.stringify(names(await rep(M.tok, "&arrival=ABSENT"))) === JSON.stringify(["LAT-P5"]));
  ok("it combines with the existing filters (person)", (await rep(M.tok, `&arrival=LATE&userId=${P2.id}`)).b.rows.length === 1 && (await rep(M.tok, `&arrival=LATE&userId=${P1.id}`)).b.rows.length === 0);
  ok("a bad filter value is a 400, not a server error", (await rep(M.tok, "&arrival=NOPE")).s === 400);
  ok("the existing Status filter still works next to it", (await rep(M.tok, "&status=ABSENT")).b.rows.every((r) => r.status === "ABSENT"));

  console.log("\n## 5. Who sees whom");
  ok("the manager sees only people who report to them", names(m).every((c) => ["LAT-P1", "LAT-P2", "LAT-P3", "LAT-P4", "LAT-P5", "LAT-M"].includes(c)) && !names(m).includes("LAT-X"), names(m));
  const h = await rep(HR.tok);
  ok("HR sees their company (including people not under the manager)", names(h).includes("LAT-X") && names(h).includes("LAT-P2"));
  ok("HR does not see another company without an assignment", !names(h).some((c) => c === "LAT-EB" || c === "LAT-EBB"), names(h));
  ok("HR of the other company sees only their own company", names(await rep(HRB.tok)).includes("LAT-EB") && !names(await rep(HRB.tok)).includes("LAT-P2"));
  const rb = await rep(HRB.tok);
  ok("the other company's late person is classified in their own report", row(rb, EB)?.arrival === "LATE" && row(rb, EB).arrivalMinutes === 5, row(rb, EB));
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,$2,now())`, [HRA.id, AVN]);
  const ha = await rep(HRA.tok);
  ok("HR assigned a second company now sees both companies", names(ha).includes("LAT-P2") && names(ha).includes("LAT-EB"), names(ha));
  ok("employees cannot open the team report (403)", (await rep(P2.tok)).s === 403);
  ok("no sign-in = 401", (await call("GET", `/team-attendance/attendance?from=${DAY}&to=${DAY}`)).s === 401);

  console.log("\n## 6. An employee sees their own late remark (My History)");
  const hist = async (tok) => (await call("GET", `/tracker/history?from=${DAY}&to=${DAY}`, tok)).b.rows?.find((r) => r.date === DAY);
  const h2 = await hist(P2.tok), h3 = await hist(P3.tok), h4 = await hist(P4.tok), h1 = await hist(P1.tok);
  ok("on time: classified On time", h1?.arrival === "ON_TIME", h1);
  ok("late with a reason: Late, 1 minute, the reason they typed", h2?.arrival === "LATE" && h2.arrivalMinutes === 1 && h2.lateRemark === "Bus broke down", h2);
  ok("late without a reason: Late and no reason (the page shows 'No remark provided')", h3?.arrival === "LATE" && h3.arrivalMinutes === 30 && !h3.lateRemark, h3);
  ok("half day: Half Day, 31 minutes", h4?.arrival === "HALF_DAY" && h4.arrivalMinutes === 31, h4);
  ok("an employee's history has only their own days", (await call("GET", `/tracker/history?from=${DAY}&to=${DAY}`, P2.tok)).b.rows.every((r) => r.date === DAY));

  console.log("\n## 7. Today: nobody is Absent while the day is still going");
  const today = (await call("GET", "/tracker/timesheet", HR.tok)).b.today;
  const t = await call("GET", `/team-attendance/attendance?from=${today}&to=${today}`, HR.tok);
  ok("no one is called Absent today", t.s === 200 && t.b.rows.every((r) => r.arrival !== "ABSENT"), t.b.rows?.filter((r) => r.arrival === "ABSENT").length);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
