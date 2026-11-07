// Owner Admins (ADMIN + all-companies grant) are not regular employees for the document workflow.
// Throwaway database only. Needs the backend on BASE (default http://localhost:5012/api) running against TEST_DATABASE_URL.
//   TEST_DATABASE_URL=postgresql://postgres:localtest@127.0.0.1:54329/hrms_test node tests/owner-admin-documents.test.cjs
const path = require("node:path"), cp = require("node:child_process");
const { assertTestDb } = require("./_guard.cjs");
const B = path.join(__dirname, "..", "node_modules") + path.sep;
const { Client } = require(B + "pg"); const bcrypt = require(B + "bcryptjs");
const URL_ = process.env.TEST_DATABASE_URL; assertTestDb(URL_);
const BASE = process.env.BASE || "http://localhost:5012/api", PW = "Owd@12345678";
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { if (ok) pass++; else fail++; console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : "  -> " + String(d).slice(0, 250))); };
const api = async (method, p, token, body) => { const r = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };
const login = async (code) => (await api("POST", "/auth/login", null, { email: code, password: PW })).j?.token;

(async () => {
  const db = new Client({ connectionString: URL_ }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const P = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `select id from users where "employeeCode" like 'OWD-%'`;
    await q(`delete from employee_documents where "userId" in (${ids})`);
    await q(`delete from company_access where "userId" in (${ids})`);
    await q(`delete from alerts where "userId" in (${ids})`).catch(() => {});
    await q(`delete from users where "employeeCode" like 'OWD-%'`).catch(async () => { /* audit rows pin users: keep them, they are test-only */ });
  };
  await wipe();
  const mk = async (code, first, role, extra = {}) => (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Owner',$5,$6,'ACTIVE',false,true,$7,'2026-01-01',now() - interval '30 hours',now()) returning id`, [P, extra.email ?? code.toLowerCase() + "@owd.test", hash, first, code, role, extra.onboarding ?? "ACTIVE"]))[0].id;
  const grant = (id) => q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [id]);

  // the four owners (names mirror the real ones, but identity is role + grant, never the name)
  const owners = {};
  for (const [code, first] of [["OWD-O1", "Sanjay"], ["OWD-O2", "Jayesh"], ["OWD-O3", "Devang"], ["OWD-O4", "Aayush"]]) { owners[code] = await mk(code, first, "ADMIN"); await grant(owners[code]); }
  // owner who is, in addition, stuck in a joiner stage with a real email and a pending document row: must never be reminded or tracked
  const ownerJoiner = await mk("OWD-O5", "Pending", "ADMIN", { email: "pending.owner@owd-real.com", onboarding: "DOCUMENTS_PENDING" }); await grant(ownerJoiner);
  // NOT owners: same display name as an owner but no grant, an HR with the all-companies grant, a plain Admin, an employee and a joiner employee
  const lookalike = await mk("OWD-L1", "Sanjay", "ADMIN");
  const hr = await mk("OWD-HR", "Hira", "HR"); await grant(hr);
  const admin = await mk("OWD-AD", "Adam", "ADMIN");
  const emp = await mk("OWD-EM", "Emma", "EMPLOYEE");
  const joiner = await mk("OWD-JN", "Joan", "EMPLOYEE", { email: "joan.joiner@owd-real.com", onboarding: "DOCUMENTS_PENDING" });

  // make sure the company has a document checklist, then give the joiner and the owner-joiner a pending row
  const tEmp = await login("OWD-EM"); await api("GET", "/onboarding/me", tEmp);
  const req = (await q(`select id from document_requirements where "platformId"=$1 and "isActive"=true limit 1`, [P]))[0];
  check("the company has a document requirement to test with", !!req);
  for (const uid of [joiner, ownerJoiner]) await q(`insert into employee_documents (id,"platformId","userId","requirementId",category,status,"createdAt","updatedAt") values (gen_random_uuid(),$3,$1,$2,'OTHER','REQUESTED',now(),now())`, [uid, req.id, P]).catch((e) => console.log("seed doc:", e.message));

  const T = {}; for (const c of ["OWD-O1", "OWD-O2", "OWD-O3", "OWD-O4", "OWD-L1", "OWD-HR", "OWD-AD", "OWD-EM"]) T[c] = await login(c);
  check("all test accounts can sign in", Object.values(T).every(Boolean));

  // 1. the flag the screens use
  for (const c of ["OWD-O1", "OWD-O2", "OWD-O3", "OWD-O4"]) { const m = await api("GET", "/auth/me", T[c]); check(`${c}: /auth/me says documents exempt, still ADMIN`, m.j?.documentsExempt === true && m.j?.role === "ADMIN", JSON.stringify(m.j).slice(0, 120)); }
  for (const c of ["OWD-L1", "OWD-HR", "OWD-AD", "OWD-EM"]) { const m = await api("GET", "/auth/me", T[c]); check(`${c}: NOT exempt (${m.j?.role})`, m.j?.documentsExempt === false, JSON.stringify(m.j).slice(0, 120)); }
  const pr = await api("GET", "/auth/me/profile", T["OWD-O3"]); check("owner profile loads and is flagged", pr.s === 200 && pr.j?.documentsExempt === true && pr.j?.role === "ADMIN");

  // 2. personal checklist
  for (const c of ["OWD-O1", "OWD-O2", "OWD-O3", "OWD-O4"]) { const m = await api("GET", "/documents/mine", T[c]); check(`${c}: personal checklist is empty and flagged exempt (nothing "missing")`, m.s === 200 && m.j?.exempt === true && m.j.items.length === 0 && m.j.summary.missing === 0 && m.j.summary.required === 0, JSON.stringify(m.j).slice(0, 150)); }
  for (const c of ["OWD-EM", "OWD-AD", "OWD-HR", "OWD-L1"]) { const m = await api("GET", "/documents/mine", T[c]); check(`${c}: still gets the normal checklist`, m.s === 200 && !m.j?.exempt && m.j.items.length > 0, JSON.stringify(m.j).slice(0, 150)); }

  // 3. organisation-wide module still works and leaves owners out of the counts
  const ownerIds = new Set([...Object.values(owners), ownerJoiner]);
  for (const [who, tok] of [["HR", T["OWD-HR"]], ["owner Admin", T["OWD-O1"]], ["plain Admin", T["OWD-AD"]]]) {
    const t = await api("GET", "/documents/tracking", tok);
    const ids = new Set((t.j?.rows ?? []).map((r) => r.id));
    check(`${who}: Employee tracking opens`, t.s === 200 && Array.isArray(t.j?.rows), t.s);
    check(`${who}: tracking lists NO owner admin`, ![...ownerIds].some((id) => ids.has(id)), [...ownerIds].filter((id) => ids.has(id)).length);
    check(`${who}: tracking still lists employee, joiner, HR, plain Admin and the look-alike`, [emp, joiner, hr, admin, lookalike].every((id) => ids.has(id)), [emp, joiner, hr, admin, lookalike].filter((id) => !ids.has(id)).length + " missing");
  }
  const ta = await api("GET", "/documents/tracking", T["OWD-HR"]);
  const rowsTotal = (await q(`select count(*)::int c from users where "platformId"=$1 and status not in ('EXITED','SUSPENDED') and id not in (${[...ownerIds].map((_, i) => "$" + (i + 2)).join(",")})`, [P, ...ownerIds]))[0].c;
  check("tracking 'people' total = active people of the company minus the owner admins", ta.j?.totals?.people === rowsTotal, `${ta.j?.totals?.people} vs ${rowsTotal}`);
  const reqs = await api("GET", "/onboarding/requirements", T["OWD-O2"]); check("owner Admin can still manage document requirements", reqs.s === 200, reqs.s);
  const one = await api("GET", "/documents/employees/" + emp, T["OWD-O2"]); check("owner Admin can open an employee's document checklist", one.s === 200, one.s);
  const cand = await api("GET", "/onboarding/candidates", T["OWD-HR"]); const cids = new Set((cand.j?.candidates ?? cand.j?.rows ?? cand.j ?? []).map?.((c) => c.id) ?? []);
  check("joiners list: shows the employee joiner, not the owner admin", cand.s === 200 && cids.has(joiner) && !cids.has(ownerJoiner), `${cand.s} joiner:${cids.has(joiner)} owner:${cids.has(ownerJoiner)}`);
  const hrOwn = await api("GET", "/documents/tracking", T["OWD-HR"]); check("HR can still verify: tracking opens for HR", hrOwn.s === 200);
  const emp403 = await api("GET", "/documents/tracking", T["OWD-EM"]); check("employee still cannot open the organisation tracking", emp403.s === 403 || emp403.s === 404, emp403.s);

  // 4. reminders: only the joiner is reminded; the owner stuck in a joiner stage never is
  const run = cp.spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, "_owd-reminders.mts")], { cwd: path.join(__dirname, ".."), encoding: "utf8", env: { ...process.env, DATABASE_URL: URL_, DIRECT_URL: URL_, SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "" } });
  const n = Number((/REMINDERS=([0-9]+)/.exec(run.stdout) || [])[1]);
  check("reminders: exactly one person qualifies (the employee joiner), the owner admin is skipped", n === 1, run.stdout.slice(-200) + run.stderr.slice(-200));

  // 5. nothing destroyed, roles unchanged
  const still = await q(`select count(*)::int c from users where id = any($1::uuid[]) and role='ADMIN'`, [Object.values(owners)]);
  check("the four owners are still ADMIN and still exist", still[0].c === 4);
  check("document rows are untouched (owner joiner's row still exists)", (await q(`select count(*)::int c from employee_documents where "userId"=$1`, [ownerJoiner]))[0].c === 1);

  await wipe(); await db.end();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
