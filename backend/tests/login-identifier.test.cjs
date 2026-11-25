// Employee-ID sign-in tolerance, over real HTTP against the throwaway test backend (5012) and DB:
//   TEST_DATABASE_URL=postgresql://postgres:localtest@localhost:54329/dq_test TEST_API=http://localhost:5012/api node tests/login-identifier.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
require("./_guard.cjs");
const API = process.env.TEST_API || "http://localhost:5012/api";
const call = async (id, pw) => {
  const r = await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: id, password: pw }) });
  const j = await r.json().catch(() => ({}));
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 250))); };
const PW = "Lid@12345678", OTHER = "Wrong@12345678";

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const plats = await q(`select id from platforms order by slug limit 2`);
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from login_events where "employeeCode" like 'LIT-%' or username ilike '%lit%'`).catch(() => {});
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'LIT-%')`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'LIT-%'`);
  };
  await wipe();
  const mk = async (plat, code, status = "ACTIVE", email = null) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Lit',$4,$4,'EMPLOYEE',$5,false,true,'ACTIVE',now(),now()) returning id`, [plat, email ?? code.toLowerCase() + "@lit.test", hash, code, status]))[0].id;
  const id03 = await mk(plats[0].id, "LIT-03");
  await mk(plats[0].id, "LIT-ABC-1");
  await mk(plats[1].id, "LIT-ABC1"); // same once hyphens are ignored: must never be guessed between
  await mk(plats[0].id, "LIT-OFF", "EXITED");
  await mk(plats[1].id, "LIT-Mix-07");

  const who = async (id, pw = PW) => { const r = await call(id, pw); return r.s === 200 ? r.b.user.employeeCode : r; };
  console.log("\n## what worked before still works");
  for (const t of ["LIT-03", "lit-03", "LIT-03  ", "  LIT-03", "Lit-Mix-07"]) ok(`"${t}" signs in`, (await who(t)) === (t.toLowerCase().includes("mix") ? "LIT-Mix-07" : "LIT-03"), await call(t, PW));
  ok("email sign-in is untouched", (await who("lit-03@lit.test")) === "LIT-03");
  ok("an exact ID of one of two look-alikes still goes to that one", (await who("LIT-ABC-1")) === "LIT-ABC-1" && (await who("LIT-ABC1")) === "LIT-ABC1");

  console.log("\n## typing slips now find the right person");
  for (const t of ["LIT -03", "LIT- 03", "LIT - 03", "LIT03", "lit_03", " Lit 03 "]) ok(`"${t}" signs in as LIT-03`, (await who(t)) === "LIT-03", await call(t, PW));
  ok('"LITMIX07" and "lit mix 07" find LIT-Mix-07', (await who("LITMIX07")) === "LIT-Mix-07" && (await who("lit mix 07")) === "LIT-Mix-07");

  console.log("\n## nothing is guessed, nothing is revealed");
  const wrong = await call("LIT -03", OTHER);
  ok("a tolerant match with the wrong password gives the SAME generic error", wrong.s === 401 && wrong.b.error === "Email or password is incorrect", wrong);
  const unknown = await call("LIT-99", PW);
  ok("an unknown ID gives the same error", unknown.s === 401 && unknown.b.error === wrong.b.error, unknown);
  const amb = await call("LIT ABC 1", PW);
  ok("two people match once hyphens are ignored: nobody is signed in (no guessing)", amb.s === 401 && amb.b.error === wrong.b.error, amb);
  ok("an ID with an extra prefix (ID-LIT-03) is not matched", (await call("ID-LIT-03", PW)).s === 401);
  ok("a too-short fragment never matches", (await call("li", PW)).s === 401 && (await call("--", PW)).s === 401);
  ok("quote characters are harmless", (await call("LIT-03'; drop table users;--", PW)).s === 401 && (await q(`select 1 from users limit 1`)).length === 1);
  const off = await call("LIT OFF", PW);
  ok("an exited person is still refused through a tolerant ID", off.s === 403 && /no longer active/.test(off.b.error), off);
  ok("a wrong-password attempt is still recorded against the right person", await (async () => { await new Promise((r) => setTimeout(r, 800)); return (await q(`select 1 from login_events where "userId"=$1 and result='FAILED'`, [id03])).length >= 1; })());

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
