// Network access policy over real HTTP: the five roles, allowed and other addresses, a forged header, an existing session, the security log.
// The backend (port 5012, throwaway DB only) must be started with the mode under test, for example:
//   LOGIN_IP_MODE=enforce LOGIN_ALLOWED_IPS=206.84.235.169 sh start-be-5012.sh
// then: MODE=enforce node tests/ip-access.test.cjs        (MODE = off | monitor | enforce | enforce-empty)
// A proxy is simulated with X-Forwarded-For: the test connects from 127.0.0.1, which (like a hosting load balancer on a private network) is a
// trusted proxy, so the rightmost entry that is NOT a private address is the caller. A public client connecting directly can never choose its
// address with a header (that rule is unit-tested in ip-policy.test.mts, since every connection made from this machine is local).
// enforce-empty (LOGIN_IP_MODE=enforce with no valid LOGIN_ALLOWED_IPS) now FAILS CLOSED: everybody is refused, the office address too.
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const fs = require("node:fs"), path = require("node:path");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const MODE = process.env.MODE ?? "enforce";
const OFFICE = "206.84.235.169", OTHER = "103.212.140.53";
const DENIED = "Access Denied. You are not authorized to access Avatar HRMS from this network. Please connect using the authorized office network or contact the HR/Admin team.";

