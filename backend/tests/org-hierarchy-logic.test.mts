// Organization hierarchy + leave approval flow: the pure rules. No database.
import { needsManualMapping, reportingError, requiredBossRole } from "../src/modules/admin/hierarchy.logic.js";
import { approverOk, finalGate, firstLevelFor, needsHrFinal, stageOf, STAGE_LABEL } from "../src/modules/leave/leaveFlow.logic.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

const CO = "co-1";
const person = (id: string, role: string, status = "ACTIVE", platformId = CO) => ({ id, role, status, platformId });

console.log("\n## the reporting rules");
ok("an employee must report to a Manager", requiredBossRole("EMPLOYEE") === "MANAGER");
ok("a manager must report to an Admin", requiredBossRole("MANAGER") === "ADMIN");
ok("HR and Admin need no reporting line", requiredBossRole("HR") === null && requiredBossRole("ADMIN") === null);
const emp = { id: "e1", role: "EMPLOYEE", platformId: CO };
const mgr = { id: "m1", role: "MANAGER", platformId: CO };
ok("employee -> Manager is fine", reportingError(emp, person("m1", "MANAGER")) === null);
ok("employee -> Admin is refused", reportingError(emp, person("a1", "ADMIN")) === "MANAGER_WRONG_ROLE");
ok("employee -> HR is refused", reportingError(emp, person("h1", "HR")) === "MANAGER_WRONG_ROLE");
ok("employee -> another employee is refused", reportingError(emp, person("e2", "EMPLOYEE")) === "MANAGER_WRONG_ROLE");
ok("manager -> Admin is fine", reportingError(mgr, person("a1", "ADMIN")) === null);
ok("manager -> manager is refused", reportingError(mgr, person("m2", "MANAGER")) === "MANAGER_WRONG_ROLE");
ok("nobody reports to themselves", reportingError(emp, person("e1", "MANAGER")) === "BAD_MANAGER");
ok("not to someone in another company", reportingError(emp, person("m9", "MANAGER", "ACTIVE", "co-2")) === "BAD_MANAGER");
ok("not to someone who has left or is suspended", reportingError(emp, person("m3", "MANAGER", "EXITED")) === "BAD_MANAGER" && reportingError(emp, person("m4", "MANAGER", "SUSPENDED")) === "BAD_MANAGER");
ok("a missing person is refused", reportingError(emp, null) === "BAD_MANAGER");
ok("HR may still be given a Manager or Admin (as before) but not an employee", reportingError({ id: "h", role: "HR", platformId: CO }, person("a1", "ADMIN")) === null && reportingError({ id: "h", role: "HR", platformId: CO }, person("e2", "EMPLOYEE")) === "MANAGER_WRONG_ROLE");
ok("manual mapping: an employee with no boss, or with an Admin boss, needs configuring", needsManualMapping({ role: "EMPLOYEE", status: "ACTIVE" }, null) && needsManualMapping({ role: "EMPLOYEE", status: "ACTIVE" }, { role: "ADMIN", status: "ACTIVE" }));
ok("manual mapping: an employee under an active Manager is fine", !needsManualMapping({ role: "EMPLOYEE", status: "ACTIVE" }, { role: "MANAGER", status: "ACTIVE" }));
ok("manual mapping: a manager needs an Admin; HR/Admin never need one; people who left are skipped", needsManualMapping({ role: "MANAGER", status: "ACTIVE" }, { role: "MANAGER", status: "ACTIVE" }) && !needsManualMapping({ role: "MANAGER", status: "ACTIVE" }, { role: "ADMIN", status: "ACTIVE" }) && !needsManualMapping({ role: "HR", status: "ACTIVE" }, null) && !needsManualMapping({ role: "ADMIN", status: "ACTIVE" }, null) && !needsManualMapping({ role: "EMPLOYEE", status: "EXITED" }, null));

console.log("\n## who answers first, and who gives the final answer");
ok("employee -> Manager, manager -> Admin, HR -> Admin, Admin -> nobody", firstLevelFor("EMPLOYEE") === "MANAGER" && firstLevelFor("MANAGER") === "ADMIN" && firstLevelFor("HR") === "ADMIN" && firstLevelFor("ADMIN") === "NONE");
ok("HR gives a final approval for employees and managers only", needsHrFinal("EMPLOYEE") && needsHrFinal("MANAGER") && !needsHrFinal("HR") && !needsHrFinal("ADMIN"));

