// Talk to Management: the pure access rules and the audit skip. No database.
import { canViewThread, canClose, canWrite, canTarget, statusAfterMessage, cleanSubject } from "../src/modules/management-talk/management.logic.js";
import { classify } from "../src/lib/auditCatalog.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

const S = "sender-1", A = "admin-1", A2 = "admin-2", HR = "hr-1", M = "mgr-1";
const open = { senderId: S, adminId: A, status: "OPEN" };
const closed = { ...open, status: "CLOSED" };

console.log("\n## who can see it");
ok("sender can", canViewThread(S, open));
ok("the chosen Admin can", canViewThread(A, open));
ok("another Admin cannot", !canViewThread(A2, open));
ok("HR cannot", !canViewThread(HR, open));
ok("a manager cannot", !canViewThread(M, open));

console.log("\n## closing and writing");
ok("only the chosen Admin closes", canClose(A, open) && !canClose(S, open) && !canClose(A2, open) && !canClose(HR, open));
ok("a closed thread cannot be closed again or written to", !canClose(A, closed) && !canWrite(S, closed) && !canWrite(A, closed));
ok("sender and Admin can write while open", canWrite(S, open) && canWrite(A, open));
ok("a stranger cannot write", !canWrite(HR, open) && !canWrite(A2, open));

console.log("\n## status after a message");
ok("Admin answering = REPLIED", statusAfterMessage(A, open) === "REPLIED");
ok("sender writing = OPEN", statusAfterMessage(S, { ...open, status: "REPLIED" }) === "OPEN");

console.log("\n## target and subject");
ok("cannot write to yourself", !canTarget(S, S) && canTarget(S, A));
ok("subject is trimmed and spaces collapsed", cleanSubject("  a   b  ") === "a b" && cleanSubject(null) === "");

console.log("\n## audit log never records these routes");
const id = "123e4567-e89b-12d3-a456-426614174000";
for (const [m, p] of [["POST", "/api/management-talk"], ["POST", `/api/management-talk/${id}/messages`], ["POST", `/api/management-talk/${id}/close`]] as const) {
  ok(`${m} ${p.replace(id, ":id")} is skipped`, classify(m, p, { body: "secret" }).skip === true);
}
ok("other routes are still logged", classify("POST", "/api/queries", {}).skip === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
