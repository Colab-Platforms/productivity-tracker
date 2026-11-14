// Employee Overview counting rules. No database.
import { byCompany, byDepartment, byDesignation, byManager, directReports, inView, matchesSearch, statusCounts, tenure, type OverviewPerson } from "../../frontend/app/dashboard/_overview/stats.js";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n); };

const P = (id: string, over: Partial<OverviewPerson> = {}): OverviewPerson => ({
  id, name: `Person ${id}`, email: `${id}@x.test`, phone: null, employeeCode: `E-${id}`, role: "EMPLOYEE", status: "ACTIVE", designation: null, dateOfJoining: null,
  onboardingStatus: "ACTIVE", trackerAccessEnabled: true, lastLoginAt: null, shift: null, reportsTo: null, teams: [], company: "Alpha", companyId: "c1", ...over,
});
const boss = { id: "m1", name: "Meera Manager" };
const people = [
  P("1", { designation: "Analyst", reportsTo: boss, teams: [{ id: "t1", name: "Sales" }] }),
  P("2", { designation: " analyst ", reportsTo: boss, teams: [{ id: "t1", name: "Sales" }, { id: "t2", name: "Ops" }] }),
  P("3", { status: "SUSPENDED", company: "Beta", companyId: "c2" }),
  P("4", { status: "EXITED", designation: "Lead", company: "Beta", companyId: "c2" }),
  P("5", { status: "INVITED" }),
  P("6", { status: "CANDIDATE", reportsTo: { id: "m2", name: "Other Boss" } }),
  P("m1", { role: "MANAGER", name: "Meera Manager", designation: "Team Lead" }),
];

const c = statusCounts(people);
ok("total counts every record", c.total === 7);
ok("active / inactive / not started add up to the total", c.active + c.inactive + c.notStarted === c.total && c.active === 3 && c.inactive === 2 && c.notStarted === 2);
ok("inactive splits into suspended and exited; not started into invited and candidate", c.suspended === 1 && c.exited === 1 && c.invited === 1 && c.candidate === 1);
ok("empty list is all zeros", JSON.stringify(statusCounts([])) === JSON.stringify({ total: 0, active: 0, inactive: 0, notStarted: 0, suspended: 0, exited: 0, invited: 0, candidate: 0 }));
ok("view ACTIVE keeps only active people", inView(people, "ACTIVE").length === 3);
ok("view INACTIVE keeps suspended and exited", inView(people, "INACTIVE").map((p) => p.id).join() === "3,4");
ok("view ALL keeps everyone", inView(people, "ALL").length === 7);

const comp = byCompany(people);
ok("by company counts people per company, biggest first", comp[0].label === "Alpha" && comp[0].count === 5 && comp[1].label === "Beta" && comp[1].count === 2);
ok("company counts add up to the number of people", comp.reduce((n, b) => n + b.count, 0) === people.length);

const des = byDesignation(people);
ok("designations ignore capitals and spaces (Analyst + ' analyst ' are one)", des.find((b) => b.label === "Analyst")?.count === 2);
ok("no designation is counted as 'Not assigned', never invented", des.find((b) => b.label === "Not assigned")?.count === 3);
ok("designation counts add up", des.reduce((n, b) => n + b.count, 0) === people.length);

const dep = byDepartment(people);
ok("a person in two teams counts in both", dep.buckets.find((b) => b.label === "Sales")?.count === 2 && dep.buckets.find((b) => b.label === "Ops")?.count === 1);
ok("people with no team are 'No team' and reported", dep.inNoTeam === 5 && dep.buckets.find((b) => b.label === "No team")?.count === 5);
ok("people in several teams are reported", dep.inSeveral === 1);

const mgr = byManager(people);
ok("by manager counts direct reports", mgr.find((b) => b.label === "Meera Manager")?.count === 2 && mgr.find((b) => b.label === "Other Boss")?.count === 1);
ok("no manager is 'No reporting manager'", mgr.find((b) => b.label === "No reporting manager")?.count === 4);
ok("directReports lists exactly the people who report to that manager", directReports(people, "m1").map((p) => p.id).join() === "1,2" && directReports(people, "nobody").length === 0);

ok("search by name, ID, designation, team and manager", matchesSearch(people[0], "person 1") && matchesSearch(people[0], "e-1") && matchesSearch(people[0], "analyst") && matchesSearch(people[0], "sales") && matchesSearch(people[0], "meera"));
ok("every word must match", matchesSearch(people[0], "sales analyst") && !matchesSearch(people[0], "sales lead"));
ok("empty search keeps everyone; a miss keeps nobody", matchesSearch(people[0], "  ") && !matchesSearch(people[0], "zzz"));

ok("tenure in years and months", tenure("2024-01-15", "2026-11-14") === "2 years 9 months");
ok("tenure just under a month counts in days", tenure("2026-11-01", "2026-11-14") === "13 days");
ok("tenure of one month / one year uses the singular", tenure("2026-10-14", "2026-11-14") === "1 month" && tenure("2025-11-14", "2026-11-14") === "1 year");
ok("a month is not complete before the day of the month", tenure("2026-09-20", "2026-11-14") === "1 month");
ok("no joining date or one in the future gives nothing", tenure(null, "2026-11-14") === null && tenure("2027-01-01", "2026-11-14") === null);
ok("a full ISO timestamp from the database works too", tenure("2024-01-15T00:00:00.000Z", "2026-11-14") === "2 years 9 months");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
