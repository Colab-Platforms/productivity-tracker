// Organization Hierarchy: how the reporting lines become a tree, who is flagged, who may be picked as a boss. Pure functions (no network), so the
// rules can be tested on their own. Nothing here knows a name: everything comes from each person's own "reports to" on their record.
//
// The rules mirror the server's (backend/src/modules/admin/hierarchy.logic.ts), which still decides when a change is saved:
//   Admin    -> reports to nobody (the Admins are the top level, peers of each other)
//   HR       -> nobody required
//   Manager  -> an Admin
//   Employee -> a Manager

export type OrgPerson = {
  id: string;
  name: string;
  employeeCode: string | null;
  role: string;
  status: string;
  designation: string | null;
  email?: string;
  company?: string | null;
  companyId?: string;
  reportsTo: { id: string; name: string } | null;
  teams: { id: string; name: string }[];
  photoAt?: string | null;
};

/** Who is part of the picture: working people. Candidates, suspended and exited accounts are not placed anywhere in the tree. */
export const isLive = (p: { status: string }) => p.status === "ACTIVE" || p.status === "INVITED";

export function requiredBossRole(role: string): "MANAGER" | "ADMIN" | null {
  if (role === "EMPLOYEE") return "MANAGER";
  if (role === "MANAGER") return "ADMIN";
  return null;
}

export type Issue =
  | { kind: "NO_MANAGER"; text: string }
  | { kind: "WRONG_ROLE"; text: string }
  | { kind: "BOSS_INACTIVE"; text: string }
  | { kind: "BOSS_UNKNOWN"; text: string };

const ROLE_WORD: Record<string, string> = { ADMIN: "an Admin", MANAGER: "a Manager" };

/** What is wrong with this person's reporting line, or null. A boss outside the Admin's view is "unknown", which is reported but not called wrong. */
export function issueOf(p: OrgPerson, byId: Map<string, OrgPerson>): Issue | null {
  if (!isLive(p)) return null;
  const need = requiredBossRole(p.role);
  if (!need) return null; // Admin and HR need no line
  if (!p.reportsTo) return { kind: "NO_MANAGER", text: "No reporting manager" };
  const boss = byId.get(p.reportsTo.id);
  if (!boss) return { kind: "BOSS_UNKNOWN", text: `Reports to ${p.reportsTo.name}, who is outside the people you can see` };
  if (!isLive(boss)) return { kind: "BOSS_INACTIVE", text: `Reports to ${boss.name}, who is ${boss.status === "SUSPENDED" ? "suspended" : "no longer active"}` };
  if (boss.role !== need) return { kind: "WRONG_ROLE", text: `Reports to ${boss.name} (${boss.role === "ADMIN" ? "Admin" : boss.role === "MANAGER" ? "Manager" : boss.role === "HR" ? "HR" : "Employee"}); ${p.role === "EMPLOYEE" ? "an employee" : "a Manager"} should report to ${ROLE_WORD[need]}` };
  return null;
}

export type TreeNode = { person: OrgPerson; issue: Issue | null; children: TreeNode[]; direct: number; team: number };

export type Hierarchy = {
  /** The Admins, all at the top, peers of each other. Each carries the people who report to them. */
  admins: TreeNode[];
  /** Live people who need a reporting line and have none that fits (nobody, the wrong kind of boss, or a boss who left). */
  needsAttention: { person: OrgPerson; issue: Issue }[];
  /** HR (and anyone else who needs no line) with nobody above them, shown apart: they are not part of the reporting tree. */
  outsideTree: OrgPerson[];
  counts: { admins: number; managers: number; employees: number; others: number; needsAttention: number };
};

const byName = (a: OrgPerson, b: OrgPerson) => a.name.localeCompare(b.name);

