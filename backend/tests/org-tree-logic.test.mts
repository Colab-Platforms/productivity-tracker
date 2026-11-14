// Organization Hierarchy: tree building, flags, candidates, filters. No database.
import { buildHierarchy, candidatesFor, descendantsOf, issueOf, passes, visibleIds, type OrgPerson } from "../../frontend/app/dashboard/_hierarchy/orgTree.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (!c && x !== undefined ? "  -> " + JSON.stringify(x).slice(0, 300) : "")); };

const P = (id: string, role: string, boss: string | null, over: Partial<OrgPerson> = {}): OrgPerson => ({
  id, name: `Person ${id}`, employeeCode: `C-${id}`, role, status: "ACTIVE", designation: null, company: "Alpha", companyId: "c1",
  reportsTo: boss ? { id: boss, name: `Person ${boss}` } : null, teams: [], ...over,
});
const people: OrgPerson[] = [
  P("a1", "ADMIN", null), P("a2", "ADMIN", null), P("a3", "ADMIN", null), P("a4", "ADMIN", null),
  P("m1", "MANAGER", "a1"), P("m2", "MANAGER", "a2", { company: "Beta", companyId: "c2" }), P("m3", "MANAGER", null),
  P("e1", "EMPLOYEE", "m1", { teams: [{ id: "t1", name: "Sales" }], designation: "Analyst" }),
  P("e2", "EMPLOYEE", "m1"),
  P("e3", "EMPLOYEE", "m2", { company: "Beta", companyId: "c2", teams: [{ id: "t2", name: "Ops" }] }),
  P("e4", "EMPLOYEE", null),                         // no manager
  P("e5", "EMPLOYEE", "a1"),                         // reports to an Admin directly
  P("e6", "EMPLOYEE", "mx", { status: "ACTIVE" }),   // boss not in the list
  P("e7", "EMPLOYEE", "ms"),                         // boss suspended
  P("ms", "MANAGER", "a1", { status: "SUSPENDED" }),
  P("h1", "HR", null),
  P("ex", "EMPLOYEE", "m1", { status: "EXITED" }),
];
const byId = new Map(people.map((p) => [p.id, p]));
const h = buildHierarchy(people);

ok("the four Admins are the top level, peers of each other", h.admins.length === 4 && h.admins.every((a) => a.person.role === "ADMIN"));
ok("no Admin has a reporting manager in the tree and none is flagged", h.admins.every((a) => a.person.reportsTo === null && a.issue === null));
const a1 = h.admins.find((a) => a.person.id === "a1")!;
ok("a Manager sits under their Admin", a1.children.some((c) => c.person.id === "m1"));
const m1 = a1.children.find((c) => c.person.id === "m1")!;
ok("employees sit under their Manager, with names", m1.children.map((c) => c.person.id).join() === "e1,e2");
ok("direct count and team count are right (exited people are not counted)", m1.direct === 2 && m1.team === 2 && a1.direct === 2 /* m1 + e5 (suspended ms is not live) */ && a1.team === 4, { m1: [m1.direct, m1.team], a1: [a1.direct, a1.team] });
ok("a Manager under an Admin of ANOTHER company is placed under that Admin (cross-company is real data)", h.admins.find((a) => a.person.id === "a2")!.children[0].person.id === "m2");
ok("an employee who reports to an Admin directly is shown there and flagged WRONG_ROLE", a1.children.find((c) => c.person.id === "e5")?.issue?.kind === "WRONG_ROLE");
const kinds = Object.fromEntries(h.needsAttention.map((x) => [x.person.id, x.issue.kind]));
ok("no boss, wrong kind of boss, suspended boss and unknown boss are each reported", kinds.e4 === "NO_MANAGER" && kinds.m3 === "NO_MANAGER" && kinds.e5 === "WRONG_ROLE" && kinds.e7 === "BOSS_INACTIVE" && kinds.e6 === "BOSS_UNKNOWN", kinds);
ok("correct lines and Admins and HR are not reported", !("e1" in kinds) && !("a1" in kinds) && !("h1" in kinds) && !("e3" in kinds) && !("m1" in kinds));
const placedIds: string[] = [];
const walkIds = (n: { person: OrgPerson; children: unknown[] }) => { placedIds.push(n.person.id); (n.children as typeof n[]).forEach(walkIds); };
h.admins.forEach(walkIds);
ok("suspended and exited people are not placed anywhere (tree, attention list or outside list)", ![...placedIds, ...h.needsAttention.map((x) => x.person.id), ...h.outsideTree.map((p) => p.id)].some((id) => id === "ms" || id === "ex"));
ok("HR with nobody above is listed apart, not flagged", h.outsideTree.map((p) => p.id).join() === "h1");
ok("summary counts", h.counts.admins === 4 && h.counts.managers === 3 && h.counts.employees === 7 && h.counts.needsAttention === 5, h.counts);
ok("issueOf works one person at a time", issueOf(byId.get("e1")!, byId)=== null && issueOf(byId.get("ms")!, byId) === null);

