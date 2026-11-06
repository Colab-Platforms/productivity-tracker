// How a stored role is shown to people: one shared function, never wrong, never "Admin" by accident. No database.
import { dashboardTitle, ROLE_LABEL, roleLabel } from "../../frontend/lib/roles.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

console.log("\n## the four roles");
ok("ADMIN shows Admin", roleLabel("ADMIN") === "Admin");
ok("HR shows HR (not Hr, not Admin)", roleLabel("HR") === "HR");
ok("MANAGER shows Manager", roleLabel("MANAGER") === "Manager");
ok("EMPLOYEE shows Employee", roleLabel("EMPLOYEE") === "Employee");
ok("the four labels are all different", new Set(Object.values(ROLE_LABEL)).size === 4);

console.log("\n## missing or unknown roles are never turned into another role");
ok("no role gives nothing, not Admin", roleLabel(undefined) === "" && roleLabel(null) === "" && roleLabel("") === "");
ok("an unknown value is shown as it is, never replaced by Admin", roleLabel("AUDITOR") === "AUDITOR" && roleLabel("AUDITOR") !== "Admin");
ok("nothing but ADMIN ever produces the word Admin", ["HR", "MANAGER", "EMPLOYEE", "", "x"].every((r) => roleLabel(r) !== "Admin"));

console.log("\n## home dashboard titles");
ok("HR gets 'HR Dashboard'", dashboardTitle("HR") === "HR Dashboard");
ok("Admin gets 'Admin Dashboard'", dashboardTitle("ADMIN") === "Admin Dashboard");
ok("Manager and Employee have no special title (they keep their Today page)", dashboardTitle("MANAGER") === null && dashboardTitle("EMPLOYEE") === null && dashboardTitle(undefined) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
