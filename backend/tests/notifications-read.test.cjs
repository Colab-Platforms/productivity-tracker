// Notification bell: reading removes a notification from the unread list, never deletes it, and counts stay right. Admin, HR, Manager, Employee.
// Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/notifications-read.test.cjs
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
const DB = process.env.TEST_DATABASE_URL;
require("./_guard.cjs").assertTestDb(DB);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, b: j };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Tnr@12345678";

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => { await q(`delete from notifications where "userId" in (select id from users where "employeeCode" like 'TNR-%')`); await q(`delete from users where "employeeCode" like 'TNR-%'`); };
  await wipe();
  const roles = { ADMIN: "TNR-AD", HR: "TNR-HR", MANAGER: "TNR-MG", EMPLOYEE: "TNR-EM" };
  const U = {};
  for (const [role, code] of Object.entries(roles)) {
    const id = (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Notif',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',now(),now()) returning id`, [A, code.toLowerCase() + "@tnr.test", hash, role[0] + role.slice(1).toLowerCase(), code, role]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    U[role] = { id, tok };
  }
  const seed = async (uid, n, type = "TASK_PROPOSED") => {
    const ids = [];
    for (let i = 0; i < n; i++) ids.push((await q(`insert into notifications (id,"platformId","userId",type,title,body,link,"createdAt") values (gen_random_uuid(),$1,$2,$3,$4,'body',null, now() - ($5 || ' seconds')::interval) returning id`, [A, uid, type, `N${i + 1}`, String(i * 10)]))[0].id);
    return ids;
  };

  for (const role of Object.keys(roles)) {
    const me = U[role]; const t = me.tok;
    console.log(`\n## ${role}`);
    const ids = await seed(me.id, 4);
    const g0 = await call("GET", "/notifications", t);
    ok(`${role}: the bell lists the 4 unread and the badge says 4`, g0.s === 200 && g0.b.unread === 4 && g0.b.items.length === 4 && g0.b.items.every((i) => i.readAt === null), g0.b);

    const r1 = await call("POST", `/notifications/${ids[0]}/read`, t);
    ok(`${role}: marking one read saves it (updated 1)`, r1.s === 200 && r1.b.updated === 1, r1);
    const g1 = await call("GET", "/notifications", t);
    ok(`${role}: it is gone from the bell list and the badge drops to 3`, g1.b.unread === 3 && g1.b.items.length === 3 && !g1.b.items.some((i) => i.id === ids[0]), g1.b);
    const row = (await q(`select "readAt","userId" from notifications where id=$1`, [ids[0]]))[0];
    ok(`${role}: the record still exists, readAt is set, it still belongs to this person`, !!row && !!row.readAt && row.userId === me.id, row);
    const g2 = await call("GET", "/notifications", t);
    ok(`${role}: after a refresh (a new request) it does NOT come back to the unread list`, !g2.b.items.some((i) => i.id === ids[0]) && g2.b.unread === 3);
    const again = await call("POST", `/notifications/${ids[0]}/read`, t);
    ok(`${role}: reading it again changes nothing (updated 0, no duplicate)`, again.b.updated === 0 && (await q(`select count(*)::int n from notifications where "userId"=$1`, [me.id]))[0].n === 4);

    const all = await call("GET", "/notifications/page?filter=all&limit=25", t);
    const unr = await call("GET", "/notifications/page?filter=unread&limit=25", t);
    const red = await call("GET", "/notifications/page?filter=read&limit=25", t);
    ok(`${role}: View all > All keeps all 4`, all.b.items.length === 4 && all.b.total === 4 && all.b.unread === 3, all.b);
    ok(`${role}: Unread shows the 3 unread only`, unr.b.items.length === 3 && unr.b.items.every((i) => !i.readAt) && !unr.b.items.some((i) => i.id === ids[0]));
    ok(`${role}: Read shows exactly the one read, still available`, red.b.items.length === 1 && red.b.items[0].id === ids[0] && !!red.b.items[0].readAt, red.b);

    // another person cannot read someone else's notification
    const other = role === "HR" ? U.EMPLOYEE : U.HR;
    const steal = await call("POST", `/notifications/${ids[1]}/read`, other.tok);
    ok(`${role}: another person's attempt to mark it read changes nothing (updated 0, still unread)`, steal.b.updated === 0 && (await q(`select "readAt" from notifications where id=$1`, [ids[1]]))[0].readAt === null, steal);

    const ra = await call("POST", "/notifications/read-all", t);
    ok(`${role}: Mark all as read marks the 3 remaining`, ra.s === 200 && ra.b.updated === 3, ra);
    const g3 = await call("GET", "/notifications", t);
    ok(`${role}: the bell is empty and the badge is 0`, g3.b.unread === 0 && g3.b.items.length === 0, g3.b);
    const all2 = await call("GET", "/notifications/page?filter=all&limit=25", t), red2 = await call("GET", "/notifications/page?filter=read&limit=25", t), unr2 = await call("GET", "/notifications/page?filter=unread&limit=25", t);
    ok(`${role}: history preserved: All 4, Read 4, Unread 0, nothing deleted`, all2.b.items.length === 4 && red2.b.items.length === 4 && unr2.b.items.length === 0 && all2.b.total === 4, [all2.b.total, red2.b.items.length, unr2.b.items.length]);
    ok(`${role}: Mark all again changes nothing`, (await call("POST", "/notifications/read-all", t)).b.updated === 0);
  }

  console.log("\n## more than the bell can list");
  const t = U.HR.tok;
  await seed(U.HR.id, 33);
  const big = await call("GET", "/notifications", t);
  ok("33 new unread: the badge says 33 (the true count) and the list shows the newest 30", big.b.unread === 33 && big.b.items.length === 30, [big.b.unread, big.b.items.length]);
  const first = big.b.items[0];
  await call("POST", `/notifications/${first.id}/read`, t);
  const big2 = await call("GET", "/notifications", t);
  ok("reading one: 32 left, and the list refills from the unread ones (never a read one)", big2.b.unread === 32 && big2.b.items.length === 30 && big2.b.items.every((i) => !i.readAt) && !big2.b.items.some((i) => i.id === first.id));

  console.log("\n## guards");
  ok("not signed in -> 401", (await call("GET", "/notifications")).s === 401 && (await call("POST", "/notifications/read-all")).s === 401);
  ok("a malformed id -> 404, not a database error", (await call("POST", "/notifications/not-an-id/read", t)).s === 404);
  ok("a bad filter value behaves like All (no error)", (await call("GET", "/notifications/page?filter=bogus", t)).s === 200);

  await wipe();
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
