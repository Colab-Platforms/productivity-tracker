// Where each role lands, and that nobody is sent to another role's home. No database.
import { homeFor, legacyAdminTarget, ROLE_HOME } from "../../frontend/lib/roleHome.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

ok("Admin -> /dashboard/admin", homeFor("ADMIN") === "/dashboard/admin");
ok("HR -> /dashboard/hr", homeFor("HR") === "/dashboard/hr");
ok("Manager -> /dashboard/manager", homeFor("MANAGER") === "/dashboard/manager");
ok("Employee -> /dashboard/employee", homeFor("EMPLOYEE") === "/dashboard/employee");
ok("the four homes are all different", new Set(Object.values(ROLE_HOME)).size === 4);
ok("HR is never sent to the Admin home, nor Admin to HR's", homeFor("HR") !== homeFor("ADMIN"));
ok("an unknown or missing role gets the least-privileged home, never Admin", homeFor(undefined) === "/dashboard/employee" && homeFor(null) === "/dashboard/employee" && homeFor("") === "/dashboard/employee" && homeFor("AUDITOR") === "/dashboard/employee");

ok("an old Admin link with a tab goes to the Employees page, filter kept", legacyAdminTarget("?tab=Teams") === "/dashboard/employees?tab=Teams");
ok("...with a role or a search", legacyAdminTarget("?role=MANAGER") === "/dashboard/employees?role=MANAGER" && legacyAdminTarget("?q=AI-04") === "/dashboard/employees?q=AI-04");
ok("...and several filters together", legacyAdminTarget("?tab=People&role=HR") === "/dashboard/employees?tab=People&role=HR");
ok("the plain Admin address (no filter) stays the Admin home", legacyAdminTarget("") === null && legacyAdminTarget("?utm=1") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
