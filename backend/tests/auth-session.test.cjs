// Sign-in tokens over real HTTP: reasons for refusal, refresh, expiry, tampering, concurrency, several "tabs", logout, account switched off, and that
// people of every company behave the same. Needs the throwaway test backend (port 5012, JWT_SECRET below) and the throwaway DB:
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api JWT_SECRET=test-secret-early-logout-0123456789 node tests/auth-session.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("./_guard.cjs");
const API = process.env.TEST_API || "http://localhost:5012/api";
const SECRET = process.env.JWT_SECRET || "test-secret-early-logout-0123456789";
const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j, raw: txt };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Ses@12345678";
const now = () => Math.floor(Date.now() / 1000);

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const plats = await q(`select id, slug from platforms order by slug limit 3`);
  const hash = await bcrypt.hash(PW, 10);
  await q(`delete from users where "employeeCode" like 'SES-%'`).catch(() => {});
  const mk = async (plat, code, role, status = "ACTIVE") => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Ses',$4,$4,$5,$6,false,true,'ACTIVE',now(),now()) returning id`, [plat, code.toLowerCase() + "@ses.test", hash, code, role, status]))[0].id;
  const users = [];
  for (let i = 0; i < plats.length; i++) users.push({ code: "SES-E" + i, id: await mk(plats[i].id, "SES-E" + i, "EMPLOYEE"), plat: plats[i].id });
  const mgrId = await mk(plats[0].id, "SES-M", "MANAGER");
  const login = async (code) => call("POST", "/auth/login", null, { email: code, password: PW });

  console.log("\n## 1 sign in and normal use");
  const l = await login("SES-E0");
  ok("login returns a token", l.s === 200 && typeof l.b.token === "string", l);
  const tok = l.b.token;
  const claims = jwt.decode(tok);
  ok("token carries user, company, role, sign-in id and the original sign-in time", claims.userId && claims.platformId && claims.role === "EMPLOYEE" && claims.sid && claims.sst && claims.exp > claims.iat, claims);
  const me = await call("GET", "/auth/me", tok);
  ok("/auth/me works", me.s === 200 && me.b.employeeCode === "SES-E0", me);

  console.log("\n## 2 many requests at once with one valid token");
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => call("GET", i % 2 ? "/auth/me" : "/notifications", tok)));
  ok("30 simultaneous requests all succeed", burst.every((r) => r.s === 200), burst.filter((r) => r.s !== 200).slice(0, 2));

  console.log("\n## 3 reasons for refusal (each a clear code, never the token)");
  const exp = jwt.sign({ userId: users[0].id, platformId: users[0].plat, role: "EMPLOYEE", sid: claims.sid, sst: now() - 100 }, SECRET, { expiresIn: -60 });
  const rExp = await call("GET", "/auth/me", exp);
  ok("expired token = 401 INVALID_TOKEN with code TOKEN_EXPIRED", rExp.s === 401 && rExp.b.error === "INVALID_TOKEN" && rExp.b.code === "TOKEN_EXPIRED", rExp);
  const bad = jwt.sign({ userId: users[0].id, platformId: users[0].plat, role: "EMPLOYEE" }, "some-other-secret", { expiresIn: "1d" });
  const rSig = await call("GET", "/auth/me", bad);
  ok("token signed with another secret = TOKEN_SIGNATURE", rSig.s === 401 && rSig.b.code === "TOKEN_SIGNATURE", rSig);
  for (const junk of ["undefined", "null", "abc", "a.b.c"]) {
    const r = await call("GET", "/auth/me", junk);
    ok(`malformed token "${junk}" = TOKEN_MALFORMED`, r.s === 401 && r.b.code === "TOKEN_MALFORMED", r);
  }
  const none = await call("GET", "/auth/me", null);
  ok("no token = NOT_AUTHENTICATED / NO_TOKEN", none.s === 401 && none.b.error === "NOT_AUTHENTICATED" && none.b.code === "NO_TOKEN", none);
  const noClaims = jwt.sign({ foo: 1 }, SECRET, { expiresIn: "1d" });
  const rNo = await call("GET", "/auth/me", noClaims);
  ok("valid signature but no user claims = TOKEN_PAYLOAD", rNo.s === 401 && rNo.b.code === "TOKEN_PAYLOAD", rNo);
  ok("no response ever contains the token", ![rExp, rSig, none, rNo].some((r) => r.raw.includes(exp) || r.raw.includes(bad)));
  const tampered = tok.slice(0, -4) + (tok.endsWith("AAAA") ? "BBBB" : "AAAA");
  ok("a tampered token is refused", (await call("GET", "/auth/me", tampered)).s === 401);
  const algNone = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ userId: users[0].id, platformId: users[0].plat, role: "ADMIN" })).toString("base64url") + ".";
  const rNone = await call("GET", "/auth/me", algNone);
  ok("an unsigned (alg none) token claiming ADMIN is refused", rNone.s === 401, rNone);

  console.log("\n## 4 refresh");
  const rf = await call("POST", "/auth/refresh", tok);
  ok("a valid token can be refreshed", rf.s === 200 && typeof rf.b.token === "string" && rf.b.expiresAt > Date.now(), rf);
  const c2 = jwt.decode(rf.b.token);
  ok("the new token keeps the sign-in id and the ORIGINAL sign-in time, same person, role", c2.sid === claims.sid && c2.sst === claims.sst && c2.userId === claims.userId && c2.role === "EMPLOYEE", c2);
  ok("the new token works", (await call("GET", "/auth/me", rf.b.token)).s === 200);
  ok("the old token still works (several tabs cannot invalidate each other)", (await call("GET", "/auth/me", tok)).s === 200);
  const par = await Promise.all(Array.from({ length: 8 }, () => call("POST", "/auth/refresh", tok)));
  ok("8 refreshes at once all succeed", par.every((r) => r.s === 200 && r.b.token), par.filter((r) => r.s !== 200));
  const works = await Promise.all(par.map((r) => call("GET", "/auth/me", r.b.token)));
  ok("every one of those tokens is valid", works.every((r) => r.s === 200));
  const rfExp = await call("POST", "/auth/refresh", exp);
  ok("an EXPIRED token can NOT be refreshed", rfExp.s === 401 && rfExp.b.code === "TOKEN_EXPIRED", rfExp);
  ok("no token cannot refresh", (await call("POST", "/auth/refresh", null)).s === 401);
  ok("a tampered token cannot refresh", (await call("POST", "/auth/refresh", tampered)).s === 401);
  const old = jwt.sign({ userId: users[0].id, platformId: users[0].plat, role: "EMPLOYEE", sid: claims.sid, sst: now() - 40 * 86400 }, SECRET, { expiresIn: "1d" });
  const rOld = await call("POST", "/auth/refresh", old);
  ok("a sign-in older than the 30-day cap is refused even with a valid token", rOld.s === 401 && rOld.b.code === "SESSION_TOO_OLD", rOld);
  const legacy = jwt.sign({ userId: users[0].id, platformId: users[0].plat, role: "EMPLOYEE" }, SECRET, { expiresIn: "1d" });
  const rLeg = await call("POST", "/auth/refresh", legacy);
  ok("a token made before this change (no sign-in time) still works and refreshes", rLeg.s === 200 && jwt.decode(rLeg.b.token).sst, rLeg);
  const t2 = jwt.sign({ userId: users[0].id, platformId: users[0].plat, role: "ADMIN" }, SECRET, { expiresIn: "1d" });
  ok("(awaited) the refreshed token carries the LIVE role (EMPLOYEE), not the claimed ADMIN", jwt.decode((await call("POST", "/auth/refresh", t2)).b.token).role === "EMPLOYEE");

  console.log("\n## 5 logout and a switched-off account");
  const l2 = await login("SES-E1");
  ok("logout answers ok", (await call("POST", "/auth/logout", l2.b.token)).s === 200);
  ok("a logged-out token is stateless: it still verifies until it expires (documented behaviour; the browser drops it)", (await call("GET", "/auth/me", l2.b.token)).s === 200);
  const l3 = await login("SES-E2");
  await q(`update users set status='TERMINATED' where id=$1`, [users[2].id]).catch(async () => q(`update users set status='EXITED' where id=$1`, [users[2].id]));
  const off = await call("GET", "/auth/me", l3.b.token);
  ok("an account switched off is refused at once with ACCOUNT_INACTIVE", off.s === 401 && off.b.error === "ACCOUNT_INACTIVE" && off.b.code === "ACCOUNT_INACTIVE", off);
  ok("and cannot refresh", (await call("POST", "/auth/refresh", l3.b.token)).s === 401);

  console.log("\n## 6 people from every company behave the same");
  for (const u of users.slice(0, 2)) {
    const lg = await login(u.code);
    const a = await call("GET", "/auth/me", lg.b.token);
    const r = await call("POST", "/auth/refresh", lg.b.token);
    ok(`${u.code}: sign in, use, refresh`, lg.s === 200 && a.s === 200 && r.s === 200, { lg: lg.s, a: a.s, r: r.s });
  }
  const mg = await login("SES-M");
  const mr = await call("POST", "/auth/refresh", mg.b.token);
  ok("a manager keeps the manager role through a refresh", jwt.decode(mr.b.token).role === "MANAGER");

  console.log("\n## 7 server restarts do not invalidate sessions");
  ok("tokens depend only on the secret (same secret on every start = same sessions): a token made outside the server with the shared secret is accepted", (await call("GET", "/auth/me", jwt.sign({ userId: users[0].id, platformId: users[0].plat, role: "EMPLOYEE" }, SECRET, { expiresIn: "1d" }))).s === 200);

  await q(`delete from login_events where "employeeCode" like 'SES-%'`).catch(() => {});
  await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'SES-%')`).catch(() => {});
  await q(`delete from notifications where "userId" in (select id from users where "employeeCode" like 'SES-%')`).catch(() => {});
  await q(`delete from users where "employeeCode" like 'SES-%'`).catch((e) => console.log("cleanup:", e.message));
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
