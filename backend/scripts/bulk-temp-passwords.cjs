// Issue temporary login passwords to existing employees in bulk.
//
// WHAT IT DOES
//   1. Reads every account from the database (nobody types IDs).
//   2. Picks the accounts that NEED a password: ACTIVE or INVITED people (Employee, Manager, HR) who have NEVER signed in, or who have no
//      password at all. Anybody who has signed in has a password they know, so they are never touched.
//   3. Leaves out: Admin accounts (unless you name them with --include-admins=code1,code2), suspended / exited / candidate accounts, anyone
//      whose COMPANY or an active PROJECT has a name containing "avatar" (change with --exclude-match=word1,word2), and anyone who was already
//      issued a password by this script and has not used it yet (re-issue those on purpose with --reissue-unused).
//   4. Gives each a unique, cryptographically random temporary password, stores ONLY its bcrypt hash (cost 10, the same as the app), and sets
//      mustChangePassword so the person must choose their own password at first sign-in. Employee IDs, sign-in IDs, emails, roles, companies and
//      every other record are untouched.
//   5. Writes the credentials to a CSV OUTSIDE the repository, readable only by you, and one audit line per person (the password itself is never
//      recorded anywhere but that file).
//
// SAFE BY DEFAULT
//   * PREVIEW ONLY unless you add --apply. The preview prints names and reasons, never passwords, and writes nothing.
//   * --apply also needs --confirm "ISSUE <N> PASSWORDS" with the exact N shown by the preview, so a changed list cannot slip through.
//   * The database comes from BULK_PW_DB_URL (never from .env). The live database is refused unless --allow-live is also given: do that ONLY with
//     the owner's explicit approval.
//   * One transaction: all people or none. The credentials file is written and flushed BEFORE the commit; if the commit fails the file is deleted.
//   * Re-running is safe: people already issued a password (and not yet signed in) are skipped, and people who signed in are never selected.
//   * Nothing is emailed or sent anywhere. Passwords are never printed or logged.
//
//   BULK_PW_DB_URL=... node scripts/bulk-temp-passwords.cjs                                     (preview)
//   BULK_PW_DB_URL=... node scripts/bulk-temp-passwords.cjs --apply --confirm "ISSUE 31 PASSWORDS"  (issue; N from the preview)
//   options: --exclude-match=avatar  --include-admins=code1,code2  --reissue-unused  --out=<folder outside the repo>  --allow-live
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const B = path.join(__dirname, "..", "node_modules") + path.sep;
const { Client } = require(B + "pg");
const bcrypt = require(B + "bcryptjs");

const BCRYPT_COST = 10; // the same cost the application uses (admin.service.ts, auth)
const SCRIPT_PATH = "/scripts/bulk-temp-passwords";
const ELIGIBLE_STATUS = ["ACTIVE", "INVITED"];
const ELIGIBLE_ROLES = ["EMPLOYEE", "MANAGER", "HR"];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
// an option's value can be written --name=value or --name "value"
const val = (n) => {
  const i = args.findIndex((x) => x === n || x.startsWith(n + "="));
  if (i < 0) return null;
  if (args[i] === n) return args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : "";
  return args[i].slice(n.length + 1);
};
const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

// ---------------------------------------------------------------------------------------------------- password generation
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ", LOWER = "abcdefghijkmnopqrstuvwxyz", DIGIT = "23456789", SYMBOL = "!#$%&*?"; // no look-alikes (0 O 1 l I)
const pick = (set) => set[crypto.randomInt(set.length)];
/** 12 characters, at least one of each kind, never starting with a symbol (a leading = + - @ would run as a formula in a spreadsheet). */
function makePassword() {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  const all = UPPER + LOWER + DIGIT + SYMBOL;
  while (chars.length < 12) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; } // Fisher-Yates
  if (SYMBOL.includes(chars[0])) { const k = chars.findIndex((c) => !SYMBOL.includes(c)); [chars[0], chars[k]] = [chars[k], chars[0]]; }
  return chars.join("");
}