// loops in bad data cannot hang the page
const loop: OrgPerson[] = [P("x", "MANAGER", "y"), P("y", "MANAGER", "x"), P("a", "ADMIN", null)];
ok("a loop in the data does not recurse forever", buildHierarchy(loop).admins.length === 1);

// candidates
ok("an employee may pick any active Manager, any company, not themselves", candidatesFor(byId.get("e1")!, people).map((c) => c.id).join() === "m1,m2,m3", candidatesFor(byId.get("e1")!, people).map((c) => c.id));
ok("a Manager may pick any active Admin only", candidatesFor(byId.get("m1")!, people).map((c) => c.id).join() === "a1,a2,a3,a4");
ok("an Admin is offered nobody (Admins report to nobody)", candidatesFor(byId.get("a1")!, people).length === 0);
ok("HR may pick a Manager or an Admin", candidatesFor(byId.get("h1")!, people).length === 7);
ok("suspended and exited people are never offered", !candidatesFor(byId.get("e4")!, people).some((c) => c.id === "ms"));
const chain: OrgPerson[] = [P("a", "ADMIN", null), P("b", "MANAGER", "a"), P("c", "MANAGER", "b")];
ok("someone below you is never offered as your boss (no loops)", descendantsOf("b", chain).has("c") && !candidatesFor(P("b", "HR", "a"), [...chain, P("b", "HR", "a")]).some((c) => c.id === "c"));

// filters
const f = (o: Partial<{ q: string; companyId: string; projectIds: string[] }>) => ({ q: "", companyId: "", projectIds: [], ...o });
ok("search by name, ID, designation and team", passes(byId.get("e1")!, f({ q: "person e1" })) && passes(byId.get("e1")!, f({ q: "c-e1" })) && passes(byId.get("e1")!, f({ q: "analyst" })) && passes(byId.get("e1")!, f({ q: "sales" })) && !passes(byId.get("e1")!, f({ q: "zzz" })));
ok("company filter", passes(byId.get("e3")!, f({ companyId: "c2" })) && !passes(byId.get("e1")!, f({ companyId: "c2" })));
ok("project filter (any of the chosen projects)", passes(byId.get("e1")!, f({ projectIds: ["t1", "t9"] })) && !passes(byId.get("e1")!, f({ projectIds: ["t2"] })) && !passes(byId.get("e2")!, f({ projectIds: ["t1"] })));
const v = visibleIds(h.admins, f({ q: "person e1" }));
ok("a match is shown in its place: its Manager and Admin stay visible, others hidden", v.match.has("e1") && v.show.has("m1") && v.show.has("a1") && !v.show.has("e2") && !v.show.has("a2"), [...v.show]);
const v2 = visibleIds(h.admins, f({ projectIds: ["t2"] }));
ok("project filter keeps the chain above the people on that project", v2.match.has("e3") && v2.show.has("m2") && v2.show.has("a2") && !v2.show.has("a1"), [...v2.show]);
ok("no filters = everything matches", visibleIds(h.admins, f({})).show.size === h.admins.reduce((n, a) => n + 1 + a.team, 0));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
