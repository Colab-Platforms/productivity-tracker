// The shared HR filters: reading them from a request and the one matching rule. No database.
import { carried, idList, isFiltering, matches, NO_FILTERS, parseFilters } from "../src/modules/hr-filters/hrFilters.logic.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";

console.log("\n## reading the filters from a request");
ok("no query = no filters", !isFiltering(parseFilters({})) && parseFilters({}).companyIds.length === 0);
ok("several projects, comma separated", parseFilters({ project: `${A},${B}` }).projectIds.join() === `${A},${B}`);
ok("several projects, repeated parameter", idList([A, B]).join() === `${A},${B}`);
ok("a project listed twice is one project", idList(`${A},${A.toUpperCase()}`).length === 1);
ok("anything that is not an id is dropped, never passed on", idList(`${A},not-an-id,'; drop table users;--`).join() === A);
ok("the old names still work (teamId = project)", parseFilters({ teamId: A }).projectIds.join() === A && parseFilters({ companyId: B }).companyIds.join() === B && parseFilters({ managerId: C }).managerIds.join() === C);
ok("a search text is trimmed and capped; an empty one is nothing", parseFilters({ q: "  sana  " }).q === "sana" && parseFilters({ q: "   " }).q === null && (parseFilters({ q: "x".repeat(500) }).q ?? "").length === 80);
ok("an unknown status is ignored", parseFilters({ employmentStatus: "NONSENSE" }).status === null && parseFilters({ employmentStatus: "active" }).status === "ACTIVE");
ok("isFiltering is true for any one filter", isFiltering(parseFilters({ company: A })) && isFiltering(parseFilters({ q: "a" })) && isFiltering(parseFilters({ designation: "Tester" })));

console.log("\n## who matches (every filter must pass; any of several chosen values)");
const p = (o: Partial<Parameters<typeof matches>[0]> = {}) => ({ id: "u1", platformId: A, reportsToId: B, projectIds: [C], designation: "Tester", status: "ACTIVE", name: "Sana Shaikh", employeeCode: "AI-05", ...o });
ok("no filters = everyone", matches(p(), NO_FILTERS));
ok("company", matches(p(), { ...NO_FILTERS, companyIds: [A] }) && !matches(p(), { ...NO_FILTERS, companyIds: [B] }));
ok("reporting manager", matches(p(), { ...NO_FILTERS, managerIds: [B] }) && !matches(p(), { ...NO_FILTERS, managerIds: [C] }) && !matches(p({ reportsToId: null }), { ...NO_FILTERS, managerIds: [B] }));
ok("project: on any of the chosen projects", matches(p({ projectIds: [A, C] }), { ...NO_FILTERS, projectIds: [C, B] }) && !matches(p({ projectIds: [A] }), { ...NO_FILTERS, projectIds: [C] }) && !matches(p({ projectIds: [] }), { ...NO_FILTERS, projectIds: [C] }));
ok("designation (any capitals) and status", matches(p(), { ...NO_FILTERS, designation: "tester" }) && !matches(p(), { ...NO_FILTERS, designation: "Manager" }) && matches(p(), { ...NO_FILTERS, status: "ACTIVE" }) && !matches(p(), { ...NO_FILTERS, status: "INVITED" }));
ok("search finds a name or an employee ID, any capitals", matches(p(), { ...NO_FILTERS, q: "sana" }) && matches(p(), { ...NO_FILTERS, q: "ai-05" }) && !matches(p(), { ...NO_FILTERS, q: "zzz" }));
ok("filters work together (company AND project AND search)", matches(p(), { ...NO_FILTERS, companyIds: [A], projectIds: [C], q: "sana" }) && !matches(p(), { ...NO_FILTERS, companyIds: [A], projectIds: [C], q: "nobody" }));
const people = [p({ id: "u1", projectIds: [A, B, C] }), p({ id: "u2", projectIds: [A] }), p({ id: "u3", projectIds: [C] })];
const chosen = people.filter((x) => matches(x, { ...NO_FILTERS, projectIds: [A, B, C] }));
ok("a person on several chosen projects is counted once", chosen.length === 3 && new Set(chosen.map((x) => x.id)).size === 3);

console.log("\n## what travels between pages");
ok("only company, project and manager are carried", JSON.stringify(carried({ companyIds: [A], projectIds: [B, C], managerIds: [] })) === JSON.stringify({ company: A, project: `${B},${C}` }));
ok("nothing chosen = nothing carried", Object.keys(carried({ companyIds: [], projectIds: [], managerIds: [] })).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