/** Builds the tree from the people list. A person sits under whoever they report to, as recorded; the issue flag says when that is not right. */
export function buildHierarchy(all: OrgPerson[]): Hierarchy {
  const people = all.filter(isLive);
  const byId = new Map(all.map((p) => [p.id, p]));
  const live = new Map(people.map((p) => [p.id, p]));
  const kids = new Map<string, OrgPerson[]>();
  for (const p of people) {
    const boss = p.reportsTo?.id;
    if (boss && live.has(boss)) kids.set(boss, [...(kids.get(boss) ?? []), p]);
  }
  const seen = new Set<string>();
  const node = (p: OrgPerson): TreeNode => {
    seen.add(p.id);
    const children = (kids.get(p.id) ?? []).filter((c) => !seen.has(c.id)).sort(byName).map(node); // a loop in bad data cannot recurse forever
    const team = children.reduce((n, c) => n + 1 + c.team, 0);
    return { person: p, issue: issueOf(p, byId), children, direct: children.length, team };
  };
  const admins = people.filter((p) => p.role === "ADMIN").sort(byName).map(node);

  const needsAttention: Hierarchy["needsAttention"] = [];
  for (const p of people) {
    const issue = issueOf(p, byId);
    if (issue) needsAttention.push({ person: p, issue });
  }
  needsAttention.sort((a, b) => a.person.name.localeCompare(b.person.name));

  // People with no boss on file who are not Admins and not placed under anyone: the ones needing a line are in needsAttention; HR and similar go here.
  const placed = new Set<string>();
  const mark = (n: TreeNode) => {
    placed.add(n.person.id);
    n.children.forEach(mark);
  };
  admins.forEach(mark);
  const outsideTree = people.filter((p) => !placed.has(p.id) && !requiredBossRole(p.role) && p.role !== "ADMIN").sort(byName);

  const counts = {
    admins: people.filter((p) => p.role === "ADMIN").length,
    managers: people.filter((p) => p.role === "MANAGER").length,
    employees: people.filter((p) => p.role === "EMPLOYEE").length,
    others: people.filter((p) => p.role !== "ADMIN" && p.role !== "MANAGER" && p.role !== "EMPLOYEE").length,
    needsAttention: needsAttention.length,
  };
  return { admins, needsAttention, outsideTree, counts };
}

/** Everyone below `id` (any depth), so a person can never be offered a boss who already reports to them. */
export function descendantsOf(id: string, people: OrgPerson[]): Set<string> {
  const kids = new Map<string, string[]>();
  for (const p of people) if (p.reportsTo) kids.set(p.reportsTo.id, [...(kids.get(p.reportsTo.id) ?? []), p.id]);
  const out = new Set<string>();
  const stack = [...(kids.get(id) ?? [])];
  while (stack.length) {
    const x = stack.pop() as string;
    if (out.has(x)) continue;
    out.add(x);
    stack.push(...(kids.get(x) ?? []));
  }
  return out;
}

/** The people who may be chosen as this person's reporting manager: active, the right role, not themselves, not anyone below them. Any company. */
export function candidatesFor(person: OrgPerson, people: OrgPerson[]): OrgPerson[] {
  const need = requiredBossRole(person.role);
  if (person.role === "ADMIN") return [];
  const below = descendantsOf(person.id, people);
  // HR has no required kind: a Manager or an Admin, as on the server
  return people
    .filter((b) => b.status === "ACTIVE" && b.id !== person.id && !below.has(b.id) && (need ? b.role === need : b.role === "MANAGER" || b.role === "ADMIN"))
    .sort(byName);
}

export type Filters = { q: string; companyId: string; projectIds: string[] };

/** Does this person pass the page's search, company and project filters? Search covers name, ID, designation, email, company and project names. */
export function passes(p: OrgPerson, f: Filters): boolean {
  if (f.companyId && p.companyId !== f.companyId) return false;
  if (f.projectIds.length && !p.teams.some((t) => f.projectIds.includes(t.id))) return false;
  const s = f.q.trim().toLowerCase();
  if (!s) return true;
  const hay = [p.name, p.employeeCode, p.designation, p.email, p.company, ...p.teams.map((t) => t.name)].filter(Boolean).join(" ").toLowerCase();
  return s.split(/\s+/).every((w) => hay.includes(w));
}

export const filtering = (f: Filters) => !!(f.q.trim() || f.companyId || f.projectIds.length);

/** The ids to show when filtering: everyone who passes, plus the chain above each of them (so a match is shown in its place), kept for context. */
export function visibleIds(nodes: TreeNode[], f: Filters): { show: Set<string>; match: Set<string> } {
  const show = new Set<string>();
  const match = new Set<string>();
  const walk = (n: TreeNode): boolean => {
    const own = passes(n.person, f);
    let any = own;
    for (const c of n.children) if (walk(c)) any = true;
    if (own) match.add(n.person.id);
    if (any) show.add(n.person.id);
    return any;
  };
  nodes.forEach(walk);
  return { show, match };
}
