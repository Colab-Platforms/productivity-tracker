// Complaint Centre / Query Desk: who sees and does what, categories and statuses. No database.
import { canAssignTo, canHandleQuery, canManageQuery, canViewQuery, displayStatus, legacyCategory, TICKET_CATEGORY_FOR, QUERY_CATEGORIES } from "../src/modules/queries/queries.logic.js";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };
const acc = (ids: string[], all = false) => ({ all, ids });
const v = (id: string, role: string, a = acc(["P1"])) => ({ id, role, access: a });
const t = (over: Partial<{ raisedById: string; platformId: string; assignedToId: string | null; categoryKey: never }> = {}) => ({ raisedById: "emp", platformId: "P1", assignedToId: null, categoryKey: "GENERAL_HR" as never, ...over });
const team = new Set(["emp"]);
const none = new Set<string>();

ok("the person who raised it sees it", canViewQuery(v("emp", "EMPLOYEE"), t(), none));
ok("another employee never sees it", !canViewQuery(v("other", "EMPLOYEE"), t(), none));
ok("a manager sees a query from someone on their team", canViewQuery(v("m", "MANAGER"), t(), team));
ok("a manager does NOT see a query from someone outside their team", !canViewQuery(v("m", "MANAGER"), t(), none));
ok("a manager never sees a payroll query, even from their own team", !canViewQuery(v("m", "MANAGER"), t({ categoryKey: "PAYROLL" as never }), team));
ok("a manager sees what HR assigned to them", canViewQuery(v("m", "MANAGER"), t({ assignedToId: "m" }), none));
ok("HR sees every query of their company, payroll included", canViewQuery(v("hr", "HR"), t({ categoryKey: "PAYROLL" as never }), none));
ok("HR does not see another company's query", !canViewQuery(v("hr", "HR"), t({ platformId: "P2" }), none));
ok("HR assigned a second company sees it", canViewQuery(v("hr", "HR", acc(["P1", "P2"])), t({ platformId: "P2" }), none));
ok("top management (all companies) sees any company", canViewQuery(v("adm", "ADMIN", acc([], true)), t({ platformId: "P9" }), none));
ok("an Admin without access to a company does not see it", !canViewQuery(v("adm", "ADMIN"), t({ platformId: "P9" }), none));

ok("staff can handle a query they can see", canHandleQuery(v("hr", "HR"), t(), none));
ok("nobody handles their own query as staff", !canHandleQuery(v("hr", "HR"), t({ raisedById: "hr" }), none));
ok("an employee never handles queries", !canHandleQuery(v("emp", "EMPLOYEE"), t(), none));
ok("a manager handles a team query", canHandleQuery(v("m", "MANAGER"), t(), team));

ok("HR of the company can change status / assign", canManageQuery(v("hr", "HR"), t()));
ok("HR of another company cannot", !canManageQuery(v("hr", "HR"), t({ platformId: "P2" })));
ok("the assignee can, even a manager", canManageQuery(v("m", "MANAGER"), t({ assignedToId: "m" })));
ok("a manager who is not assigned cannot", !canManageQuery(v("m", "MANAGER"), t()));
ok("nobody changes the status of their own query", !canManageQuery(v("hr", "HR"), t({ raisedById: "hr" })));

ok("a query can be assigned to active HR of the same company", canAssignTo({ role: "HR", platformId: "P1", status: "ACTIVE" }, { platformId: "P1", categoryKey: "PAYROLL" as never }));
ok("not to someone in another company", !canAssignTo({ role: "HR", platformId: "P2", status: "ACTIVE" }, { platformId: "P1", categoryKey: "GENERAL_HR" as never }));
ok("not to an exited person", !canAssignTo({ role: "HR", platformId: "P1", status: "EXITED" }, { platformId: "P1", categoryKey: "GENERAL_HR" as never }));
ok("a manager can take a general query but never a payroll one", canAssignTo({ role: "MANAGER", platformId: "P1", status: "ACTIVE" }, { platformId: "P1", categoryKey: "GENERAL_HR" as never }) && !canAssignTo({ role: "MANAGER", platformId: "P1", status: "ACTIVE" }, { platformId: "P1", categoryKey: "PAYROLL" as never }));
ok("an employee can never be assigned a query", !canAssignTo({ role: "EMPLOYEE", platformId: "P1", status: "ACTIVE" }, { platformId: "P1", categoryKey: "GENERAL_HR" as never }));

ok("old ticket categories read as the new ones", legacyCategory("HR_QUERY") === "GENERAL_HR" && legacyCategory("TECH_ISSUE") === "TECHNICAL" && legacyCategory("ADMIN_REQUEST") === "OTHER" && legacyCategory("ATTENDANCE_CORRECTION") === "ATTENDANCE_CORRECTION");
ok("every new category maps onto an old ticket category", QUERY_CATEGORIES.every((c) => !!TICKET_CATEGORY_FOR[c]));
ok("payroll is stored as an HR query (so it is routed to HR)", TICKET_CATEGORY_FOR.PAYROLL === "HR_QUERY");
ok("information requested = waiting for the employee", displayStatus("IN_PROGRESS", true) === "WAITING_FOR_EMPLOYEE" && displayStatus("OPEN", true) === "WAITING_FOR_EMPLOYEE");
ok("a finished query never shows as waiting", displayStatus("RESOLVED", true) === "RESOLVED" && displayStatus("CLOSED", true) === "CLOSED");
ok("no request for information = the real status", displayStatus("IN_PROGRESS", false) === "IN_PROGRESS");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