console.log("\n## the status shown (the table from the spec)");
const st = (requesterRole: string, requestStatus: string, stepStatus: string | null) => stageOf({ requesterRole, requestStatus, stepStatus });
ok("employee submits = Pending Manager Approval", st("EMPLOYEE", "PENDING", "PENDING") === "PENDING_MANAGER" && STAGE_LABEL.PENDING_MANAGER === "Pending Manager Approval");
ok("manager rejects employee leave = Rejected", st("EMPLOYEE", "REJECTED", "REJECTED") === "REJECTED");
ok("manager approves employee leave = Pending HR Approval", st("EMPLOYEE", "PENDING", "APPROVED") === "PENDING_HR" && STAGE_LABEL.PENDING_HR === "Pending HR Approval");
ok("HR approves employee leave = Approved; HR rejects = Rejected", st("EMPLOYEE", "APPROVED", "APPROVED") === "APPROVED" && st("EMPLOYEE", "REJECTED", "APPROVED") === "REJECTED");
ok("manager submits = Pending Admin Approval", st("MANAGER", "PENDING", "PENDING") === "PENDING_ADMIN" && STAGE_LABEL.PENDING_ADMIN === "Pending Admin Approval");
ok("Admin approves manager leave = Pending HR Approval; Admin rejects = Rejected", st("MANAGER", "PENDING", "APPROVED") === "PENDING_HR" && st("MANAGER", "REJECTED", "REJECTED") === "REJECTED");
ok("HR submits = Pending Admin Approval; tagged Admin approves = Approved; rejects = Rejected", st("HR", "PENDING", "PENDING") === "PENDING_ADMIN" && st("HR", "APPROVED", "APPROVED") === "APPROVED" && st("HR", "REJECTED", "REJECTED") === "REJECTED");
ok("Admin's own leave = Approved automatically", st("ADMIN", "APPROVED", null) === "APPROVED");
ok("a request with no first-level step waits for HR (as it always did)", st("EMPLOYEE", "PENDING", null) === "PENDING_HR");
ok("cancelled stays cancelled", st("EMPLOYEE", "CANCELLED", "PENDING") === "CANCELLED");

console.log("\n## only the tagged approver, in the right role");
ok("a Manager of the same company may be tagged for an employee", approverOk(emp, person("m1", "MANAGER")));
ok("an Admin may NOT be tagged for an employee (their first level is a Manager)", !approverOk(emp, person("a1", "ADMIN")));
ok("a Manager of another company may not", !approverOk(emp, person("m9", "MANAGER", "ACTIVE", "co-2")));
ok("nobody can approve their own leave", !approverOk(emp, person("e1", "MANAGER")));
ok("an inactive Manager may not", !approverOk(emp, person("m5", "MANAGER", "SUSPENDED")));
ok("a manager's leave needs an Admin, not another Manager", approverOk(mgr, person("a1", "ADMIN")) && !approverOk(mgr, person("m2", "MANAGER")));
ok("HR tags an Admin; any company HR acts on is fine, one outside is not", approverOk({ id: "h", role: "HR", platformId: CO }, person("a2", "ADMIN", "ACTIVE", "co-2"), true) && !approverOk({ id: "h", role: "HR", platformId: CO }, person("a2", "ADMIN", "ACTIVE", "co-2"), false));
ok("an Admin has no approver at all", !approverOk({ id: "a1", role: "ADMIN", platformId: CO }, person("a2", "ADMIN")));

