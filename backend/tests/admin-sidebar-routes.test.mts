// Admin sidebar wiring, checked from the source of the sidebar itself (no database, no browser):
// every Admin menu item points at a page that exists, no two items share an address, every label is unique, the owner-only pages are guarded,
// and the active-highlight rule keeps working for shortcut items. Run: npx tsx tests/admin-sidebar-routes.test.mts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isNavActive } from "../../frontend/app/dashboard/_shell/navActive.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c || x === undefined ? "" : "  -> " + JSON.stringify(x))); };

const FE = join(import.meta.dirname, "..", "..", "frontend", "app");
// The Productivity Supervisor has a menu of its own further down the file; this test is about the main role menu (Admin, HR, Manager, Employee).
const fullLayout = readFileSync(join(FE, "dashboard", "layout.tsx"), "utf8");
const layout = fullLayout.split("// The Productivity Supervisor's own menu")[0];

type Item = { href: string; label: string; roles: string[] | null; notRoles: string[] | null };
const items: Item[] = [];
for (const m of layout.matchAll(/\{\s*href:\s*"([^"]+)",\s*label:\s*"([^"]+)"[^}]*?\}/g)) {
  const body = m[0];
  const list = (key: string) => { const r = body.match(new RegExp(key + ":\\s*\\[([^\\]]*)\\]")); return r ? [...r[1].matchAll(/"([A-Z]+)"/g)].map((x) => x[1]) : null; };
  items.push({ href: m[1], label: m[2], roles: list("roles"), notRoles: list("notRoles") });
}
const seesAdmin = (i: Item) => (i.roles ? i.roles.includes("ADMIN") : true) && !(i.notRoles ?? []).includes("ADMIN");
const admin = items.filter(seesAdmin);

ok("the sidebar source was read (found Admin items)", admin.length >= 20, admin.length);

