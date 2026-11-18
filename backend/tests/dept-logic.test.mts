// Query Desk department requests: the pure rules. No database.
import * as L from "../src/modules/queries/dept.logic.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

const viewer = (id: string, role: string, o: Partial<L.Viewer> = {}): L.Viewer => ({ id, role, access: { all: false, ids: ["P1"] }, deptIds: [], reportIds: new Set(), ...o });
const facts = (o: Partial<L.Facts> = {}): L.Facts => ({ raisedById: "emp", platformId: "P1", departmentId: "IT", approvalStatus: "PENDING_MANAGER", workStatus: null, managerId: "mgr", adminApproverIds: ["adm"], assigneeId: null, confirmedAt: null, ...o });

// --- who it goes to ---
ok("an employee's active manager is asked first", L.firstApprover({ id: "emp", role: "EMPLOYEE" }, { id: "mgr", role: "MANAGER", status: "ACTIVE" }) === "mgr");
ok("a suspended manager is not asked", L.firstApprover({ id: "emp", role: "EMPLOYEE" }, { id: "mgr", role: "MANAGER", status: "SUSPENDED" }) === null);
ok("an Admin boss means no manager step", L.firstApprover({ id: "emp", role: "EMPLOYEE" }, { id: "a", role: "ADMIN", status: "ACTIVE" }) === null);
ok("no boss means no manager step", L.firstApprover({ id: "emp", role: "EMPLOYEE" }, null) === null);
ok("a manager who raises has no manager step", L.firstApprover({ id: "m", role: "MANAGER" }, { id: "m2", role: "MANAGER", status: "ACTIVE" }) === null);
ok("the mapped Admin is an active Admin who is not the requester", L.mappedAdmin("emp", { id: "a", role: "ADMIN", status: "ACTIVE" }) === "a");
ok("a manager above is not an Admin", L.mappedAdmin("emp", { id: "m", role: "MANAGER", status: "ACTIVE" }) === null);
ok("an Admin cannot be their own approver", L.mappedAdmin("a", { id: "a", role: "ADMIN", status: "ACTIVE" }) === null);

// --- reading ---
const pm = facts();
ok("the requester sees it", L.canView(viewer("emp", "EMPLOYEE"), pm));
ok("the asked manager sees it", L.canView(viewer("mgr", "MANAGER"), pm));
ok("a stranger does not", !L.canView(viewer("x", "EMPLOYEE"), pm));
ok("the department cannot see it before final approval", !L.canView(viewer("it1", "EMPLOYEE", { deptIds: ["IT"] }), pm) && !L.canView(viewer("it1", "EMPLOYEE", { deptIds: ["IT"] }), facts({ approvalStatus: "PENDING_ADMIN" })));
const ap = facts({ approvalStatus: "APPROVED", workStatus: "AWAITING_ACTION" });
ok("the department sees it once approved", L.canView(viewer("it1", "EMPLOYEE", { deptIds: ["IT"] }), ap));
ok("another department does not", !L.canView(viewer("a1", "EMPLOYEE", { deptIds: ["ACC"] }), ap));
ok("HR/Admin of the company monitor it", L.canView(viewer("hr", "HR"), pm) && L.canView(viewer("adm2", "ADMIN"), pm));
ok("HR of another company does not", !L.canView(viewer("hr", "HR", { access: { all: false, ids: ["P2"] } }), pm));
ok("a manager sees his team's request", L.canView(viewer("m9", "MANAGER", { reportIds: new Set(["emp"]) }), pm));

// --- approvals ---
ok("only the asked manager decides stage 1", L.canManagerDecide(viewer("mgr", "MANAGER"), pm) && !L.canManagerDecide(viewer("m9", "MANAGER"), pm) && !L.canManagerDecide(viewer("adm", "ADMIN"), pm));
ok("the requester can never decide their own", !L.canManagerDecide(viewer("emp", "EMPLOYEE"), facts({ managerId: "emp" })));
ok("the Admin cannot decide at stage 1 (cannot skip the manager)", !L.canAdminDecide(viewer("adm", "ADMIN"), pm));
const pa = facts({ approvalStatus: "PENDING_ADMIN" });
ok("only the named Admin decides stage 3", L.canAdminDecide(viewer("adm", "ADMIN"), pa) && !L.canAdminDecide(viewer("adm2", "ADMIN"), pa) && !L.canAdminDecide(viewer("hr", "HR"), pa));
ok("the manager cannot give the final approval", !L.canAdminDecide(viewer("mgr", "MANAGER"), pa));