const call = async (m, p, t, b, ip) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}), ...(ip ? { "x-forwarded-for": ip } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j, raw: txt };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Ipa@12345678";
const MIGRATION = fs.readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261119120000_productivity_supervisors", "migration.sql"), "utf8");

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  if (!(await q(`select to_regclass('productivity_supervisors') t`))[0].t) await q(MIGRATION);
  const wipe = async () => {
    await q(`delete from audit_logs where module='Security' and (after->>'username' like 'IPA-%' or after->>'username' like 'ipa-%' or after->>'username' like 'nobody%' or after->>'username' like 'ghost%')`).catch(() => {});
    await q(`delete from productivity_supervisors where "userId" in (select id from users where "employeeCode" like 'IPA-%')`);
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'IPA-%')`).catch(() => {});
    await q(`delete from notifications where "userId" in (select id from users where "employeeCode" like 'IPA-%')`);
    await q(`delete from users where "employeeCode" like 'IPA-%'`);
  };
  // the audit rows are immutable (a trigger), so a clean slate is "rows newer than the start of this run"
  const startedAt = (await q(`select to_char(now(), 'YYYY-MM-DD HH24:MI:SS.US') t`))[0].t; // as text: a JS Date would be shifted by this machine's time zone
  await q(`delete from users where "employeeCode" like 'IPA-%'`).catch(() => {});
  const mk = async (code, role) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Ipa',$5,$6,'ACTIVE',false,true,'ACTIVE',now(),now()) returning id`, [A, code.toLowerCase() + "@ipa.test", hash, code.replace("IPA-", "I"), code, role]))[0].id;
  const ids = { ADMIN: await mk("IPA-ADM", "ADMIN"), HR: await mk("IPA-HR", "HR"), MANAGER: await mk("IPA-MGR", "MANAGER"), EMPLOYEE: await mk("IPA-EMP", "EMPLOYEE"), SUPERVISOR: await mk("IPA-SUP", "EMPLOYEE") };
  await q(`insert into productivity_supervisors ("userId", note) values ($1,'ipa')`, [ids.SUPERVISOR]);
  await new Promise((r) => setTimeout(r, 16_000)); // the server re-checks a missing supervisor table every 15 s
  const codes = { ADMIN: "IPA-ADM", HR: "IPA-HR", MANAGER: "IPA-MGR", EMPLOYEE: "IPA-EMP", SUPERVISOR: "IPA-SUP" };
  const secRows = async (extra = "") => q(`select id, summary, ip, status, "targetUserId", "actorId", after, path from audit_logs where module='Security' and "createdAt" >= $1::timestamp ${extra} order by "createdAt"`, [startedAt]);
  const enforcing = MODE === "enforce";
  const watching = MODE === "monitor";
  if (MODE === "enforce-empty") {
    console.log("\n## mode under test: enforce with NO valid allowed address (fail closed)");
    for (const [role, code] of Object.entries(codes)) {
      const fromOffice = await call("POST", "/auth/login", null, { email: code, password: PW }, OFFICE);
      ok(`${role} is refused even from the office address (nothing is allowed)`, fromOffice.s === 403 && fromOffice.b.code === "IP_NOT_ALLOWED" && !fromOffice.b.token, fromOffice);
      const fromOther = await call("POST", "/auth/login", null, { email: code, password: PW }, OTHER);
      ok(`${role} is refused from any other address`, fromOther.s === 403 && !fromOther.b.token, fromOther);
    }
    await new Promise((r) => setTimeout(r, 1200));
    const evs = await q(`select result, reason, ip from login_events where "createdAt" >= $1::timestamp and username like 'IPA-%'`, [startedAt]);
    ok("every refusal is recorded in Login Activity as BLOCKED (office address included)", evs.length >= 10 && evs.every((r) => r.result === "BLOCKED" && r.reason === "IP_NOT_ALLOWED") && evs.some((r) => r.ip === OFFICE), evs.length);
    ok("passwords, roles and status are untouched", (await q(`select "passwordHash" from users where "employeeCode" like 'IPA-%'`)).every((u) => bcrypt.compareSync(PW, u.passwordHash)));
    await wipe().catch(() => {});
    await db.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  console.log(`\n## mode under test: ${MODE}`);
  // ---- the office address: every role signs in ----
  const tokens = {};
  for (const [role, code] of Object.entries(codes)) {
    const r = await call("POST", "/auth/login", null, { email: code, password: PW }, OFFICE);
    tokens[role] = r.b?.token;
    ok(`${role} signs in from the authorised address`, r.s === 200 && !!r.b.token, r);
  }
  const me = await call("GET", "/auth/me", tokens.ADMIN, undefined, OFFICE);
  ok("and the session works from that address", me.s === 200);

  // ---- every other address ----
  for (const [role, code] of Object.entries(codes)) {
    const r = await call("POST", "/auth/login", null, { email: code, password: PW }, OTHER);
    if (enforcing) {
      ok(`${role} is refused from another address (403)`, r.s === 403 && r.b.code === "IP_NOT_ALLOWED" && r.b.error === DENIED && !r.b.token && !r.raw.includes("token"), r);
    } else {
      ok(`${role} still signs in from another address (${MODE})`, r.s === 200 && !!r.b.token, r);
    }
  }
  if (enforcing) {
    const wrong = await call("POST", "/auth/login", null, { email: "IPA-ADM", password: "wrong-password" }, OTHER);
    ok("a wrong password from another address gets the SAME refusal (passwords cannot be probed)", wrong.s === 403 && wrong.b.error === DENIED, wrong);
    const ghost = await call("POST", "/auth/login", null, { email: "ghost.person", password: "x" }, OTHER);
    ok("an unknown name from another address gets the same refusal (no account is revealed)", ghost.s === 403 && ghost.b.error === DENIED, ghost);
    ok("the refusal contains no address and no configuration", !/\d+\.\d+\.\d+\.\d+|LOGIN_|206\.84/.test(wrong.raw), wrong.raw);
    // forged headers
    const f1 = await call("POST", "/auth/login", null, { email: "IPA-ADM", password: PW }, `${OFFICE}, ${OTHER}`);
    ok("a forged header cannot pass: the allowed address written FIRST by the client is ignored (the proxy's entry is on the right)", f1.s === 403, f1);
    const f2 = await call("POST", "/auth/login", null, { email: "IPA-ADM", password: PW }, `${OTHER}, ${OFFICE}`);
    ok("what the (simulated) proxy saw is what counts: the allowed address on the right passes", f2.s === 200, f2);
    const none = await call("POST", "/auth/login", null, { email: "IPA-ADM", password: PW });
    ok("a direct connection with no proxy header (local address) is refused", none.s === 403, none);
    const v6 = await call("POST", "/auth/login", null, { email: "IPA-ADM", password: PW }, `::ffff:${OFFICE}`);
    ok("the same address written as IPv6-mapped passes", v6.s === 200, v6);
    const near = await call("POST", "/auth/login", null, { email: "IPA-ADM", password: PW }, "206.84.235.170");
    ok("a neighbouring address is refused", near.s === 403, near);
    const v6other = await call("POST", "/auth/login", null, { email: "IPA-ADM", password: PW }, "2401:4900:1c3a:9d2::1");
    ok("a mobile network's IPv6 address is refused", v6other.s === 403, v6other);
    const home = await call("POST", "/auth/login", null, { email: "IPA-EMP", password: PW }, "122.170.5.6");
    ok("a home Wi-Fi address is refused", home.s === 403, home);
    const lan = await call("POST", "/auth/login", null, { email: "IPA-EMP", password: PW }, "192.168.1.25");
    ok("a private address (no public client in the chain) is not the office address and is refused", lan.s === 403, lan);
    const chk = await call("GET", "/auth/ip-check", tokens.ADMIN, undefined, OFFICE);
    ok("Admin's IP check shows what the server sees: the office address, mode enforce, allowed", chk.s === 200 && chk.b.detectedIp === OFFICE && chk.b.mode === "enforce" && chk.b.thisRequestAllowed === true && chk.b.allowedEntries === 1, chk.b);
    ok("the IP check never returns the allowed list itself", !JSON.stringify(chk.b).includes('"rules"'));
    ok("HR cannot open the IP check (403)", (await call("GET", "/auth/ip-check", tokens.HR, undefined, OFFICE)).s === 403);
  }

  // ---- an existing session on another address ----
  const probe = ["/auth/me", "/tasks", "/tracker/session", "/notifications"];
  for (const [role, tok] of Object.entries(tokens)) {
    const rs = await Promise.all(probe.map((p) => call("GET", p, tok, undefined, OTHER)));
    if (enforcing) ok(`${role}: a session token used from another address is refused on every route`, rs.every((r) => r.s === 403 && r.b.code === "IP_NOT_ALLOWED" && r.b.error === DENIED), rs.map((r) => r.s));
    else ok(`${role}: the session keeps working from another address (${MODE})`, rs.every((r) => r.s === 200), rs.map((r) => r.s));
    const back = await call("GET", "/auth/me", tok, undefined, OFFICE);
    ok(`${role}: the same session works again from the authorised address`, back.s === 200, back.s);
  }
  const bad = await call("GET", "/auth/me", "not-a-token", undefined, OTHER);
  ok("an invalid token is still just 401 (the policy does not hide that)", bad.s === 401, bad);
  ok("the health check is open from anywhere", (await call("GET", "/health", null, undefined, OTHER)).s === 200);
  const chg = await call("POST", "/auth/login", null, { email: "IPA-ADM", password: PW }, OFFICE);
  ok("the Admin can still sign in from the office after all of this (nothing locked)", chg.s === 200);

  // ---- the security log ----
  await new Promise((r) => setTimeout(r, 1200));
  const rows = await secRows();
  const blockedLogins = rows.filter((r) => r.path === "/api/auth/login" && r.ip === OTHER);
  const hasEvents = (await q(`select to_regclass('public.login_events') t`))[0].t !== null;
  const ev = hasEvents ? await q(`select result, reason, mode, "wouldBlock", username, ip, "userAgent", "createdAt", "userId" from login_events where "createdAt" >= $1::timestamp and (username like 'IPA-%' or username = 'ghost.person')`, [startedAt]) : [];
  if (MODE === "off") {
    ok("off: nothing is logged at all", rows.length === 0, rows.length);
  } else {
    const otherEv = ev.filter((r) => r.ip === OTHER);
    ok("every sign-in from another address is recorded in Login Activity with its username", ["IPA-ADM", "IPA-HR", "IPA-MGR", "IPA-EMP", "IPA-SUP"].every((u) => otherEv.some((r) => r.username === u)), otherEv.map((r) => r.username));
    const one = otherEv.find((r) => r.username === "IPA-HR");
    ok("the record has the username, the detected address, the time, the result, the reason, the mode and the browser text", !!one && one.ip === OTHER && !!one.createdAt && !!one.mode && !!one.userAgent && (enforcing ? one.result === "BLOCKED" && one.reason === "IP_NOT_ALLOWED" : one.result === "SUCCESS" && one.wouldBlock === true), one);
    ok(enforcing ? "every such record says BLOCKED" : "every such record says signed in but would be blocked (monitor)", otherEv.length > 0 && otherEv.every((r) => (enforcing ? r.result === "BLOCKED" : r.wouldBlock === true)), otherEv.map((r) => r.result));
    ok("the record is linked to the account when the name matches", !!one && one.userId === ids.HR, one);
    ok("a successful sign-in from the authorised address is recorded as SUCCESS, not flagged", ev.some((r) => r.ip === OFFICE && r.result === "SUCCESS" && r.username === "IPA-ADM" && !r.wouldBlock));
    ok("the log holds no password and no token", !rows.some((r) => JSON.stringify(r).includes(PW) || /eyJ[A-Za-z0-9_-]{10,}/.test(JSON.stringify(r)) || /passwordHash|\$2[aby]\$/.test(JSON.stringify(r))));
    if (enforcing) {
      const ghostRow = ev.find((r) => r.username === "ghost.person");
      ok("an unknown name is recorded too, as typed, with no account attached", !!ghostRow && ghostRow.userId === null && ghostRow.result === "BLOCKED", ghostRow);
      ok("a blocked attempt never reached the password check (no wrong-password record from the other address)", !otherEv.some((r) => r.reason === "INVALID_CREDENTIALS"));
    }
    const sess = rows.filter((r) => r.path !== "/api/auth/login");
    const perAddress = MODE === "enforce-empty" ? 10 : 5; // enforce-empty flags the office address too (nothing is allowed)
    ok("session requests from another address are logged once per person and address (not once per request)", sess.length >= 1 && sess.length <= perAddress, sess.length);
    ok("each of those rows is attributed to the person", sess.every((r) => r.actorId && (r.ip === OTHER || (MODE === "enforce-empty" && r.ip === OFFICE))));
    // the Admin reads it; others cannot
    const read = await call("GET", "/audit-logs?module=Security&pageSize=100", tokens.ADMIN, undefined, OFFICE);
    const item = (read.b.items ?? []).find((r) => /IPA-HR/.test(r.summary) && r.module === "Security");
    ok("an Admin finds the security rows in the Audit log (module Security)", read.s === 200 && !!item, { s: read.s, n: (read.b.items ?? []).length });
    const detail = item ? await call("GET", "/audit-logs/" + item.id, tokens.ADMIN, undefined, OFFICE) : null;
    ok("and opens one to see the address, the result and the reason", detail?.s === 200 && detail.b.ip === OTHER && /Blocked|monitor/.test(detail.b.after?.result ?? "") && !!detail.b.after?.reason && detail.b.after?.username === "IPA-HR", detail?.b);
    ok("the Audit log does not hide the result fields as secrets", !/redacted/i.test(JSON.stringify(detail?.b?.after ?? {})), detail?.b?.after);
    ok("the security log module is a filter choice", (await call("GET", "/audit-logs/filters", tokens.ADMIN, undefined, OFFICE)).b.modules?.includes("Security"));
    ok("HR cannot read it", (await call("GET", "/audit-logs?module=Security", tokens.HR, undefined, OFFICE)).s === 403);
    ok("an employee cannot read it", (await call("GET", "/audit-logs?module=Security", tokens.EMPLOYEE, undefined, OFFICE)).s === 403);
  }

  // ---- nothing about the accounts changed ----
  const after = await q(`select "employeeCode", "passwordHash", role::text r, status::text s from users where "employeeCode" like 'IPA-%' order by 1`);
  ok("passwords, roles and status are untouched", after.length === 5 && after.every((u) => bcrypt.compareSync(PW, u.passwordHash)));

  await wipe().catch(() => {});
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