// 1. every Admin item opens a page that exists
const pageFor = (href: string) => {
  const path = href.split("?")[0];
  if (path === "/change-password") return join(FE, "change-password", "page.tsx");
  return join(FE, ...path.replace(/^\//, "").split("/"), "page.tsx");
};
for (const i of admin) ok(`"${i.label}" (${i.href}) has a page`, existsSync(pageFor(i.href)));

// 2. no two Admin items share the same address, and every label is unique
const byHref = new Map<string, string[]>();
for (const i of admin) byHref.set(i.href, [...(byHref.get(i.href) ?? []), i.label]);
ok("no two Admin menu items use the same address", [...byHref.values()].every((v) => v.length === 1), [...byHref].filter(([, v]) => v.length > 1));
const labels = admin.map((i) => i.label);
ok("every Admin menu label is unique", new Set(labels).size === labels.length, labels.filter((l, k) => labels.indexOf(l) !== k));

// 3. shortcut items (with ?tab=) must stay a link to a page that reads that tab from its own address, never from window.location
const reports = readFileSync(join(FE, "dashboard", "reports", "page.tsx"), "utf8");
ok("Reports reads its tab from useSearchParams (so the Productivity shortcut works from any page)", /useSearchParams\(\)/.test(reports) && !/new URLSearchParams\(window\.location\.search\)\.get\("tab"\)/.test(reports));
const adminPage = readFileSync(join(FE, "dashboard", "admin", "page.tsx"), "utf8");
ok("the Owner Dashboard decides its old-link redirect from useSearchParams, not window.location", /useSearchParams\(\)/.test(adminPage));

// 4. owner-only pages are guarded for Admin, and the guard does not name any person
const GUARDED = ["admin", "audit-logs", "employee-overview", "approval-centre"];
for (const g of GUARDED) {
  const src = readFileSync(join(FE, "dashboard", g, "page.tsx"), "utf8");
  ok(`/dashboard/${g} is guarded with useRoleGate(["ADMIN"])`, /useRoleGate\(\["ADMIN"\]/.test(src));
}
// Organization Management (Company Management, Organization Hierarchy, Project Management): the shell and each module view guard for Admin, and each tab page uses the shell
const shell = readFileSync(join(FE, "dashboard", "organization", "OrganizationShell.tsx"), "utf8");
const GATE = /useRoleGate\(\["ADMIN"\]/;
ok("the Organization Management shell is guarded for Admin only", GATE.test(shell));
for (const [tab, view] of [["company", "CompaniesView"], ["hierarchy", "HierarchyView"], ["projects", "ProjectsView"]]) {
  ok(`/dashboard/organization/${tab} renders its module inside the shell`, /OrganizationShell/.test(readFileSync(join(FE, "dashboard", "organization", tab, "page.tsx"), "utf8")) && GATE.test(readFileSync(join(FE, "dashboard", "organization", "_views", view + ".tsx"), "utf8")));
}
for (const [old, to] of [["companies", "/dashboard/organization/company"], ["projects", "/dashboard/organization/projects"], ["organization-hierarchy", "/dashboard/organization/hierarchy"]]) ok(`the old /dashboard/${old} address redirects to ${to}`, readFileSync(join(FE, "dashboard", old, "page.tsx"), "utf8").includes(`redirect("${to}")`));
const gate = readFileSync(join(FE, "dashboard", "_routing", "useRoleGate.ts"), "utf8");
ok("the route guard decides by role only (no employee code, name or id check)", !/employeeCode|firstName|lastName|OWNER_CODES|=== "AI-|=== "SSB|=== "JAY/.test(gate));

// 5. the active-highlight rule: exactly one item lit; a ?tab= shortcut when the address carries its tab, otherwise the plain page entry
ok("the sidebar uses the shared isNavActive rule", fullLayout.includes("isNavActive(item.href, allHrefs, pathname"));
const hrefs = admin.map((i) => i.href);
const lit = (pathname: string, q: string) => hrefs.filter((h) => isNavActive(h, hrefs, pathname, new URLSearchParams(q)));
ok("Reports with no tab lights only Reports & Analytics", lit("/dashboard/reports", "").join() === "/dashboard/reports");
ok("Reports on the productivity tab lights only the Productivity shortcut", lit("/dashboard/reports", "tab=productivity").join() === "/dashboard/reports?tab=productivity");
ok("Reports on another tab (shift) lights the plain entry", lit("/dashboard/reports", "tab=shift").join() === "/dashboard/reports");
ok("User Management with no tab lights only User Management", lit("/dashboard/employees", "").join() === "/dashboard/employees");
ok("User Management on its Teams tab still lights only User Management", lit("/dashboard/employees", "tab=Teams").join() === "/dashboard/employees");
ok("System Settings is gone from the Admin menu; its old address redirects to User Management's Shifts tab", !hrefs.some((h) => h.includes("system-settings")) && !labels.includes("System Settings") && readFileSync(join(FE, "dashboard", "system-settings", "page.tsx"), "utf8").includes('redirect("/dashboard/employees?tab=Shifts")'));
ok("the People tab lights only User Management", lit("/dashboard/employees", "tab=People").join() === "/dashboard/employees");
ok("filters in the address do not stop the plain entry being lit", lit("/dashboard/reports", "company=x&project=y").join() === "/dashboard/reports");
const orgHref = "/dashboard/organization/company";
ok("Organization Management stays lit on all three of its tabs, and only it", ["/dashboard/organization/company", "/dashboard/organization/hierarchy", "/dashboard/organization/projects"].every((p) => lit(p, "").join() === orgHref));
ok("the three old separate entries no longer exist", !hrefs.some((h) => ["/dashboard/companies", "/dashboard/projects", "/dashboard/organization-hierarchy"].includes(h)) && hrefs.includes(orgHref));
ok("every other page lights exactly its own item", admin.every((i) => { const p = i.href.split("?")[0]; if (p === "/dashboard/reports" || p === "/dashboard/employees" || p === "/change-password") return true; return lit(p, "").join() === i.href; }));
ok("a page outside the menu lights nothing", lit("/dashboard/profile", "").length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
