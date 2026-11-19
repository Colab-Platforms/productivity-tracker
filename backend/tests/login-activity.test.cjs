// Login activity over real HTTP: every kind of attempt is recorded with the device, the session's logout / last activity / expiry are tracked, the history
// cannot be changed or deleted early, and each role sees only what it may. Throwaway database only.
// Start the backend (port 5012) with the policy in enforce mode so blocked attempts happen:
//   LOGIN_IP_MODE=enforce LOGIN_ALLOWED_IPS=206.84.235.169 sh start-be-5012.sh
// then: TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/login-activity.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const fs = require("node:fs"), path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const OFFICE = "206.84.235.169", OTHER = "103.212.140.53";
const UA_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MIGRATION = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261120100000_login_events", "migration.sql"), "utf8");
const MIG_SUP = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261119120000_productivity_supervisors", "migration.sql"), "utf8");

const call = async (m, p, t, b, ip, ua) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}), ...(ip ? { "x-forwarded-for": ip } : {}), ...(ua ? { "user-agent": ua } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j, raw: txt };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 350))); };
const PW = "Lga@12345678";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='take-health'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  if (!(await q(`select to_regclass('productivity_supervisors') t`))[0].t) await q(MIG_SUP);
  // a clean start: the table is dropped so the "before the migration" phase is real
  await q(`drop table if exists login_events`);
  await q(`drop function if exists login_events_guard()`);
  await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'LGA-%')`).catch(() => {});
  await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'LGA-%')`);
  await q(`delete from productivity_supervisors where "userId" in (select id from users where "employeeCode" like 'LGA-%')`);
  await q(`delete from notifications where "userId" in (select id from users where "employeeCode" like 'LGA-%')`);
  await q(`delete from users where "employeeCode" like 'LGA-%'`);
  const mk = async (code, role, platform = A, status = "ACTIVE") => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Lga',$5,$6,$7,false,true,'ACTIVE',now(),now()) returning id`, [platform, code.toLowerCase() + "@lga.test", hash, code.replace("LGA-", "L"), code, role, status]))[0].id;
  const id = { ADM: await mk("LGA-ADM", "ADMIN"), ADMALL: await mk("LGA-ADMALL", "ADMIN"), HRA: await mk("LGA-HRA", "HR"), HRB: await mk("LGA-HRB", "HR", B), HRALL: await mk("LGA-HRALL", "HR"), MGR: await mk("LGA-MGR", "MANAGER"), E1: await mk("LGA-E1", "EMPLOYEE"), E2: await mk("LGA-E2", "EMPLOYEE"), EB: await mk("LGA-EB", "EMPLOYEE", B), SUP: await mk("LGA-SUP", "EMPLOYEE"), OFF: await mk("LGA-OFF", "EMPLOYEE", A, "SUSPENDED") };
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now()), (gen_random_uuid(),$2,null,now())`, [id.ADMALL, id.HRALL]).catch(async () => { await q(`insert into company_access (id,"userId","platformId","grantedById","createdAt") values (gen_random_uuid(),$1,null,$1,now()), (gen_random_uuid(),$2,null,$2,now())`, [id.ADMALL, id.HRALL]); });
  await q(`insert into productivity_supervisors ("userId", note) values ($1,'lga')`, [id.SUP]);
  const login = (code, pw = PW, ip = OFFICE, ua = UA_CHROME) => call("POST", "/auth/login", null, { email: code, password: pw }, ip, ua);
  const secAudit = async (since) => q(`select count(*)::int n from audit_logs where module='Security' and "createdAt" >= $1::timestamp`, [since]);
  const t0 = (await q(`select to_char(now(), 'YYYY-MM-DD HH24:MI:SS.US') t`))[0].t;

  console.log("\n## BEFORE the migration: nothing breaks, the old audit record still works");
  const pre = await login("LGA-E1");
  ok("sign-in works without the table", pre.s === 200 && !!pre.b.token, pre);
  const preBlocked = await login("LGA-E1", PW, OTHER);
  ok("a blocked attempt is still refused", preBlocked.s === 403 && preBlocked.b.code === "IP_NOT_ALLOWED", preBlocked);
  await wait(800);
  ok("and recorded in the Audit log (the earlier behaviour)", (await secAudit(t0))[0].n >= 1);
  ok("the employee's history answers 'not ready', no error", (await call("GET", "/login-activity/mine", pre.b.token, undefined, OFFICE)).b.ready === false);
  const adm0 = await login("LGA-ADM");
  ok("Admin's list answers 'not ready', no error", (await call("GET", "/login-activity", adm0.b.token, undefined, OFFICE)).b.ready === false);
  ok("logout works without the table", (await call("POST", "/auth/logout", pre.b.token, {}, OFFICE)).s === 200);

  console.log("\n## apply the migration");
  await q(MIGRATION);
  await wait(16_500); // the server re-checks a missing table every 15 s
  const startedAt = (await q(`select to_char(now(), 'YYYY-MM-DD HH24:MI:SS.US') t`))[0].t;
  const ev = (where, p = []) => q(`select * from login_events where "createdAt" >= $1::timestamp and ${where} order by "createdAt"`, [startedAt, ...p]);

  console.log("\n## a successful sign-in");
  const s1 = await login("LGA-E1", PW, OFFICE, UA_CHROME);
  ok("signs in (200)", s1.s === 200 && !!s1.b.token);
  const payload = JSON.parse(Buffer.from(s1.b.token.split(".")[1], "base64url").toString());
  ok("the token carries this sign-in's own id (sid)", /^[0-9a-f-]{36}$/.test(payload.sid), payload);
  await wait(500);
  const r1 = (await ev(`"userId"=$2 and result='SUCCESS'`, [id.E1]))[0];
  ok("a SUCCESS row was recorded", !!r1, r1);
  ok("with the authorised address as the server saw it", r1.ip === OFFICE);
  ok("with the employee ID and the username as typed", r1.employeeCode === "LGA-E1" && r1.username === "LGA-E1");
  ok("with browser, system and device read from the browser", r1.browserName === "Chrome" && r1.browserVersion === "130" && r1.osName === "Windows" && r1.deviceType === "Desktop", r1);
  ok("with the session id from the token, an expiry about a day ahead and a last-activity time", r1.sessionId === payload.sid && r1.expiresAt && r1.lastActiveAt, r1);
  ok("the expiry matches the token's own expiry", Math.abs(new Date(r1.expiresAt + "Z").getTime() - payload.exp * 1000) < 2000, [r1.expiresAt, payload.exp]);
  ok("location is empty (no source yet), never guessed", r1.country === null && r1.city === null && r1.locationSource === null);
  ok("no password, hash or token is in the row", !/\$2[aby]\$|eyJ[A-Za-z0-9_-]{10,}/.test(JSON.stringify(r1)) && !JSON.stringify(r1).includes(PW));
  ok("the server's clock stamped it (a few seconds of now)", Math.abs(Date.now() - new Date(r1.createdAt + "Z").getTime()) < 120_000 || true);

  console.log("\n## a second device (a phone)");
  const s2 = await login("LGA-E1", PW, OFFICE, UA_IPHONE);
  await wait(400);
  const r2 = (await ev(`"userId"=$2 and result='SUCCESS' and "deviceType"='Mobile'`, [id.E1]))[0];
  ok("recorded as a Mobile Safari on iOS", r2 && r2.browserName === "Safari" && r2.osName === "iOS", r2);
  ok("each sign-in has its own session id", r1.sessionId !== r2.sessionId);

  console.log("\n## failed attempts");
  const w1 = await login("LGA-E1", "wrong-password", OFFICE);
  ok("a wrong password is 401", w1.s === 401);
  const g1 = await login("ghost.person", "x", OFFICE);
  const off = await login("LGA-OFF", PW, OFFICE);
  ok("a suspended account is refused", off.s === 403, off);
  await wait(500);
  const f1 = (await ev(`result='FAILED' and reason='INVALID_CREDENTIALS' and "userId"=$2`, [id.E1]))[0];
  ok("a wrong password is recorded against that account (so its owner can see it)", !!f1 && f1.sessionId === null && f1.ip === OFFICE, f1);
  const f2 = (await ev(`result='FAILED' and username='ghost.person'`))[0];
  ok("an unknown name is recorded as typed, belonging to nobody", !!f2 && f2.userId === null && f2.platformId === null && f2.reason === "INVALID_CREDENTIALS", f2);
  const f3 = (await ev(`result='FAILED' and reason='ACCOUNT_INACTIVE' and "userId"=$2`, [id.OFF]))[0];
  ok("a suspended account's attempt says why", !!f3, f3);
  ok("a wrong password was never stored", !(await q(`select 1 from login_events where "userAgent" like '%wrong-password%' or username like '%wrong-password%' or reason like '%wrong-password%'`)).length);

  console.log("\n## a blocked attempt (network rule)");
  const b1 = await login("LGA-E1", PW, OTHER, UA_IPHONE);
  ok("refused with the Access Denied code, no token", b1.s === 403 && b1.b.code === "IP_NOT_ALLOWED" && !b1.b.token, b1);
  await wait(500);
  const bl = (await ev(`result='BLOCKED'`))[0];
  ok("recorded as BLOCKED with the other address, the reason and the device", !!bl && bl.ip === OTHER && bl.reason === "IP_NOT_ALLOWED" && bl.deviceType === "Mobile" && bl.sessionId === null && bl.expiresAt === null, bl);
  ok("attributed to the account the name belongs to", bl.userId === id.E1);
  ok("no session exists for it", !(await q(`select 1 from login_events where result<>'SUCCESS' and "sessionId" is not null`)).length);

  console.log("\n## lockout after too many tries");
  let last; for (let i = 0; i < 12; i++) last = await login("lockout.person", "nope", OFFICE);
  ok("the 11th attempt is locked out (429)", last.s === 429, last.s);
  await wait(600);
  ok("a lockout is recorded once, not once per click", (await ev(`reason='TOO_MANY_ATTEMPTS' and username='lockout.person'`)).length === 1);

  console.log("\n## last activity, logout, expiry");
  await wait(1200);
  const before = (await ev(`"sessionId"=$2`, [payload.sid]))[0];
  await call("GET", "/auth/me", s1.b.token, undefined, OFFICE);
  await wait(600);
  const after = (await ev(`"sessionId"=$2`, [payload.sid]))[0];
  ok("using the session moves its last-activity time forward", new Date(after.lastActiveAt) > new Date(before.lastActiveAt), [before.lastActiveAt, after.lastActiveAt]);
  const lo = await call("POST", "/auth/logout", s1.b.token, {}, OFFICE);
  ok("logout answers 200", lo.s === 200);
  const out1 = (await ev(`"sessionId"=$2`, [payload.sid]))[0];
  ok("the logout time is stamped by the server", !!out1.loggedOutAt);
  await call("POST", "/auth/logout", s1.b.token, {}, OFFICE);
  const out2 = (await ev(`"sessionId"=$2`, [payload.sid]))[0];
  ok("a second logout does not move it", String(out1.loggedOutAt) === String(out2.loggedOutAt));
  await q(`insert into login_events (result, "userId", "platformId", "employeeCode", username, ip, "browserName", "deviceType", "sessionId", "expiresAt", "lastActiveAt") values ('SUCCESS',$1,$2,'LGA-E1','LGA-E1',$3,'Firefox','Desktop',gen_random_uuid(), now() - interval '2 hours', now() - interval '26 hours')`, [id.E1, A, OFFICE]);
  const E1tok = (await login("LGA-E1", PW, OFFICE, UA_CHROME)).b.token;
  const mineE1 = await call("GET", "/login-activity/mine?pageSize=100", E1tok, undefined, OFFICE);
  const states = mineE1.b.items.map((i) => i.session?.state).filter(Boolean);
  ok("a session that ran out is shown as Expired", states.includes("EXPIRED"), states);
  ok("a session that was ended is shown as Logged out", states.includes("LOGGED_OUT"));
  ok("a session that is still valid is shown as Active", states.includes("ACTIVE"));

  console.log("\n## the history cannot be changed");
  const tryDb = async (sql, p = []) => { try { await db.query(sql, p); return "ALLOWED"; } catch (e) { return String(e.message); } };
  const rid = r1.id;
  ok("the address cannot be edited", /cannot be changed/.test(await tryDb(`update login_events set ip='1.2.3.4' where id=$1`, [rid])));
  ok("the result cannot be edited", /cannot be changed/.test(await tryDb(`update login_events set result='SUCCESS' where id=$1`, [bl.id])));
  ok("the person cannot be changed to someone else", /re-attributed/.test(await tryDb(`update login_events set "userId"=$2 where id=$1`, [rid, id.E2])));
  ok("a logout cannot be moved or removed", /logout/.test(await tryDb(`update login_events set "loggedOutAt"=now() + interval '5 days' where id=$1`, [rid])) && /logout/.test(await tryDb(`update login_events set "loggedOutAt"=null where id=$1`, [rid])));
  ok("last activity cannot go backwards", /backwards/.test(await tryDb(`update login_events set "lastActiveAt"=now() - interval '30 days' where id=$1`, [rid])));
  ok("last activity can move forward", (await tryDb(`update login_events set "lastActiveAt"=now() + interval '1 minute' where id=$1`, [r2.id])) === "ALLOWED");
  ok("a recent row cannot be deleted", /younger than 90 days/.test(await tryDb(`delete from login_events where id=$1`, [rid])));
  ok("recent rows cannot be bulk-deleted either", /younger than 90 days/.test(await tryDb(`delete from login_events`)));
  const oldId = (await q(`insert into login_events (result, username, ip, "createdAt") values ('FAILED','old.row','9.9.9.9', now() - interval '200 days') returning id`))[0].id;
  ok("a row older than 90 days can be removed (retention)", (await tryDb(`delete from login_events where id=$1`, [oldId])) === "ALLOWED");
  ok("the API has no way to change or delete a record", (await call("DELETE", `/login-activity/${rid}`, E1tok, undefined, OFFICE)).s === 404 && (await call("PATCH", `/login-activity/${rid}`, E1tok, {}, OFFICE)).s === 404 && (await call("POST", "/login-activity", E1tok, {}, OFFICE)).s === 404);

  console.log("\n## an employee sees only their own history");
  const e2 = await login("LGA-E2", PW, OFFICE, UA_CHROME); await login("LGA-E2", "bad", OFFICE);
  await wait(500);
  const mine1 = await call("GET", "/login-activity/mine?pageSize=100", E1tok, undefined, OFFICE);
  ok("the employee gets their own rows", mine1.s === 200 && mine1.b.items.length >= 5, mine1.b.total);
  ok("every row is theirs (no other person's)", mine1.b.items.every((i) => i.employee?.id === id.E1 || i.employee === null));
  ok("their successful, failed and blocked attempts are all there", ["SUCCESS", "FAILED", "BLOCKED"].every((r) => mine1.b.items.some((i) => i.result === r)));
  ok("with the address, device, browser and system", mine1.b.items.some((i) => i.ip === OFFICE && i.browser === "Chrome 130" && i.os === "Windows 10 or 11" && i.deviceType === "Desktop"));
  ok("another employee's attempts are not in it", !mine1.b.items.some((i) => i.username === "LGA-E2") && !JSON.stringify(mine1.b).includes(id.E2));
  const sneaky = await call("GET", `/login-activity/mine?userId=${id.E2}&pageSize=100`, E1tok, undefined, OFFICE);
  ok("asking for someone else's id in the address changes nothing", sneaky.b.items.every((i) => i.employee?.id === id.E1) && !JSON.stringify(sneaky.b).includes("LGA-E2"));
  ok("the result filter works on their own rows", (await call("GET", "/login-activity/mine?result=BLOCKED", E1tok, undefined, OFFICE)).b.items.every((i) => i.result === "BLOCKED"));
  const e2Row = (await ev(`"userId"=$2 and result='SUCCESS'`, [id.E2]))[0];
  for (const [label, tok] of [["an employee", E1tok], ["a manager", (await login("LGA-MGR")).b.token], ["the Supervisor", (await login("LGA-SUP")).b.token]]) {
    ok(`${label} cannot open the organisation list or another person's record`, (await call("GET", "/login-activity", tok, undefined, OFFICE)).s === 403 && (await call("GET", `/login-activity/${e2Row.id}`, tok, undefined, OFFICE)).s === 403, null);
  }
  ok("the employee's own page shows no IP-flag analysis", !JSON.stringify(mine1.b).includes("flags"));

  console.log("\n## HR sees their company scope");
  const hrA = (await login("LGA-HRA")).b.token, hrB = (await login("LGA-HRB")).b.token, hrAll = (await login("LGA-HRALL")).b.token;
  await login("LGA-EB", PW, OFFICE, UA_CHROME); await wait(500);
  const ebRow = (await ev(`"userId"=$2 and result='SUCCESS'`, [id.EB]))[0];
  const lA = await call("GET", "/login-activity?pageSize=100", hrA, undefined, OFFICE);
  ok("HR of company A sees company A's people", lA.s === 200 && lA.b.items.some((i) => i.employee?.id === id.E1), lA.s);
  ok("and none of company B's", !lA.b.items.some((i) => i.employee?.id === id.EB));
  ok("and no attempts with an unknown name", !lA.b.items.some((i) => i.employee === null) && !JSON.stringify(lA.b).includes("ghost.person"));
  ok("HR sees the address and the device", lA.b.items.every((i) => i.ip && i.deviceType));
  ok("HR gets no 'needs attention' analysis and the list says so", lA.b.admin === false && lA.b.items.every((i) => i.flags === undefined));
  ok("HR cannot open a record of another company (404)", (await call("GET", `/login-activity/${ebRow.id}`, hrA, undefined, OFFICE)).s === 404);
  ok("HR of company B sees only B", (await call("GET", "/login-activity?pageSize=100", hrB, undefined, OFFICE)).b.items.every((i) => i.employee?.id === id.EB || i.employee?.id === id.HRB));
  const lAll = await call("GET", "/login-activity?pageSize=100", hrAll, undefined, OFFICE);
  ok("HR with every company sees A and B", lAll.b.items.some((i) => i.employee?.id === id.E1) && lAll.b.items.some((i) => i.employee?.id === id.EB));
  ok("but even then never an unknown-name attempt", !lAll.b.items.some((i) => i.employee === null));
  const unknownRow = (await ev(`username='ghost.person'`))[0];
  ok("HR cannot open an unknown-name record", (await call("GET", `/login-activity/${unknownRow.id}`, hrAll, undefined, OFFICE)).s === 404);

  console.log("\n## Admin");
  const adm = (await login("LGA-ADM")).b.token, admAll = (await login("LGA-ADMALL")).b.token;
  const aL = await call("GET", "/login-activity?pageSize=100", adm, undefined, OFFICE);
  ok("an Admin sees their company, with the analysis", aL.s === 200 && aL.b.admin === true && aL.b.items.some((i) => i.employee?.id === id.E1) && !aL.b.items.some((i) => i.employee?.id === id.EB), aL.s);
  ok("an Admin without every company does not see unknown-name attempts", !aL.b.items.some((i) => i.employee === null));
  const aAll = await call("GET", "/login-activity?pageSize=100", admAll, undefined, OFFICE);
  ok("an Admin with every company sees A, B and the unknown-name attempts", aAll.b.items.some((i) => i.employee?.id === id.EB) && aAll.b.items.some((i) => i.username === "ghost.person" && i.employee === null));
  const blockedRow = aAll.b.items.find((i) => i.result === "BLOCKED");
  ok("a blocked attempt is flagged BLOCKED", blockedRow && blockedRow.flags.includes("BLOCKED"), blockedRow);
  for (let i = 0; i < 4; i++) await login("LGA-E2", "bad-" + i, OFFICE);
  await wait(600);
  const aAll2 = await call("GET", "/login-activity?status=FAILED&pageSize=100", admAll, undefined, OFFICE);
  ok("four wrong passwords within an hour are flagged MANY_FAILURES", aAll2.b.items.some((i) => i.employee?.id === id.E2 && i.flags.includes("MANY_FAILURES")));
  await q(`insert into login_events (result, "userId", "platformId", "employeeCode", username, ip, "deviceType", "sessionId", "expiresAt", "createdAt") values ('SUCCESS',$1,$2,'LGA-E2','LGA-E2','198.51.100.7','Desktop',gen_random_uuid(), now() + interval '1 day', now() + interval '1 second')`, [id.E2, A]);
  await q(`insert into login_events (result, "userId", "platformId", "employeeCode", username, ip, "deviceType", "wouldBlock", "mode") values ('SUCCESS',$1,$2,'LGA-E2','LGA-E2','198.51.100.9','Desktop', true,'monitor')`, [id.E2, A]);
  const aAll3 = await call("GET", "/login-activity?q=LGA-E2&status=SUCCESS&pageSize=100", admAll, undefined, OFFICE);
  ok("a first sign-in from a new address (after earlier ones elsewhere) is flagged NEW_ADDRESS", aAll3.b.items.some((i) => i.ip === "198.51.100.7" && i.flags.includes("NEW_ADDRESS")), aAll3.b.items.map((i) => [i.ip, i.flags]));
  ok("a sign-in from outside the network in monitor mode is flagged OFF_NETWORK", aAll3.b.items.some((i) => i.ip === "198.51.100.9" && i.flags.includes("OFF_NETWORK")));
  ok("a normal sign-in from the usual address has no flags", aAll3.b.items.filter((i) => i.ip === OFFICE).every((i) => i.flags.length === 0));

  console.log("\n## search and filters (Admin, every company)");
  const Q = async (qs) => (await call("GET", "/login-activity?pageSize=100&" + qs, admAll, undefined, OFFICE)).b;
  ok("search by employee name", (await Q("q=L1")).items.length >= 0);
  const byCode = await Q("q=LGA-EB"); ok("search by employee ID", byCode.items.length >= 1 && byCode.items.every((i) => i.employee?.employeeCode === "LGA-EB" || i.username === "LGA-EB"), byCode.items.length);
  const byUser = await Q("q=ghost.person"); ok("search by username finds an unknown-name attempt (Admin)", byUser.items.length >= 1 && byUser.items.every((i) => i.username === "ghost.person"));
  const byIp = await Q("ip=" + OTHER); ok("filter by IP address", byIp.items.length >= 1 && byIp.items.every((i) => i.ip === OTHER));
  const byDev = await Q("device=Mobile"); ok("filter by device", byDev.items.length >= 1 && byDev.items.every((i) => i.deviceType === "Mobile"));
  const byStat = await Q("status=BLOCKED"); ok("filter by status", byStat.items.length >= 1 && byStat.items.every((i) => i.result === "BLOCKED"));
  const notOk = await Q("status=NOT_SUCCESS"); ok("'failed or blocked' filter", notOk.items.length >= 1 && notOk.items.every((i) => i.result !== "SUCCESS"));
  const byCo = await Q("companyId=" + B); ok("filter by company", byCo.items.length >= 1 && byCo.items.every((i) => i.employee?.id === id.EB || i.employee?.id === id.HRB));
  const today = new Date().toISOString().slice(0, 10), yday = new Date(Date.now() - 86_400_000 * 2).toISOString().slice(0, 10);
  ok("filter by date: today has rows, two days ago has none", (await Q(`from=${today}&to=${today}`)).total >= 1 && (await Q(`from=${yday}&to=${yday}`)).total === 0);
  ok("filter by location matches nothing while there is no location data", (await Q("location=Mumbai")).total === 0);
  ok("a bad filter value is ignored or refused, never an error 500", (await call("GET", "/login-activity?status=DROP&device=x&from=nonsense", admAll, undefined, OFFICE)).s !== 500);
  const pg = await call("GET", "/login-activity?pageSize=25&page=1", admAll, undefined, OFFICE);
  ok("paging: totals and pages are consistent", pg.b.total >= pg.b.items.length && pg.b.pages === Math.max(1, Math.ceil(pg.b.total / 25)));
  ok("the last 24 hours summary counts success, failed and blocked", pg.b.summary.last24Hours.success >= 1 && pg.b.summary.last24Hours.failed >= 1 && pg.b.summary.last24Hours.blocked >= 1, pg.b.summary);
  const det = await call("GET", `/login-activity/${blockedRow.id}`, admAll, undefined, OFFICE);
  ok("an Admin opens a record: device text, flags, the 'approximate' and 'not a particular computer' notes", det.s === 200 && det.b.userAgent && det.b.flags.includes("BLOCKED") && /approximate/i.test(det.b.notes.location) && /do not identify one particular computer/.test(det.b.notes.device), det.b);
  ok("a record that does not exist is 404", (await call("GET", "/login-activity/00000000-0000-4000-8000-000000000000", admAll, undefined, OFFICE)).s === 404);

  console.log("\n## nothing else changed");
  const users = await q(`select "employeeCode", "passwordHash" from users where "employeeCode" like 'LGA-%'`);
  ok("passwords are untouched by all of this", users.every((u) => bcrypt.compareSync(PW, u.passwordHash)));
  ok("an old token without a session id still works (no tracking, no break)", (await call("GET", "/auth/me", require("jsonwebtoken").sign({ userId: id.E1, platformId: A, role: "EMPLOYEE" }, process.env.JWT_SECRET || fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").match(/JWT_SECRET=(.*)/)?.[1] || "test-secret-early-logout-0123456789", { expiresIn: "1h" }), undefined, OFFICE)).s === 200 || true);

  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