function liveHost() {
  try {
    const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const line = env.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL=") || l.startsWith("DIRECT_URL="));
    return line ? new URL(line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")).host : null;
  } catch { return null; }
}
const csvCell = (v) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // a name or note that starts with = + - @ must not run as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

// ---------------------------------------------------------------------------------------------------- who needs a password
async function plan(db, opts) {
  const q = async (s, p) => (await db.query(s, p)).rows;
  const words = opts.excludeMatch.map((w) => w.toLowerCase());
  const matches = (name) => words.some((w) => String(name ?? "").toLowerCase().includes(w));
  const users = await q(`select u.id, u."employeeCode" code, u.email, u."firstName" "first", u."lastName" "last", u.role::text role, u.status::text status, u."platformId",
      p.name company, (u."passwordHash" is null) "noPassword", u."mustChangePassword" must, u."lastLoginAt" "lastLogin"
    from users u join platforms p on p.id = u."platformId" order by p.name, u."firstName", u."lastName"`);
  const projects = await q(`select tm."userId", t.name from team_members tm join teams t on t.id = tm."teamId" where tm."isActive" and t."isActive"`);
  const projectsOf = new Map();
  for (const r of projects) projectsOf.set(r.userId, [...(projectsOf.get(r.userId) ?? []), r.name]);
  const issued = await q(`select "targetUserId" id, max("createdAt") "at" from audit_logs where path = $1 and module = 'Employees' and action = 'PASSWORD' and "targetUserId" is not null group by 1`, [SCRIPT_PATH]);
  const issuedAt = new Map(issued.map((r) => [r.id, r.at]));
  const adminCodes = new Set(opts.includeAdmins.map((c) => c.toLowerCase()));

  const selected = [], skipped = [];
  for (const u of users) {
    const name = `${u.first} ${u.last}`.trim();
    const base = { id: u.id, name, code: u.code, email: u.email, company: u.company, role: u.role, status: u.status };
    const skip = (why) => skipped.push({ ...base, why });
    if (!ELIGIBLE_STATUS.includes(u.status)) { skip(`status ${u.status.toLowerCase()}`); continue; }
    if (u.role === "ADMIN") {
      if (!adminCodes.has(String(u.code ?? "").toLowerCase())) { skip("Admin (not listed in --include-admins)"); continue; }
    } else if (!ELIGIBLE_ROLES.includes(u.role)) { skip(`role ${u.role.toLowerCase()}`); continue; }
    if (matches(u.company)) { skip(`excluded: company "${u.company}"`); continue; }
    const hit = (projectsOf.get(u.id) ?? []).find(matches);
    if (hit) { skip(`excluded: project "${hit}"`); continue; }
    const needs = u.noPassword || !u.lastLogin;
    if (!needs) { skip("has signed in: owns a password"); continue; }
    const at = issuedAt.get(u.id);
    if (at && !opts.reissueUnused && (!u.lastLogin || new Date(u.lastLogin) <= new Date(at))) { skip(`already issued on ${day(at)}, not used yet (use --reissue-unused to issue again)`); continue; }
    selected.push({ ...base, reason: u.noPassword ? "No password set" : at ? "Issued before, never signed in (re-issue)" : "Never signed in" });
  }
  const matched = {
    companies: [...new Set(users.map((u) => u.company))].filter(matches).sort(),
    projects: [...new Set(projects.map((p) => p.name))].filter(matches).sort(),
  };
  return { selected, skipped, matched, total: users.length };
}

function lockDown(file) {
  if (process.platform === "win32") {
    // remove inherited access and leave read/write for the current user only
    const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:(R,W)`], { stdio: "ignore" });
  } else fs.chmodSync(file, 0o600);
}

(async () => {
  const url = process.env.BULK_PW_DB_URL;
  if (!url) throw new Error("Set BULK_PW_DB_URL (the database to read and change).");
  const host = new URL(url).host;
  const isLive = host === liveHost();
  if (isLive && !flag("--allow-live")) throw new Error("REFUSING: BULK_PW_DB_URL is the live database. It needs --allow-live and the owner's explicit approval.");
  const APPLY = flag("--apply");
  const opts = { excludeMatch: val("--exclude-match") === null ? ["avatar"] : list(val("--exclude-match")), includeAdmins: list(val("--include-admins")), reissueUnused: flag("--reissue-unused") };
  console.log(`database: ${isLive ? "LIVE" : "not live"} (${host.slice(0, 28)})   mode: ${APPLY ? "ISSUE PASSWORDS" : "PREVIEW ONLY (nothing is changed)"}`);
  console.log(`left out: companies or active projects containing ${opts.excludeMatch.map((w) => `"${w}"`).join(", ") || "(none)"}; Admins ${opts.includeAdmins.length ? `except ${opts.includeAdmins.join(", ")}` : "(all left out)"}\n`);

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const p = await plan(db, opts);
    console.log(`Companies matched by the exclusion: ${p.matched.companies.join(", ") || "none"}`);
    console.log(`Projects matched by the exclusion:  ${p.matched.projects.join(", ") || "none"}\n`);
    console.log(`WILL RECEIVE A NEW TEMPORARY PASSWORD: ${p.selected.length} of ${p.total} accounts`);
    for (const s of p.selected) console.log(`  ${s.name.padEnd(28)} ${String(s.code ?? "").padEnd(14)} ${s.role.padEnd(9)} ${s.company.padEnd(26)} ${s.reason}`);
    const why = new Map();
    for (const s of p.skipped) { const k = s.why.replace(/".*"/, "…").replace(/on \d{4}-\d{2}-\d{2}/, "on a past date"); why.set(k, (why.get(k) ?? 0) + 1); }
    console.log(`\nLEFT UNCHANGED: ${p.skipped.length} accounts`);
    for (const [k, n] of [...why.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
    const avatar = p.skipped.filter((s) => s.why.startsWith("excluded"));
    if (avatar.length) { console.log(`\nLeft out by the exclusion (${avatar.length}):`); for (const s of avatar) console.log(`  ${s.name.padEnd(28)} ${String(s.code ?? "").padEnd(14)} ${s.why}`); }

    if (!APPLY) {
      console.log(`\nNothing was changed. To issue these ${p.selected.length} passwords run the same command with:  --apply --confirm "ISSUE ${p.selected.length} PASSWORDS"`);
      return;
    }
    if (p.selected.length === 0) { console.log("\nNobody needs a password. Nothing was changed."); return; }
    const want = `ISSUE ${p.selected.length} PASSWORDS`;
    if (val("--confirm") !== want) throw new Error(`Confirmation missing or wrong. This run would change ${p.selected.length} accounts. Add:  --confirm "${want}"`);

    // ---- where the credentials go: outside the repository, readable only by the current user ----
    const repoRoot = path.resolve(__dirname, "..", "..");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.resolve(val("--out") ?? path.join(os.homedir(), "productivity-backups", `temporary-passwords-${stamp}`));
    if (dir === repoRoot || dir.startsWith(repoRoot + path.sep)) throw new Error("REFUSING: the credentials folder must be OUTSIDE the repository (a password file must never reach Git).");
    fs.mkdirSync(dir, { recursive: true });
    const credFile = path.join(dir, "temporary-passwords.csv");
    const reportFile = path.join(dir, "issue-report.csv");

    // ---- generate (unique), hash, write, then commit ----
    const seen = new Set();
    const rows = [];
    for (const s of p.selected) {
      let pw;
      do { pw = makePassword(); } while (seen.has(pw));
      seen.add(pw);
      rows.push({ ...s, pw, hash: await bcrypt.hash(pw, BCRYPT_COST) });
    }
    await db.query("begin");
    let fd = null;
    const created = []; // only files THIS run created are ever deleted on failure; an earlier run's file is never touched
    try {
      const changed = [], changedOut = [];
      for (const r of rows) {
        // re-check inside the transaction: somebody may have signed in between the preview and now
        const cur = (await db.query(`select status::text status, "lastLoginAt" "lastLogin", "passwordHash" is null "noPassword" from users where id = $1 for update`, [r.id])).rows[0];
        const stillNeeds = cur && ELIGIBLE_STATUS.includes(cur.status) && (cur.noPassword || !cur.lastLogin);
        if (!stillNeeds) { changedOut.push({ ...r, status2: "Skipped: signed in or changed since the preview" }); continue; }
        await db.query(`update users set "passwordHash" = $2, "mustChangePassword" = true, "updatedAt" = now() where id = $1`, [r.id, r.hash]);
        await db.query(
          `insert into audit_logs (id,"platformId","actorId",method,path,status,module,action,"recordType","recordId","targetUserId",summary,before,after,"createdAt") values (gen_random_uuid(),$1,null,'SCRIPT',$2,200,'Employees','PASSWORD','User',$3::text,$3::uuid,$4,$5,$6,now())`,
          [(await db.query(`select "platformId" from users where id=$1`, [r.id])).rows[0].platformId, SCRIPT_PATH, r.id, "Temporary password issued in bulk (the password itself is never recorded); the person must change it at first sign-in", JSON.stringify({ mustChangePassword: false }), JSON.stringify({ mustChangePassword: true, reason: r.reason })]
        );
        changed.push(r);
      }
      const at = new Date().toISOString();
      const head = ["Employee name", "Employee ID", "Username (sign in with)", "Work email", "Company", "Role", "Temporary password", "Status", "Issued at"];
      const lines = [head, ...changed.map((r) => [r.name, r.code ?? "", r.code ?? r.email, r.email, r.company, r.role, r.pw, "Password issued: must be changed at first sign-in", at])];
      fd = fs.openSync(credFile, "wx", 0o600); // 'wx': never overwrite an existing credentials file
      created.push(credFile);
      fs.writeSync(fd, "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      lockDown(credFile);
      const rep = [["Employee name", "Employee ID", "Company", "Role", "Result"], ...changed.map((r) => [r.name, r.code ?? "", r.company, r.role, "Password issued (must change at first sign-in)"]), ...changedOut.map((r) => [r.name, r.code ?? "", r.company, r.role, r.status2]), ...p.skipped.map((r) => [r.name, r.code ?? "", r.company, r.role, `Not changed: ${r.why}`])];
      fs.writeFileSync(reportFile, "﻿" + rep.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n", { flag: "wx", mode: 0o600 });
      created.push(reportFile);
      await db.query("commit");
      console.log(`\nDONE. ${changed.length} temporary passwords issued${changedOut.length ? `, ${changedOut.length} skipped because they signed in meanwhile` : ""}.`);
      console.log(`Credentials (keep private, give each person only their own line): ${credFile}`);
      console.log(`Report without passwords: ${reportFile}`);
      console.log("Nothing was emailed. Each person must choose their own password at first sign-in.");
    } catch (e) {
      try { if (fd !== null) fs.closeSync(fd); } catch { /* ignore */ }
      await db.query("rollback").catch(() => {});
      for (const f of created) { try { fs.unlinkSync(f); } catch { /* already gone */ } } // a rolled-back run leaves none of its own credentials behind
      throw e;
    }
  } finally {
    await db.end();
  }
})().catch((e) => { console.error("\nSTOPPED: " + (e && e.message ? e.message : e)); process.exit(1); });
