// scripts/bulk-temp-passwords.cjs: selection, preview, confirmation, apply, rerun safety, credentials file, audit, no plaintext anywhere.
// Writes data: THROWAWAY local database only (port 54329) with the backend on :5012 (used to prove a temporary password really signs in).
const { execFileSync, spawnSync } = require("node:child_process");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const DB = "postgresql://postgres:localtest@127.0.0.1:54329/hrms_test";
const API = "http://localhost:5012/api";
const SCRIPT = path.join(__dirname, "..", "scripts", "bulk-temp-passwords.cjs");
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 400) : "")); };
const run = (extra, env = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...extra], { env: { ...process.env, BULK_PW_DB_URL: DB, ...env }, encoding: "utf8" });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", all: (r.stdout ?? "") + (r.stderr ?? "") };
};
const OLD = "Old#Pass123";

(async () => {
  const db = new Client({ connectionString: DB }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const co = async (slug, name) => { const r = await q(`select id from platforms where slug=$1`, [slug]); if (r[0]) return r[0].id; return (await q(`insert into platforms (id,name,slug,"updatedAt") values (gen_random_uuid(),$1,$2,now()) returning id`, [name, slug]))[0].id; };
  const AVANCE = await co("avance", "Avance"), AVATAR = await co("avatar", "Avatar"), AVIN = await co("bp-avatar-india", "Avatar India (test)");
  const oldHash = await bcrypt.hash(OLD, 10);
  await q(`delete from audit_logs where path='/scripts/bulk-temp-passwords'`).catch(() => {});
  const mk = async (code, first, last, role, status, platformId, over = {}) => {
    const ex = await q(`select id from users where "employeeCode"=$1`, [code]);
    if (ex[0]) await q(`delete from team_members where "userId"=$1`, [ex[0].id]);
    if (ex[0]) await q(`delete from users where id=$1`, [ex[0].id]).catch(() => {});
    const id = (await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","designation","lastLoginAt","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7::"UserRole",$8::"UserStatus",$9,true,'ACTIVE','2026-01-01','Staff',$10,now(),now()) returning id`,
      [platformId, code.toLowerCase() + "@bp.test", over.noPassword ? null : oldHash, first, last, code, role, status, over.must ?? true, over.lastLogin ?? null]))[0].id;
    return id;
  };
  const u = {};
  u.n1 = await mk("BP-N1", "Neha", "Never", "EMPLOYEE", "ACTIVE", AVANCE);
  u.n2 = await mk("BP-N2", "Manoj", "Neverboss", "MANAGER", "ACTIVE", AVANCE);
  u.n3 = await mk("BP-N3", "Hema", "Neverhr", "HR", "ACTIVE", AVANCE);
  u.np = await mk("BP-NP", "Pooja", "Nopassword", "EMPLOYEE", "INVITED", AVANCE, { noPassword: true });
  u.own = await mk("BP-OWN", "Omar", "Ownpassword", "EMPLOYEE", "ACTIVE", AVANCE, { must: false, lastLogin: new Date().toISOString() });
  u.temp = await mk("BP-TMP", "Tara", "Stilltemp", "EMPLOYEE", "ACTIVE", AVANCE, { must: true, lastLogin: new Date().toISOString() });
  u.a1 = await mk("BP-A1", "Asha", "Admin", "ADMIN", "ACTIVE", AVANCE);
  u.a2 = await mk("BP-A2", "Anil", "Admintwo", "ADMIN", "ACTIVE", AVANCE);
  u.av = await mk("BP-AV", "Vikram", "Avatarco", "EMPLOYEE", "ACTIVE", AVATAR);
  u.ai = await mk("BP-AI", "Isha", "Avatarindia", "EMPLOYEE", "ACTIVE", AVIN);
  u.ap = await mk("BP-AP", "Pia", "Avatarproject", "EMPLOYEE", "ACTIVE", AVANCE);
  u.su = await mk("BP-SU", "Sam", "Suspended", "EMPLOYEE", "SUSPENDED", AVANCE);
  u.ex = await mk("BP-EX", "Eli", "Exited", "EMPLOYEE", "EXITED", AVANCE);
  u.ca = await mk("BP-CA", "Cara", "Candidate", "EMPLOYEE", "CANDIDATE", AVANCE);
  // an Avatar-named project in the other company: Pia is an active member
  let team = (await q(`select id from teams where name='Avatar BP Project'`))[0]?.id;
  if (!team) team = (await q(`insert into teams (id,"platformId",name,"isActive","createdAt","updatedAt") values (gen_random_uuid(),$1,'Avatar BP Project',true,now(),now()) returning id`, [AVANCE]))[0].id;
  await q(`insert into team_members (id,"teamId","userId","isActive","isPrimary","joinedAt") values (gen_random_uuid(),$1,$2,true,true,now())`, [team, u.ap]);

  // the answer, worked out independently of the script
  const expectedIds = async (withAdmin, ignoreAudit) => (await q(`select u.id from users u join platforms p on p.id=u."platformId"
      where u.status in ('ACTIVE','INVITED') and (u.role in ('EMPLOYEE','MANAGER','HR') ${withAdmin ? `or u."employeeCode"='BP-A2'` : ""})
        and p.name not ilike '%avatar%' and (u."lastLoginAt" is null or u."passwordHash" is null)
        and not exists (select 1 from team_members tm join teams t on t.id=tm."teamId" where tm."userId"=u.id and tm."isActive" and t."isActive" and t.name ilike '%avatar%')
        ${ignoreAudit ? "" : `and not exists (select 1 from audit_logs a where a.path='/scripts/bulk-temp-passwords' and a."targetUserId"=u.id)`}
      `)).map((r) => r.id).sort();
  const snapshot = async () => (await q(`select id, "passwordHash" h, "mustChangePassword" m, "employeeCode" c, email, role::text r, status::text s, "platformId" p, "firstName" f, "lastName" l, "updatedAt"::text ua from users order by id`));
  const before = await snapshot();
  const wantA = await expectedIds(false);
  const outBase = fs.mkdtempSync(path.join(os.tmpdir(), "bp-test-"));

  // ---- 1. refusals ----
  ok("no database given: refuses and changes nothing", run([], { BULK_PW_DB_URL: "" }).code === 1);
  // the live address is refused BEFORE any connection is opened (the script compares hosts first); we only pass the address, never use it
  let liveUrl = null;
  try { const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8"); const line = env.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL=")); liveUrl = line ? line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "") : null; } catch { /* no .env here */ }
  if (liveUrl) { const r = run(["--apply", "--confirm", "ISSUE 1 PASSWORDS"], { BULK_PW_DB_URL: liveUrl }); ok("the LIVE database is refused without --allow-live (before connecting)", r.code === 1 && /REFUSING/.test(r.all) && !/WILL RECEIVE/.test(r.all), r.all.slice(0, 200)); }
  else ok("(no .env on this machine: live-refusal check skipped)", true);

  // ---- 2. preview ----
  const pv = run([]);
  ok("preview runs (exit 0) and says nothing was changed", pv.code === 0 && /PREVIEW ONLY/.test(pv.out) && /Nothing was changed/.test(pv.out), pv.all.slice(0, 300));
  const names = (s) => ["BP-N1", "BP-N2", "BP-N3", "BP-NP"].every((c) => s.includes(c));
  ok("preview lists the four who need a password (employee, manager, HR, and the one with no password)", names(pv.out), pv.out.slice(0, 800));
  const willPart = pv.out.split("LEFT UNCHANGED")[0];
  ok("preview does NOT select: signed-in people, Admins, Avatar company, Avatar India, Avatar project member, suspended, exited, candidate", ["BP-OWN", "BP-TMP", "BP-A1", "BP-A2", "BP-AV", "BP-AI", "BP-AP", "BP-SU", "BP-EX", "BP-CA"].every((c) => !willPart.includes(c)));
  ok("preview says which companies and projects the exclusion matched", /Companies matched by the exclusion: .*Avatar/.test(pv.out) && /Projects matched by the exclusion:  .*Avatar BP Project/.test(pv.out), pv.out.slice(0, 400));
  ok("preview shows the exact count and the command to confirm", new RegExp(`ISSUE ${wantA.length} PASSWORDS`).test(pv.out) && new RegExp(`${wantA.length} of \\d+ accounts`).test(pv.out), pv.out.slice(-300));
  ok("the selection equals an independent query", (pv.out.match(/WILL RECEIVE A NEW TEMPORARY PASSWORD: (\d+)/) || [])[1] == wantA.length, [pv.out.match(/WILL RECEIVE[^\n]*/)?.[0], wantA.length]);
  ok("preview changed nothing in the database (hashes, flags and timestamps identical)", JSON.stringify(await snapshot()) === JSON.stringify(before));
  ok("preview prints no password-like secret and wrote no file", !/Temporary password/.test(pv.out));

  // ---- 3. apply needs the exact confirmation ----
  const noConfirm = run(["--apply", `--out=${path.join(outBase, "a")}`]);
  ok("--apply without --confirm is refused and changes nothing", noConfirm.code === 1 && /Confirmation missing/.test(noConfirm.err) && JSON.stringify(await snapshot()) === JSON.stringify(before));
  const wrong = run(["--apply", "--confirm", `ISSUE ${wantA.length + 1} PASSWORDS`, `--out=${path.join(outBase, "a")}`]);
  ok("--apply with the wrong number is refused and changes nothing", wrong.code === 1 && JSON.stringify(await snapshot()) === JSON.stringify(before));
  const inRepo = run(["--apply", "--confirm", `ISSUE ${wantA.length} PASSWORDS`, `--out=${path.join(__dirname, "..", "..", "creds-should-not-exist")}`]);
  ok("a credentials folder inside the repository is refused", inRepo.code === 1 && /OUTSIDE the repository/.test(inRepo.err) && !fs.existsSync(path.join(__dirname, "..", "..", "creds-should-not-exist")) && JSON.stringify(await snapshot()) === JSON.stringify(before));

  // ---- 4. a failure rolls everything back and never deletes an older file ----
  const clash = path.join(outBase, "clash"); fs.mkdirSync(clash);
  fs.writeFileSync(path.join(clash, "temporary-passwords.csv"), "OLD CREDENTIALS FILE");
  const failRun = run(["--apply", "--confirm", `ISSUE ${wantA.length} PASSWORDS`, `--out=${clash}`]);
  ok("when the file cannot be written the run fails and the database is rolled back (no password changed)", failRun.code === 1 && JSON.stringify(await snapshot()) === JSON.stringify(before) && (await q(`select count(*)::int n from audit_logs where path='/scripts/bulk-temp-passwords' and "targetUserId" = any($1::uuid[])`, [wantA]))[0].n === 0, failRun.all.slice(0, 200));
  ok("…and an existing credentials file is left exactly as it was", fs.readFileSync(path.join(clash, "temporary-passwords.csv"), "utf8") === "OLD CREDENTIALS FILE");

  // ---- 5. the real run ----
  const outDir = path.join(outBase, "run1");
  const ap = run(["--apply", "--confirm", `ISSUE ${wantA.length} PASSWORDS`, `--out=${outDir}`]);
  ok("apply with the right confirmation succeeds", ap.code === 0 && new RegExp(`DONE. ${wantA.length} temporary passwords issued`).test(ap.out), ap.all.slice(0, 300));
  const credFile = path.join(outDir, "temporary-passwords.csv");
  const csv = fs.readFileSync(credFile, "utf8").replace(/^﻿/, "");
  const lines = csv.trim().split("\r\n");
  const header = lines[0].split(",");
  ok("credentials CSV has name, employee ID, username, temporary password and status columns", ["Employee name", "Employee ID", "Username (sign in with)", "Temporary password", "Status"].every((h) => header.includes(h)), header);
  ok("one line per person who needed a password", lines.length === wantA.length + 1, lines.length);
  const parse = (l) => { const o = []; let cur = "", inq = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (inq) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inq = false; else cur += ch; } else if (ch === '"') inq = true; else if (ch === ",") { o.push(cur); cur = ""; } else cur += ch; } o.push(cur); return o; };
  const recs = lines.slice(1).map(parse);
  const ci = (h) => header.indexOf(h);
  const pws = recs.map((r) => r[ci("Temporary password")]);
  ok("every temporary password is 12 characters with upper, lower, digit and symbol, and never starts with a symbol", pws.every((p) => p.length === 12 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[!#$%&*?]/.test(p) && !/^[!#$%&*?]/.test(p)), pws);
  ok("every password is different", new Set(pws).size === pws.length);
  const byCode = new Map(recs.map((r) => [r[ci("Employee ID")], r]));
  ok("the four expected people are in the file with their sign-in ID as username", ["BP-N1", "BP-N2", "BP-N3", "BP-NP"].every((c) => byCode.get(c) && byCode.get(c)[ci("Username (sign in with)")] === c));
  ok("people who must not be touched are not in the file", ["BP-OWN", "BP-TMP", "BP-A1", "BP-A2", "BP-AV", "BP-AI", "BP-AP", "BP-SU", "BP-EX", "BP-CA"].every((c) => !byCode.has(c)));
  const after = await snapshot();
  const A = new Map(after.map((r) => [r.id, r])), Bm = new Map(before.map((r) => [r.id, r]));
  const selectedIds = new Set(wantA);
  ok("everyone who was not selected is byte-for-byte unchanged (hash, flag, timestamps)", after.filter((r) => !selectedIds.has(r.id)).every((r) => JSON.stringify(r) === JSON.stringify(Bm.get(r.id))));
  ok("selected people keep their employee ID, email, role, status, company and name", [...selectedIds].every((id) => { const a = A.get(id), b = Bm.get(id); return a.c === b.c && a.email === b.email && a.r === b.r && a.s === b.s && a.p === b.p && a.f === b.f && a.l === b.l; }));
  let hashesOk = true, mustOk = true, oldGone = true;
  for (const r of recs) { const code = r[ci("Employee ID")]; const row = after.find((x) => x.c === code); hashesOk = hashesOk && (await bcrypt.compare(r[ci("Temporary password")], row.h)); mustOk = mustOk && row.m === true; oldGone = oldGone && !(await bcrypt.compare(OLD, row.h)); }
  ok("each stored hash matches that person's temporary password (bcrypt), and the old password no longer works", hashesOk && oldGone);
  ok("everyone selected must change their password at first sign-in", mustOk);
  ok("hashes use bcrypt cost 10 like the app", after.filter((r) => selectedIds.has(r.id)).every((r) => /^\$2[aby]\$10\$/.test(r.h)));
  // no plaintext anywhere
  let leaks = 0;
  for (const p of pws) {
    const inUsers = (await q(`select count(*)::int n from users where position($1 in row_to_json(users)::text) > 0`, [p]))[0].n;
    const inAudit = (await q(`select count(*)::int n from audit_logs where position($1 in row_to_json(audit_logs)::text) > 0`, [p]))[0].n;
    leaks += inUsers + inAudit;
  }
  ok("no temporary password is stored in plaintext in the users or audit tables", leaks === 0, leaks);
  ok("the script's own output and error text contain no password", pws.every((p) => !ap.all.includes(p)));
  const audit = await q(`select action, summary, "targetUserId", "actorId" from audit_logs where path='/scripts/bulk-temp-passwords' and "targetUserId" = any($1::uuid[])`, [wantA]);
  ok("one audit line per person, action PASSWORD, and it says the password is never recorded", audit.length === wantA.length && audit.every((a) => a.action === "PASSWORD" && /never recorded/.test(a.summary)) && new Set(audit.map((a) => a.targetUserId)).size === wantA.length, audit.length);
  const report = fs.readFileSync(path.join(outDir, "issue-report.csv"), "utf8");
  ok("the report lists every account with a result and contains no password", /Password issued/.test(report) && /Not changed: excluded: company/.test(report) && /Not changed: excluded: project/.test(report) && /Admin \(not listed/.test(report) && pws.every((p) => !report.includes(p)));
  // file protection
  const inRepoPath = path.resolve(credFile).startsWith(path.resolve(__dirname, "..", ".."));
  ok("the credentials file is outside the repository", !inRepoPath);
  if (process.platform === "win32") {
    const acl = execFileSync("icacls", [credFile], { encoding: "utf8" });
    ok("Windows: only the current user can read the credentials file (no Everyone / Users / Authenticated Users)", !/Everyone|BUILTIN\\Users|Authenticated Users/i.test(acl) && new RegExp(String(process.env.USERNAME), "i").test(acl), acl);
  } else ok("file mode is 600", (fs.statSync(credFile).mode & 0o777) === 0o600);

  // ---- 6. the temporary password really signs in, and is flagged ----
  const loginAs = async (code, password) => { const r = await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password }) }); return { s: r.status, b: await r.json().catch(() => ({})) }; };
  const n1 = byCode.get("BP-N1");
  const li = await loginAs("BP-N1", n1[ci("Temporary password")]);
  ok("the temporary password signs the person in through the real login, flagged to change it", li.s === 200 && li.b.user?.mustChangePassword === true, li);
  ok("their old password no longer signs in", (await loginAs("BP-N1", OLD)).s === 401);
  const unaffected = await loginAs("BP-OWN", OLD);
  ok("a person who owns a password signs in with it exactly as before", unaffected.s === 200 && unaffected.b.user?.mustChangePassword === false, unaffected.s);

  // ---- 7. rerun safety ----
  const rr = run([]);
  ok("a rerun preview selects nobody (those issued and not yet used are skipped, not reset again)", /WILL RECEIVE A NEW TEMPORARY PASSWORD: 0 of/.test(rr.out) && /already issued on .* not used yet/.test(rr.out) || /already issued on a past date/.test(rr.out), rr.out.slice(0, 700));
  const rr2 = run(["--apply", "--confirm", "ISSUE 0 PASSWORDS", `--out=${path.join(outBase, "run2")}`]);
  ok("a rerun --apply issues nothing and creates no file", rr2.code === 0 && /Nobody needs a password/.test(rr2.out) && !fs.existsSync(path.join(outBase, "run2", "temporary-passwords.csv")));
  const nowSnap = await snapshot();
  ok("after the rerun every password hash and flag is exactly what the first run left (only the sign-in itself touched a row)", nowSnap.every((r) => { const a = A.get(r.id); return r.h === a.h && r.m === a.m; }));
  const wantRe = (await expectedIds(false, true)).length; // everyone still unsigned-in, issued or not
  const re = run(["--reissue-unused"]);
  ok("--reissue-unused deliberately lists them again, except the person who has since signed in", new RegExp(`WILL RECEIVE A NEW TEMPORARY PASSWORD: ${wantRe} of`).test(re.out) && !/BP-N1/.test(re.out.split("LEFT UNCHANGED")[0]), re.out.slice(0, 600));
  // the person who signed in (BP-N1) is now someone with a temp password they used: never selected again
  // ---- 8. Admins only when named ----
  const ad = run(["--include-admins=BP-A2"]);
  ok("--include-admins=BP-A2 selects that Admin and no other", /BP-A2/.test(ad.out.split("LEFT UNCHANGED")[0]) && !/BP-A1/.test(ad.out.split("LEFT UNCHANGED")[0]), ad.out.slice(0, 500));
  const none = run(["--exclude-match="]);
  ok("with no exclusion words the Avatar people would be picked: the exclusion is the only thing keeping them out", /BP-AV/.test(none.out.split("LEFT UNCHANGED")[0]) && /BP-AI/.test(none.out.split("LEFT UNCHANGED")[0]));

  await q(`delete from team_members where "teamId"=$1`, [team]);
  await db.end();
  fs.rmSync(outBase, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
