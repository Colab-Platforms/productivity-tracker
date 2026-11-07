// Which Employees/Admin tabs each role gets. No database.
import { ALL_TABS, tabFor, tabsFor } from "../../frontend/app/dashboard/employees/tabs.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

ok("Admin gets every tab", tabsFor("ADMIN").join() === ALL_TABS.join() && tabsFor("ADMIN").length === 5);
ok("HR gets People and Leave only (Teams/projects are Admin-only)", tabsFor("HR").join() === "People,Leave" && !tabsFor("HR").includes("Teams"));
ok("HR does not get Shifts or Thresholds (organization-wide rules)", !tabsFor("HR").includes("Shifts") && !tabsFor("HR").includes("Thresholds"));
ok("Manager, Employee and an unknown role get none", tabsFor("MANAGER").length === 0 && tabsFor("EMPLOYEE").length === 0 && tabsFor(undefined).length === 0 && tabsFor("X").length === 0);
ok("a tab asked for is kept when the role may have it", tabFor("ADMIN", "Shifts") === "Shifts" && tabFor("HR", "Leave") === "Leave");
ok("HR asking for Shifts, Thresholds or Teams in the address lands on People", tabFor("HR", "Shifts") === "People" && tabFor("HR", "Thresholds") === "People" && tabFor("HR", "Teams") === "People");
ok("no or a made-up tab falls back to the first allowed", tabFor("HR", null) === "People" && tabFor("ADMIN", "nonsense") === "People");
ok("a role with no tabs gets none", tabFor("EMPLOYEE", "People") === null && tabFor(null, "People") === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
