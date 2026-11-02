// Employee profile photos over HTTP: who can set, replace, remove and see one; format and size checks; cleanup.
// Disposable database only (see _guard.cjs). Needs migration 20261102130000_user_photos applied there.
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/photos.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const ct = r.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await r.json().catch(() => ({})) : Buffer.from(await r.arrayBuffer());
  return { s: r.status, b: body, ct, cc: r.headers.get("cache-control") };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 300))); };
const PW = "Photo@12345678";

// a real 1x1 PNG and JPEG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF"), Buffer.alloc(40, 1), Buffer.from([0xff, 0xd9])]);
const asData = (buf, mime) => `data:${mime};base64,${buf.toString("base64")}`;

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'PHO-%')`;
    const keys = (await q(`select "storageKey" k from user_photos where "userId" in ${ids}`)).map((r) => r.k);
    await q(`delete from user_photos where "userId" in ${ids}`);
    if (keys.length) await q(`delete from stored_blobs where "storageKey" = any($1)`, [keys]);
    await q(`delete from company_access where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'PHO-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Pho',$5,$6,'ACTIVE',false,true,'ACTIVE',now(),now())`, [platformId, code.toLowerCase() + "@pho.test", hash, code.replace("PHO-", "T"), code, role]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token;
    return { id, tok };
  };
  const HR = await mk("PHO-HR", "HR", A), HR2 = await mk("PHO-HR2", "HR", A), ADM = await mk("PHO-ADM", "ADMIN", A);
  const M = await mk("PHO-M", "MANAGER", A), E = await mk("PHO-E", "EMPLOYEE", A), E2 = await mk("PHO-E2", "EMPLOYEE", A);
  const EB = await mk("PHO-EB", "EMPLOYEE", B), HRB = await mk("PHO-HRB", "HR", B);
  await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,$2,now())`, [HR2.id, B]); // HR2 is also assigned company B

  console.log("\n## 1. HR sets a photo");
  const set = await call("PUT", `/photos/${E.id}`, HR.tok, { data: asData(PNG, "image/png") });
  ok("HR uploads a PNG for an employee of their company (200)", set.s === 200, set);
  ok("it is stored against that employee only", (await q(`select "userId" from user_photos where "userId" in ($1,$2)`, [E.id, E2.id])).length === 1);
  ok("the image is in the private file store, folder photos", (await q(`select folder, "mimeType" from stored_blobs where "storageKey"=(select "storageKey" from user_photos where "userId"=$1)`, [E.id]))[0]?.folder === "photos");
  ok("the employee's profile now says they have a photo", !!(await call("GET", "/auth/me", E.tok)).b.photoAt);
  ok("the Employees list carries it too", !!(await call("GET", "/admin/users", HR.tok)).b.users.find((u) => u.id === E.id)?.photoAt);

  console.log("\n## 2. Who can see it");
  const own = await call("GET", `/photos/${E.id}`, E.tok);
  ok("the person sees their own photo (image bytes, private cache)", own.s === 200 && /image\/png/.test(own.ct) && /private/.test(own.cc ?? "") && Buffer.compare(own.b, PNG) === 0, { s: own.s, ct: own.ct, cc: own.cc });
  ok("a colleague in the same company sees it", (await call("GET", `/photos/${E.id}`, E2.tok)).s === 200);
  ok("a manager in the company sees it", (await call("GET", `/photos/${E.id}`, M.tok)).s === 200);
  ok("someone from ANOTHER company does not (404)", (await call("GET", `/photos/${E.id}`, EB.tok)).s === 404 && (await call("GET", `/photos/${E.id}`, HRB.tok)).s === 404);
  ok("HR assigned this company sees it", (await call("GET", `/photos/${EB.id}`, HR2.tok)).s === 404 /* EB has no photo yet */ && (await call("PUT", `/photos/${EB.id}`, HR2.tok, { data: asData(JPG, "image/jpeg") })).s === 200 && (await call("GET", `/photos/${EB.id}`, HR2.tok)).s === 200);
  ok("no sign-in, no photo (401)", (await call("GET", `/photos/${E.id}`)).s === 401);
  ok("a person with no photo answers 404", (await call("GET", `/photos/${E2.id}`, E.tok)).s === 404);

  console.log("\n## 3. Who can change it");
  ok("an employee cannot change their own (404)", (await call("PUT", `/photos/${E.id}`, E.tok, { data: asData(PNG, "image/png") })).s === 404);
  ok("an employee cannot change someone else's (404)", (await call("PUT", `/photos/${E2.id}`, E.tok, { data: asData(PNG, "image/png") })).s === 404);
  ok("a manager cannot (404)", (await call("PUT", `/photos/${E2.id}`, M.tok, { data: asData(PNG, "image/png") })).s === 404);
  ok("HR of another company cannot (404)", (await call("PUT", `/photos/${E.id}`, HRB.tok, { data: asData(PNG, "image/png") })).s === 404);
  ok("an employee cannot remove one (404) and it is still there", (await call("DELETE", `/photos/${E.id}`, E2.tok)).s === 404 && (await q(`select 1 from user_photos where "userId"=$1`, [E.id])).length === 1);
  ok("an Admin of the company can", (await call("PUT", `/photos/${E2.id}`, ADM.tok, { data: asData(JPG, "image/jpeg") })).s === 200);

  console.log("\n## 4. What is accepted");
  const bad = async (data, label, want) => { const r = await call("PUT", `/photos/${E.id}`, HR.tok, { data }); ok(label, r.s === want, r); };
  await bad(asData(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/png"), "an SVG pretending to be a PNG is refused (415)", 415);
  await bad(asData(Buffer.from("<html><script>alert(1)</script></html>"), "image/jpeg"), "HTML renamed to JPEG is refused (415)", 415);
  await bad(asData(Buffer.from("%PDF-1.7 hello"), "application/pdf"), "a PDF is refused (415)", 415);
  await bad(asData(Buffer.concat([JPG, Buffer.alloc(2 * 1024 * 1024)]), "image/jpeg"), "a photo over 2 MB is refused (413)", 413);
  await bad("", "an empty upload is refused (400)", 400);
  ok("nothing bad was stored", (await q(`select count(*)::int n from user_photos where "userId"=$1`, [E.id]))[0].n === 1);
  ok("a bad id is a 404, not a server error", (await call("GET", "/photos/not-a-uuid", HR.tok)).s === 404);

  console.log("\n## 5. Replace and remove clean up");
  const oldKey = (await q(`select "storageKey" k from user_photos where "userId"=$1`, [E.id]))[0].k;
  ok("replacing works (200)", (await call("PUT", `/photos/${E.id}`, HR.tok, { data: asData(JPG, "image/jpeg") })).s === 200);
  const newKey = (await q(`select "storageKey" k from user_photos where "userId"=$1`, [E.id]))[0].k;
  ok("still one record, a new file", newKey !== oldKey && (await q(`select count(*)::int n from user_photos where "userId"=$1`, [E.id]))[0].n === 1);
  ok("the old image file was deleted", (await q(`select 1 from stored_blobs where "storageKey"=$1`, [oldKey])).length === 0);
  ok("HR removes it (200)", (await call("DELETE", `/photos/${E.id}`, HR.tok)).s === 200);
  ok("the record and the file are gone, so initials show again", (await q(`select 1 from user_photos where "userId"=$1`, [E.id])).length === 0 && (await q(`select 1 from stored_blobs where "storageKey"=$1`, [newKey])).length === 0 && (await call("GET", "/auth/me", E.tok)).b.photoAt === null);
  ok("every change is in the audit log", (await q(`select 1 from audit_logs where "targetUserId"=$1 and summary like '%profile photo%'`, [E.id])).length >= 2);

  console.log("\n## 6. Nothing else was touched");
  ok("the employee record and the old avatarUrl column are unchanged", (await q(`select "avatarUrl" from users where id=$1`, [E.id]))[0].avatarUrl === null);

  await wipe();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