console.log("\n## HR's turn, and nobody else's");
const gate = (requesterRole: string, stepStatus: string | null, actorRole: string, legacyNoStep = stepStatus === null) => finalGate({ requesterRole, stepStatus, actorRole, legacyNoStep });
ok("HR cannot act while the first level is pending (buttons stay disabled)", gate("EMPLOYEE", "PENDING", "HR") === "WAITING_FIRST_LEVEL" && gate("MANAGER", "PENDING", "HR") === "WAITING_FIRST_LEVEL");
ok("HR cannot act on a request the first level rejected", gate("EMPLOYEE", "REJECTED", "HR") === "FIRST_LEVEL_REJECTED");
ok("HR acts once the first level approved", gate("EMPLOYEE", "APPROVED", "HR") === "OK" && gate("MANAGER", "APPROVED", "HR") === "OK");
ok("an Admin does not give the HR final answer on a normal request", gate("EMPLOYEE", "APPROVED", "ADMIN") === "NOT_FINAL_STAGE");
ok("HR's own leave never reaches an HR final step (the tagged Admin is final)", gate("HR", "APPROVED", "HR") === "NOT_FINAL_STAGE" && gate("HR", "PENDING", "HR", false) === "NOT_FINAL_STAGE");
ok("a legacy request with no first-level step: HR decides, and an Admin may close it", gate("EMPLOYEE", null, "HR") === "OK" && gate("EMPLOYEE", null, "ADMIN") === "OK");
ok("a manager or employee can never decide at the final stage", gate("EMPLOYEE", "APPROVED", "MANAGER") === "NOT_FINAL_STAGE" && gate("EMPLOYEE", "APPROVED", "EMPLOYEE") === "NOT_FINAL_STAGE");

// ---- Organization Hierarchy editor (Admin): cross-company lines allowed, Admins stay top level ----
ok("default: a boss from another company is still refused (creating an account keeps the same-company rule)", reportingError(emp, person("m9", "MANAGER", "ACTIVE", "co-2")) === "BAD_MANAGER");
ok("Admin editor (anyCompany): an employee may report to a Manager of another company", reportingError(emp, person("m9", "MANAGER", "ACTIVE", "co-2"), { anyCompany: true }) === null);
ok("Admin editor (anyCompany): a Manager may report to an Admin of another company", reportingError(mgr, person("a9", "ADMIN", "ACTIVE", "co-2"), { anyCompany: true }) === null);
ok("anyCompany still enforces the role rules", reportingError(emp, person("a9", "ADMIN", "ACTIVE", "co-2"), { anyCompany: true }) === "MANAGER_WRONG_ROLE" && reportingError(mgr, person("m8", "MANAGER", "ACTIVE", "co-2"), { anyCompany: true }) === "MANAGER_WRONG_ROLE");
ok("anyCompany still refuses someone suspended or exited, a missing person and the person themselves", reportingError(emp, person("m3", "MANAGER", "SUSPENDED", "co-2"), { anyCompany: true }) === "BAD_MANAGER" && reportingError(emp, person("m3", "MANAGER", "EXITED", "co-2"), { anyCompany: true }) === "BAD_MANAGER" && reportingError(emp, null, { anyCompany: true }) === "BAD_MANAGER" && reportingError(emp, person("e1", "MANAGER", "ACTIVE", "co-2"), { anyCompany: true }) === "BAD_MANAGER");
ok("an Admin reports to nobody: no boss is accepted for an Admin, in any mode", reportingError({ id: "a1", role: "ADMIN", platformId: CO }, person("a2", "ADMIN")) === "ADMIN_TOP_LEVEL" && reportingError({ id: "a1", role: "ADMIN", platformId: CO }, person("m1", "MANAGER"), { anyCompany: true }) === "ADMIN_TOP_LEVEL");
ok("HR is unaffected by the Admin rule", reportingError({ id: "h", role: "HR", platformId: CO }, person("a1", "ADMIN")) === null);

// ---- a person's own reporting manager is accepted as first-level approver whatever company they are in ----
ok("own line: an employee's reporting Manager of another company is accepted as approver", approverOk(emp, person("m9", "MANAGER", "ACTIVE", "co-2"), true, true));
ok("not own line: the same Manager of another company is still refused (a free choice stays inside the company)", !approverOk(emp, person("m9", "MANAGER", "ACTIVE", "co-2")));
ok("own line still needs the right role and an active person", !approverOk(emp, person("a9", "ADMIN", "ACTIVE", "co-2"), true, true) && !approverOk(emp, person("m9", "MANAGER", "SUSPENDED", "co-2"), true, true));
ok("own line: a Manager's Admin of another company is accepted", approverOk(mgr, person("a9", "ADMIN", "ACTIVE", "co-2"), true, true));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