// --- notes ---
ok("an employee never reads approver or department notes", !L.canSeeNote(viewer("emp", "EMPLOYEE"), ap, "APPROVERS") && !L.canSeeNote(viewer("emp", "EMPLOYEE"), ap, "DEPT") && L.canSeeNote(viewer("emp", "EMPLOYEE"), ap, "ALL"));
ok("the department never reads approver notes", !L.canSeeNote(viewer("it1", "EMPLOYEE", { deptIds: ["IT"] }), ap, "APPROVERS") && L.canSeeNote(viewer("it1", "EMPLOYEE", { deptIds: ["IT"] }), ap, "DEPT"));
ok("approvers read approver notes", L.canSeeNote(viewer("adm", "ADMIN"), ap, "APPROVERS") && L.canSeeNote(viewer("mgr", "MANAGER"), ap, "APPROVERS"));

// --- work ---
const it = viewer("it1", "EMPLOYEE", { deptIds: ["IT"] });
ok("a member accepts only when approved and unowned", L.canAccept(it, ap) && !L.canAccept(it, pm) && !L.canAccept(it, facts({ ...ap, assigneeId: "it2" })));
ok("the requester cannot take their own request", !L.canAccept(viewer("emp", "EMPLOYEE", { deptIds: ["IT"] }), ap));
const owned = facts({ approvalStatus: "APPROVED", workStatus: "IN_PROGRESS", assigneeId: "it1" });
ok("only the owner updates progress", L.canUpdateProgress(it, owned) && !L.canUpdateProgress(viewer("it2", "EMPLOYEE", { deptIds: ["IT"] }), owned));
ok("nobody updates progress after completion", !L.canUpdateProgress(it, facts({ ...owned, workStatus: "COMPLETED" })));
ok("progress moves only between the four settable states, and never to itself", L.progressAllowed("IN_PROGRESS", "ON_HOLD") && !L.progressAllowed("IN_PROGRESS", "IN_PROGRESS") && !L.progressAllowed("IN_PROGRESS", "REOPENED") && !L.progressAllowed("COMPLETED", "IN_PROGRESS"));
ok("on hold and completed need a note", L.progressNeedsNote("ON_HOLD") && L.progressNeedsNote("COMPLETED") && !L.progressNeedsNote("IN_PROGRESS"));
ok("owner or an Admin of the company reassigns", L.canReassign(it, owned) && L.canReassign(viewer("adm", "ADMIN"), owned) && !L.canReassign(viewer("it2", "EMPLOYEE", { deptIds: ["IT"] }), owned) && !L.canReassign(viewer("hr", "HR"), owned));

// --- the employee's answer ---
const done = facts({ approvalStatus: "APPROVED", workStatus: "COMPLETED", assigneeId: "it1" });
ok("only the requester confirms or reopens, once, after completion", L.canConfirm(viewer("emp", "EMPLOYEE"), done) && !L.canConfirm(viewer("x", "EMPLOYEE"), done) && !L.canConfirm(viewer("emp", "EMPLOYEE"), owned) && !L.canConfirm(viewer("emp", "EMPLOYEE"), facts({ ...done, confirmedAt: new Date() })));

// --- comments, views, stage text ---
ok("a requester can only write for everyone", L.commentVisibilities(viewer("emp", "EMPLOYEE"), ap).join() === "ALL");
ok("nobody comments on a rejected request", L.commentVisibilities(viewer("emp", "EMPLOYEE"), facts({ approvalStatus: "REJECTED" })).length === 0);
ok("a department member can write for everyone or the department", L.commentVisibilities(it, ap).includes("DEPT") && L.commentVisibilities(it, ap).includes("ALL"));
ok("the queue views split correctly", L.inView("DEPT_AWAITING", it, ap) && !L.inView("DEPT_AWAITING", it, owned) && L.inView("DEPT_ASSIGNED", it, owned) && L.inView("DEPT_PROGRESS", it, owned) && L.inView("DEPT_DONE", it, done) && L.inView("APPROVE", viewer("mgr", "MANAGER"), pm) && L.inView("MINE", viewer("emp", "EMPLOYEE"), pm));
ok("approval and work labels are separate vocabularies", L.APPROVAL_LABEL.APPROVED === "Approved" && L.WORK_LABEL.AWAITING_ACTION === "Awaiting Department Action" && !(L.WORK_LABEL as Record<string, string>).PENDING_MANAGER);
ok("stage text follows the state", L.stageOf(pm).includes("reporting manager") && L.stageOf(pa).includes("Admin") && L.stageOf(ap).includes("department") && L.stageOf(done).includes("confirm"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
