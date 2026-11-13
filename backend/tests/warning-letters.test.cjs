// Warning letters over HTTP with real sign-ins: issue (upload and typed), the employee's own list, view/download, acknowledgment, isolation between
// employees and companies, and that Offer letter / Payslips / the document checklist are untouched. Disposable database only (see _guard.cjs).
//
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/warning-letters.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5002/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);

const call = async (m, p, t, body) => {
  const r = await fetch(API + p, { method: m, headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(body && m !== "GET" ? { "content-type": "application/json" } : {}) }, body: body && m !== "GET" ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let j; try { j = JSON.parse(buf.toString("utf8")); } catch { j = null; }
  return { s: r.status, b: j, raw: buf, h: r.headers };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Twl@12345678";
// a tiny but real PDF
const PDF = "data:application/pdf;base64," + Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF").toString("base64");

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='avance'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    const ids = `(select id from users where "employeeCode" like 'TWL-%')`;
    await q(`delete from employee_documents where "userId" in ${ids}`);
    await q(`delete from notifications where "userId" in ${ids}`);
    await q(`delete from users where "employeeCode" like 'TWL-%'`);
  };
  await wipe();
  const mk = async (code, role, platformId, first) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","dateOfJoining","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,$4,'Wl',$5,$6,'ACTIVE',false,true,'ACTIVE','2026-01-01',now(),now())`, [platformId, code.toLowerCase() + "@twl.test", hash, first, code, role]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    const tok = (await (await fetch(API + "/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: code, password: PW }) })).json()).token;
    return { id, tok };
  };
  const HR = await mk("TWL-HR", "HR", A, "Hira");
  const HRB = await mk("TWL-HRB", "HR", B, "Hubert");         // HR of ANOTHER company, no grant
  const ADMIN = await mk("TWL-ADMIN", "ADMIN", A, "Adam");
  const MGR = await mk("TWL-MGR", "MANAGER", A, "Mani");
  const E1 = await mk("TWL-E1", "EMPLOYEE", A, "Eve");
  const E2 = await mk("TWL-E2", "EMPLOYEE", A, "Eli");
  const EB = await mk("TWL-EB", "EMPLOYEE", B, "Ben");

  const issue = (who, body) => call("POST", "/warning-letters", who.tok, body);
  const mine = async (who) => (await call("GET", "/warning-letters/mine", who.tok)).b?.letters;
  const docCount = async (uid) => (await q(`select count(*)::int n from employee_documents where "userId"=$1`, [uid]))[0].n;

  try {
    // empty state: real data, nothing invented
    ok("an employee with no letters gets an empty list (no dummy records)", Array.isArray(await mine(E1)) && (await mine(E1)).length === 0);

    // 1. HR issues an uploaded PDF
    const r1 = await issue(HR, { userId: E1.id, title: "First warning: late arrival", reason: "Late on five days in October", issueDate: "2026-11-10", file: { data: PDF, fileName: "warning-1.pdf", mimeType: "application/pdf" } });
    ok("HR issues an uploaded PDF letter", r1.s === 200 && r1.b.title === "First warning: late arrival", r1);
    ok("the response carries name, issue date, reason and the issuing authority", r1.b.issueDate === "2026-11-10" && r1.b.reason === "Late on five days in October" && r1.b.issuedBy?.name === "Hira Wl" && r1.b.isPdf === true && r1.b.acknowledgedAt === null, r1.b);

    // 2. it appears in the employee's profile automatically
    const m1 = await mine(E1);
    ok("it appears in the employee's own list", m1.length === 1 && m1[0].title === "First warning: late arrival" && m1[0].issuedBy.name === "Hira Wl", m1);
    ok("it does NOT appear for another employee of the same company", (await mine(E2)).length === 0);
    ok("it does NOT appear for an employee of another company", (await mine(EB)).length === 0);

    // 3. typed letter -> a real PDF is built
    const r2 = await issue(HR, { userId: E1.id, title: "Second warning", reason: "Continued lateness", text: "This is the second written warning.\nPlease improve your attendance with immediate effect.", issueDate: "2026-11-12" });
    ok("HR issues a typed letter (the system builds the PDF)", r2.s === 200 && r2.b.isPdf === true, r2);
    const f2 = await call("GET", `/warning-letters/${r2.b.id}/file`, E1.tok);
    ok("the typed letter's file is a real PDF", f2.s === 200 && f2.raw.subarray(0, 5).toString() === "%PDF-" && f2.h.get("content-type") === "application/pdf", { s: f2.s, head: f2.raw.subarray(0, 8).toString() });

    // 4. several letters are all shown, newest first
    const m2 = await mine(E1);
    ok("both letters are listed, newest issue date first", m2.length === 2 && m2[0].title === "Second warning" && m2[1].title === "First warning: late arrival", m2.map((l) => l.title));

    // 5. view / download with the right headers
    const view = await call("GET", `/warning-letters/${r1.b.id}/file`, E1.tok);
    ok("View: the employee gets the file inline, private and not cached", view.s === 200 && /^inline/.test(view.h.get("content-disposition")) && /no-store/.test(view.h.get("cache-control")) && view.h.get("x-content-type-options") === "nosniff", { s: view.s, h: [...view.h] });
    const dl = await call("GET", `/warning-letters/${r1.b.id}/file?download=1`, E1.tok);
    ok("Download: attachment with the file name", dl.s === 200 && /^attachment; filename="warning-1.pdf"/.test(dl.h.get("content-disposition")), dl.h.get("content-disposition"));
    ok("the downloaded bytes are the uploaded bytes", dl.raw.toString("latin1").startsWith("%PDF-1.4"));

    // 6. isolation: nobody else can read it
    ok("another employee cannot open it (404)", (await call("GET", `/warning-letters/${r1.b.id}/file`, E2.tok)).s === 404);
    ok("another company's employee cannot open it (404)", (await call("GET", `/warning-letters/${r1.b.id}/file`, EB.tok)).s === 404);
    ok("a manager cannot open it (404)", (await call("GET", `/warning-letters/${r1.b.id}/file`, MGR.tok)).s === 404);
    ok("HR of ANOTHER company cannot open it (404)", (await call("GET", `/warning-letters/${r1.b.id}/file`, HRB.tok)).s === 404);
    ok("no sign-in is refused (401)", (await call("GET", `/warning-letters/${r1.b.id}/file`, null)).s === 401 && (await call("GET", "/warning-letters/mine", null)).s === 401);
    ok("HR of the same company can open it", (await call("GET", `/warning-letters/${r1.b.id}/file`, HR.tok)).s === 200);
    ok("an Admin of the same company can open it", (await call("GET", `/warning-letters/${r1.b.id}/file`, ADMIN.tok)).s === 200);
    ok("a made-up id is a clean 404", (await call("GET", `/warning-letters/00000000-0000-4000-8000-000000000000/file`, E1.tok)).s === 404);
    ok("a malformed id is a clean 404, not a 500", (await call("GET", `/warning-letters/not-an-id/file`, E1.tok)).s === 404);

    // 7. who may issue
    ok("an employee cannot issue (403)", (await issue(E1, { userId: E2.id, title: "Nope nope", reason: "Nope nope", file: { data: PDF, fileName: "a.pdf", mimeType: "application/pdf" } })).s === 403);
    ok("a manager cannot issue (403)", (await issue(MGR, { userId: E2.id, title: "Nope nope", reason: "Nope nope", file: { data: PDF, fileName: "a.pdf", mimeType: "application/pdf" } })).s === 403);
    ok("HR of another company cannot issue to this employee (404, the person does not exist for them)", (await issue(HRB, { userId: E1.id, title: "Cross company", reason: "Cross company", file: { data: PDF, fileName: "a.pdf", mimeType: "application/pdf" } })).s === 404);
    ok("HR cannot issue to themselves", (await issue(HR, { userId: HR.id, title: "Self warning", reason: "Self warning", file: { data: PDF, fileName: "a.pdf", mimeType: "application/pdf" } })).s === 403);
    ok("an Admin can issue", (await issue(ADMIN, { userId: E2.id, title: "Admin issued", reason: "Reason by admin", text: "A written warning issued by an Admin.\nPlease note it." })).s === 200);
    ok("HR can list one employee's letters; another company's HR cannot", (await call("GET", `/warning-letters/person/${E1.id}`, HR.tok)).b?.letters?.length === 2 && (await call("GET", `/warning-letters/person/${E1.id}`, HRB.tok)).s === 404);
    ok("an employee cannot use the HR list (403)", (await call("GET", `/warning-letters/person/${E1.id}`, E2.tok)).s === 403);

    // 8. input checks
    const base = { userId: E1.id, title: "Valid title", reason: "Valid reason" };
    const pdfFile = { data: PDF, fileName: "x.pdf", mimeType: "application/pdf" };
    const code = async (b) => (await issue(HR, b)).s;
    ok("name too short -> 400", (await code({ ...base, title: "ab", file: pdfFile })) === 400);
    ok("reason missing -> 400", (await code({ ...base, reason: "", file: pdfFile })) === 400);
    ok("nothing attached -> 400", (await code({ ...base })) === 400);
    ok("a file AND text -> 400", (await code({ ...base, file: pdfFile, text: "x".repeat(40) })) === 400);
    ok("a future issue date -> 400", (await code({ ...base, file: pdfFile, issueDate: "2999-01-01" })) === 400);
    ok("a malformed issue date -> 400", (await code({ ...base, file: pdfFile, issueDate: "12/11/2026" })) === 400);
    ok("HTML claiming to be a PDF -> 415", (await code({ ...base, file: { data: "data:application/pdf;base64," + Buffer.from("<html><script>alert(1)</script></html>").toString("base64"), fileName: "x.pdf", mimeType: "application/pdf" } })) === 415);
    ok("an HTML / SVG file type -> 415", (await code({ ...base, file: { data: "data:text/html;base64," + Buffer.from("<b>x</b>").toString("base64"), fileName: "x.html", mimeType: "text/html" } })) === 415 && (await code({ ...base, file: { data: "data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64"), fileName: "x.svg", mimeType: "image/svg+xml" } })) === 415);
    ok("an unknown person id -> 404", (await code({ ...base, userId: "00000000-0000-4000-8000-000000000000", file: pdfFile })) === 404);
    ok("a non-string title is refused cleanly (no 500)", [400].includes(await code({ ...base, title: { a: 1 }, file: pdfFile })));
    ok("nothing was saved by any refused attempt", (await q(`select count(*)::int n from employee_documents where "userId"=$1`, [E1.id]))[0].n === 2);

    // 9. acknowledgment
    ok("another employee cannot acknowledge my letter (404)", (await call("POST", `/warning-letters/${r1.b.id}/acknowledge`, E2.tok)).s === 404);
    ok("HR cannot acknowledge on the employee's behalf (404)", (await call("POST", `/warning-letters/${r1.b.id}/acknowledge`, HR.tok)).s === 404);
    const before = Date.now();
    const ack = await call("POST", `/warning-letters/${r1.b.id}/acknowledge`, E1.tok);
    ok("the employee acknowledges receipt", ack.s === 200 && !!ack.b.acknowledgedAt, ack);
    const at = Date.parse(ack.b.acknowledgedAt);
    ok("the acknowledgment date and time is the server's moment", at >= before - 2000 && at <= Date.now() + 2000, ack.b);
    const row = (await q(`select "reviewedAt","reviewedById" from employee_documents where id=$1`, [r1.b.id]))[0];
    ok("it is stored (when and by whom)", row.reviewedAt && row.reviewedById === E1.id, row);
    ok("a second acknowledgment is refused and the first time is kept", (await call("POST", `/warning-letters/${r1.b.id}/acknowledge`, E1.tok)).s === 409 && (await q(`select "reviewedAt" from employee_documents where id=$1`, [r1.b.id]))[0].reviewedAt.getTime() === row.reviewedAt.getTime());
    const m3 = await mine(E1);
    ok("the employee's list shows who is acknowledged and who is not", m3.find((l) => l.id === r1.b.id).acknowledgedAt === ack.b.acknowledgedAt && m3.find((l) => l.id === r2.b.id).acknowledgedAt === null, m3);
    ok("HR sees the acknowledgment status of the employee's letters", (await call("GET", `/warning-letters/person/${E1.id}`, HR.tok)).b.letters.find((l) => l.id === r1.b.id).acknowledgedAt === ack.b.acknowledgedAt);

    // 10. notifications, once each
    const nIssued = await q(`select count(*)::int n from notifications where "userId"=$1 and type='WARNING_LETTER_ISSUED'`, [E1.id]);
    ok("the employee was notified of each letter (2), once each", nIssued[0].n === 2, nIssued);
    ok("the issuer was told about the acknowledgment (once)", (await q(`select count(*)::int n from notifications where "userId"=$1 and type='WARNING_LETTER_ACKNOWLEDGED'`, [HR.id]))[0].n === 1);
    ok("nobody else was notified", (await q(`select count(*)::int n from notifications where "userId" in ($1,$2,$3) and type like 'WARNING_LETTER%'`, [E2.id, MGR.id, HRB.id]))[0].n === 1 /* E2 got the Admin-issued one */);

    // 11. audit trail
    const audits = await q(`select summary from audit_logs where "targetUserId"=$1 and module='Employees' order by "createdAt"`, [E1.id]);
    ok("issuing and acknowledging are in the audit log", audits.some((a) => /Issued warning letter/.test(a.summary)) && audits.some((a) => /Acknowledged receipt/.test(a.summary)), audits);

    // 12. the document checklist, Offer letter and Payslips are not disturbed
    const docs = (await call("GET", "/documents/mine", E1.tok)).b;
    ok("the employee's document checklist does not contain the letters", docs && JSON.stringify(docs).indexOf("First warning") === -1 && (docs.items ?? []).every((i) => !i.document || i.document.fileName !== "warning-1.pdf"), docs && Object.keys(docs));
    const track = await call("GET", "/documents/tracking", HR.tok);
    ok("HR's document tracking does not list the letters as documents", track.s === 200 && JSON.stringify(track.b).indexOf("warning-1.pdf") === -1);
    const rev = await call("POST", `/onboarding/documents/${r1.b.id}/review`, HR.tok, { approve: false, rejectionReason: "overwrite attempt" });
    ok("the document REVIEW route cannot touch a letter (404)", rev.s === 404, rev.s);
    ok("...and the letter's details are unchanged afterwards", (await mine(E1)).find((l) => l.id === r1.b.id).reason === "Late on five days in October");
    ok("the old document download route does not serve a letter (404)", (await call("GET", `/onboarding/documents/${r1.b.id}/file`, HR.tok)).s === 404);
    ok("Offer letter endpoint still answers", [200, 404].includes((await call("GET", "/offers/me", E1.tok)).s));
    ok("Payslips endpoint still answers", (await call("GET", "/payroll/me", E1.tok)).s === 200);
    ok("a letter is not counted as a pending/missing document", (await q(`select count(*)::int n from employee_documents where "userId"=$1 and status in ('REQUESTED','REJECTED')`, [E1.id]))[0].n === 0);
    ok("no duplicate rows (2 letters for E1)", (await docCount(E1.id)) === 2);
  } finally {
    await wipe();
    await db.end();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
