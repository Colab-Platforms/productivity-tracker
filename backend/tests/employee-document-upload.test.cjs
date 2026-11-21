// Employees upload their own documents; HR verifies or rejects. Real HTTP, THROWAWAY database only.
//   cd backend && TEST_DATABASE_URL=... TEST_API=http://localhost:5012/api node tests/employee-document-upload.test.cjs
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });
const { Client } = require("pg");
const bcrypt = require("bcryptjs");
const API = process.env.TEST_API ?? "http://localhost:5012/api";
require("./_guard.cjs").assertTestDb(process.env.TEST_DATABASE_URL);
const call = async (m, p, t, b) => {
  const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, b: j, raw: x };
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + String(JSON.stringify(x)).slice(0, 400))); };
const PW = "Edu@12345678";
const pdf = (tag) => "data:application/pdf;base64," + Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const A = (await q(`select id from platforms where slug='avatar'`))[0].id;
  const B = (await q(`select id from platforms where slug='co-lab'`))[0].id;
  const hash = await bcrypt.hash(PW, 10);
  const wipe = async () => {
    await q(`delete from employee_documents where "userId" in (select id from users where "employeeCode" like 'EDU-%')`);
    await q(`delete from document_requirements where label like 'EDU %'`);
    await q(`delete from notifications where "userId" in (select id from users where "employeeCode" like 'EDU-%')`);
    await q(`update audit_logs set "actorId"=null where "actorId" in (select id from users where "employeeCode" like 'EDU-%')`).catch(() => {});
    await q(`delete from company_access where "userId" in (select id from users where "employeeCode" like 'EDU-%')`);
    await q(`update users set "reportsToId"=null where "employeeCode" like 'EDU-%'`);
    await q(`delete from users where "employeeCode" like 'EDU-%'`);
  };
  await wipe();
  const mk = async (code, role, plat) => {
    await q(`insert into users (id,"platformId",email,"passwordHash","firstName","lastName","employeeCode",role,status,"mustChangePassword","trackerAccessEnabled","onboardingStatus","createdAt","updatedAt") values (gen_random_uuid(),$1,$2,$3,'Edu',$4,$4,$5,'ACTIVE',false,true,'ACTIVE',now(),now())`, [plat, code.toLowerCase() + "@x.test", hash, code, role]);
    const id = (await q(`select id from users where "employeeCode"=$1`, [code]))[0].id;
    return { id, tok: (await call("POST", "/auth/login", null, { email: code, password: PW })).b.token };
  };
  try {
    const ADM = await mk("EDU-ADM", "ADMIN", A); await q(`insert into company_access (id,"userId","platformId","createdAt") values (gen_random_uuid(),$1,null,now())`, [ADM.id]);
    const HR = await mk("EDU-HR", "HR", A); const MGR = await mk("EDU-MGR", "MANAGER", A);
    const EMP = await mk("EDU-EMP", "EMPLOYEE", A); const EMP2 = await mk("EDU-EMP2", "EMPLOYEE", A);
    const HRB = await mk("EDU-HRB", "HR", B);

    console.log("## requirements (HR sets what is asked)");
    const r1 = await call("POST", "/onboarding/requirements", HR.tok, { label: "EDU Aadhaar", category: "IDENTITY", isMandatory: true, uploadedByEmployee: true, appliesTo: [] });
    const r2 = await call("POST", "/onboarding/requirements", HR.tok, { label: "EDU Signed Contract", category: "CONTRACT", isMandatory: false, uploadedByEmployee: false, appliesTo: [] });
    ok("two requirements exist (one employee-uploaded, one HR-owned)", r1.s === 200 && r2.s === 200, [r1.b, r2.b]);
    const reqs = await q(`select id, label from document_requirements where label like 'EDU %'`);
    const AAD = reqs.find((r) => r.label === "EDU Aadhaar").id, CON = reqs.find((r) => r.label === "EDU Signed Contract").id;

    console.log("\n## employee uploads");
    const m0 = (await call("GET", "/documents/mine", EMP.tok)).b;
    const it0 = m0.items.find((i) => i.requirementId === AAD);
    ok("the employee's checklist lists it as not submitted and employee-uploaded", it0 && it0.status === "NOT_SUBMITTED" && it0.uploadedByEmployee === true, it0);
    const up1 = await call("POST", "/onboarding/me/documents", EMP.tok, { requirementId: AAD, fileName: "aadhaar-v1.pdf", data: pdf("v1"), mimeType: "application/pdf" });
    ok("the employee uploads (200)", up1.s === 200, up1);
    const d1 = (await q(`select id, status::text s, "userId", "uploadedById", "storageKey" k, "fileName" f from employee_documents where "requirementId"=$1`, [AAD]))[0];
    ok("the document is tied to the employee, uploaded by them, status Pending Verification (SUBMITTED)", d1.userId === EMP.id && d1.uploadedById === EMP.id && d1.s === "SUBMITTED" && d1.f === "aadhaar-v1.pdf", d1);
    const m1 = (await call("GET", "/documents/mine", EMP.tok)).b.items.find((i) => i.requirementId === AAD);
    ok("the employee sees file name, upload date and the pending status", m1.status === "SUBMITTED" && m1.fileName === "aadhaar-v1.pdf" && !!m1.uploadedAt, m1);
    await sleep(400);
    ok("HR and Admin are notified that a document waits for review (once)", (await q(`select count(*)::int n from notifications where type='DOCUMENT_SUBMITTED' and "userId"=$1`, [HR.id]))[0].n === 1 && (await q(`select count(*)::int n from notifications where type='DOCUMENT_SUBMITTED' and "userId"=$1`, [ADM.id]))[0].n === 1);
    ok("the employee is not notified of their own upload", (await q(`select count(*)::int n from notifications where type='DOCUMENT_SUBMITTED' and "userId"=$1`, [EMP.id]))[0].n === 0);
    const bad = await call("POST", "/onboarding/me/documents", EMP.tok, { requirementId: AAD, fileName: "x.exe", data: "data:application/x-msdownload;base64,AAAA", mimeType: "application/x-msdownload" });
    ok("a disallowed file type is refused", bad.s === 415, bad);
    ok("the employee cannot upload an HR-owned document", (await call("POST", "/onboarding/me/documents", EMP.tok, { requirementId: CON, fileName: "c.pdf", data: pdf("c") })).s === 400);
    const spoof = await call("POST", "/onboarding/me/documents", EMP.tok, { requirementId: AAD, userId: EMP2.id, fileName: "spoof.pdf", data: pdf("spoof") });
    ok("a userId in the body is ignored: it is still the signed-in employee's own record", spoof.s === 200 && (await q(`select count(*)::int n from employee_documents where "userId"=$1`, [EMP2.id]))[0].n === 0);

    console.log("\n## HR does not upload for employees");
    const hrUp = await call("POST", `/onboarding/candidates/${EMP.id}/documents`, HR.tok, { requirementId: AAD, fileName: "hr.pdf", data: pdf("hr") });
    ok("HR cannot upload an employee-owned document (refused)", hrUp.s === 400 && hrUp.b.code === "EMPLOYEE_UPLOADS_THIS", hrUp);
    ok("HR and Admin cannot upload on their own behalf either way: nothing changed", (await q(`select "uploadedById" u from employee_documents where "requirementId"=$1 and "userId"=$2`, [AAD, EMP.id]))[0].u === EMP.id);
    const hrOwn = await call("POST", `/onboarding/candidates/${EMP.id}/documents`, HR.tok, { requirementId: CON, fileName: "contract.pdf", data: pdf("contract") });
    ok("HR can still upload HR-owned documents (e.g. a signed contract)", hrOwn.s === 200, hrOwn);

    console.log("\n## HR reviews");
    const track = (await call("GET", "/documents/tracking", HR.tok)).b;
    const rowE = (track.rows ?? track.people ?? []).find((r) => r.employeeCode === "EDU-EMP"), rowE2 = (track.rows ?? track.people ?? []).find((r) => r.employeeCode === "EDU-EMP2");
    ok("HR monitors submission: the employee shows pending, the one who did nothing shows missing", rowE && rowE.submitted >= 1 && rowE2 && rowE2.missing >= 1, [rowE, rowE2]);
    const chk = (await call("GET", `/documents/employees/${EMP.id}`, HR.tok)).b.items.find((i) => i.requirementId === AAD);
    ok("HR sees the uploaded file, upload date and pending status", chk.status === "SUBMITTED" && chk.fileName === "spoof.pdf" && !!chk.uploadedAt, chk);
    const docId = chk.documentId;
    const view = await fetch(API + `/onboarding/documents/${docId}/file`, { headers: { authorization: "Bearer " + HR.tok } });
    ok("HR can open the file (private, no-store)", view.status === 200 && /no-store/.test(view.headers.get("cache-control") ?? ""));
    ok("rejecting without a reason is refused", (await call("POST", `/onboarding/documents/${docId}/review`, HR.tok, { approve: false })).s === 400);
    const rej = await call("POST", `/onboarding/documents/${docId}/review`, HR.tok, { approve: false, rejectionReason: "Photo is blurred, upload a clear scan" });
    ok("HR rejects with a reason", rej.s === 200 && (await q(`select status::text s, "rejectionReason" r from employee_documents where id=$1`, [docId]))[0].s === "REJECTED");
    await sleep(400);
    const nrej = await q(`select title, body, link from notifications where type='DOCUMENT_REJECTED' and "userId"=$1`, [EMP.id]);
    ok("the employee is notified with HR's reason", nrej.length === 1 && /blurred/.test(nrej[0].body) && /profile/.test(nrej[0].link), nrej);
    const mr = (await call("GET", "/documents/mine", EMP.tok)).b.items.find((i) => i.requirementId === AAD);
    ok("the employee sees Rejected with the reason", mr.status === "REJECTED" && /blurred/.test(mr.rejectionReason), mr);

    console.log("\n## employee uploads the corrected document");
    const up2 = await call("POST", "/onboarding/me/documents", EMP.tok, { requirementId: AAD, fileName: "aadhaar-v2.pdf", data: pdf("v2"), mimeType: "application/pdf" });
    const d2 = (await q(`select id, status::text s, "rejectionReason" r, "reviewedAt" ra, "storageKey" k, "fileName" f from employee_documents where "requirementId"=$1 and "userId"=$2`, [AAD, EMP.id]))[0];
    ok("re-upload: same record, new file, back to Pending Verification, old review cleared", up2.s === 200 && d2.id === docId && d2.s === "SUBMITTED" && d2.f === "aadhaar-v2.pdf" && d2.r === null && d2.ra === null, d2);
    ok("the previous file is NOT deleted from the store", (await q(`select count(*)::int n from stored_blobs where "storageKey"=$1`, [d1.k]))[0].n === 1 && d1.k !== d2.k);
    const ver = await call("POST", `/onboarding/documents/${docId}/review`, HR.tok, { approve: true });
    ok("HR verifies the corrected submission", ver.s === 200 && (await q(`select status::text s, "reviewedById" r from employee_documents where id=$1`, [docId]))[0].r === HR.id);
    await sleep(400);
    ok("the employee is notified of the verification", (await q(`select count(*)::int n from notifications where type='DOCUMENT_VERIFIED' and "userId"=$1`, [EMP.id]))[0].n === 1);
    const mv = (await call("GET", "/documents/mine", EMP.tok)).b.items.find((i) => i.requirementId === AAD);
    ok("the employee sees Verified with who and when", mv.status === "VERIFIED" && !!mv.reviewedAt && !!mv.reviewedBy, mv);
    const again = await call("POST", "/onboarding/me/documents", EMP.tok, { requirementId: AAD, fileName: "again.pdf", data: pdf("v3") });
    ok("a verified document cannot be replaced (409)", again.s === 409 && again.b.code === "ALREADY_VERIFIED", again);

    console.log("\n## verification history (HR / Admin)");
    const h = await call("GET", `/documents/history/${docId}`, HR.tok);
    const sums = (h.b.events ?? []).map((e) => e.summary).join(" | ");
    ok("history lists upload, rejection with reason, re-upload and verification, oldest first", h.s === 200 && /Uploaded/.test(sums) && /Rejected/.test(sums) && /Re-uploaded/.test(sums) && /Verified/.test(sums) && h.b.events.some((e) => /blurred/.test(e.after.rejectionReason ?? "")), h.b);
    ok("history names who did each step", h.b.events.every((e) => e.by && e.by !== "System"), h.b.events);
    ok("history never exposes a storage key", !JSON.stringify(h.b).includes("storageKey") && !JSON.stringify(h.b).includes("/documents/"));
    ok("Admin can read the history", (await call("GET", `/documents/history/${docId}`, ADM.tok)).s === 200);
    ok("the employee cannot read the review history (403)", (await call("GET", `/documents/history/${docId}`, EMP.tok)).s === 403);
    ok("HR of another company cannot (404)", (await call("GET", `/documents/history/${docId}`, HRB.tok)).s === 404);

    console.log("\n## access to files");
    const get = (tok) => fetch(API + `/onboarding/documents/${docId}/file`, { headers: { authorization: "Bearer " + tok } });
    ok("the owner employee can open their own file", (await get(EMP.tok)).status === 200);
    ok("another employee cannot (403)", (await get(EMP2.tok)).status === 403);
    ok("a manager cannot (403)", (await get(MGR.tok)).status === 403);
    ok("Admin can (authorised visibility kept)", (await get(ADM.tok)).status === 200);
    ok("HR of another company cannot (404)", (await get(HRB.tok)).status === 404);
    ok("no token = 401", (await fetch(API + `/onboarding/documents/${docId}/file`)).status === 401);
    ok("an employee cannot read another person's checklist (403)", (await call("GET", `/documents/employees/${EMP.id}`, EMP2.tok)).s === 403);
    ok("an employee cannot review a document (403)", (await call("POST", `/onboarding/documents/${docId}/review`, EMP2.tok, { approve: true })).s === 403);
    ok("another employee's mine list does not contain this file", !(await call("GET", "/documents/mine", EMP2.tok)).raw.includes("aadhaar-v2"));

    console.log("\n## history is preserved");
    ok("both stored files still exist", (await q(`select count(*)::int n from stored_blobs where "storageKey" in ($1,$2)`, [d1.k, d2.k]))[0].n === 2);
    ok("the audit log holds the whole trail (never edited)", (await q(`select count(*)::int n from audit_logs where "recordType"='EmployeeDocument' and "recordId"=$1`, [docId]))[0].n >= 4);
  } finally { await wipe().catch((e) => console.log("wipe", e.message)); await db.end(); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
