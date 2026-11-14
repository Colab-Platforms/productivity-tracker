// Employee Overview: every number on the page is counted here, from the list the server already returns for /admin/users (the people this Admin may
// see). Pure functions, so they can be tested on their own. Nothing is invented: a missing designation, team or manager is counted as exactly that.

export type OverviewPerson = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  employeeCode: string | null;
  role: string;
  status: string;
  designation: string | null;
  dateOfJoining: string | null;
  onboardingStatus: string;
  trackerAccessEnabled: boolean;
  lastLoginAt: string | null;
  shift: { id: string; name: string } | null;
  reportsTo: { id: string; name: string } | null;
  teams: { id: string; name: string }[];
  company?: string | null;
  companyId?: string;
  photoAt?: string | null;
};

/** ACTIVE = working now. INACTIVE = suspended or exited. NOT_STARTED = invited or candidate (account made, not started yet). */
export type StatusView = "ACTIVE" | "INACTIVE" | "ALL";

const INACTIVE_STATUSES = ["SUSPENDED", "EXITED"];
const NOT_STARTED_STATUSES = ["INVITED", "CANDIDATE"];

export type StatusCounts = { total: number; active: number; inactive: number; notStarted: number; suspended: number; exited: number; invited: number; candidate: number };

/** Total is every record in view; Active + Inactive + Not started always add up to it. */
export function statusCounts(people: OverviewPerson[]): StatusCounts {
  const c: StatusCounts = { total: people.length, active: 0, inactive: 0, notStarted: 0, suspended: 0, exited: 0, invited: 0, candidate: 0 };
  for (const p of people) {
    if (p.status === "ACTIVE") c.active += 1;
    else if (INACTIVE_STATUSES.includes(p.status)) c.inactive += 1;
    else if (NOT_STARTED_STATUSES.includes(p.status)) c.notStarted += 1;
    if (p.status === "SUSPENDED") c.suspended += 1;
    if (p.status === "EXITED") c.exited += 1;
    if (p.status === "INVITED") c.invited += 1;
    if (p.status === "CANDIDATE") c.candidate += 1;
  }
  return c;
}

export function inView(people: OverviewPerson[], view: StatusView): OverviewPerson[] {
  if (view === "ALL") return people;
  if (view === "ACTIVE") return people.filter((p) => p.status === "ACTIVE");
  return people.filter((p) => INACTIVE_STATUSES.includes(p.status));
}

export type Bucket = { key: string; label: string; count: number; href?: string };

function tally(entries: { key: string; label: string }[]): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const e of entries) {
    const hit = m.get(e.key);
    if (hit) hit.count += 1;
    else m.set(e.key, { key: e.key, label: e.label, count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export const byCompany = (people: OverviewPerson[]): Bucket[] =>
  tally(people.map((p) => ({ key: p.companyId ?? p.company ?? "none", label: p.company ?? "No company" })));

/** Designation text as typed, grouped without caring about capitals or stray spaces. No designation = "Not assigned". */
export const byDesignation = (people: OverviewPerson[]): Bucket[] =>
  tally(
    people.map((p) => {
      const t = (p.designation ?? "").trim().replace(/\s+/g, " ");
      return t ? { key: t.toLowerCase(), label: t } : { key: "", label: "Not assigned" };
    })
  );

/** Departments are the company's Teams (the system has no separate department field). A person in two teams counts in both; nobody in a team counts as "No team". */
export function byDepartment(people: OverviewPerson[]): { buckets: Bucket[]; inNoTeam: number; inSeveral: number } {
  const entries: { key: string; label: string }[] = [];
  let inNoTeam = 0;
  let inSeveral = 0;
  for (const p of people) {
    if (p.teams.length === 0) {
      inNoTeam += 1;
      entries.push({ key: "", label: "No team" });
    } else {
      if (p.teams.length > 1) inSeveral += 1;
      for (const t of p.teams) entries.push({ key: t.id, label: t.name });
    }
  }
  return { buckets: tally(entries), inNoTeam, inSeveral };
}

/** People per reporting manager (the main reporting line). Nobody above them = "No reporting manager". */
export const byManager = (people: OverviewPerson[]): Bucket[] =>
  tally(people.map((p) => (p.reportsTo ? { key: p.reportsTo.id, label: p.reportsTo.name } : { key: "", label: "No reporting manager" })));

export const directReports = (people: OverviewPerson[], managerId: string): OverviewPerson[] => people.filter((p) => p.reportsTo?.id === managerId);

/** The directory search: name, employee ID, email, designation, company, team or reporting manager. Empty search keeps everyone. */
export function matchesSearch(p: OverviewPerson, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const hay = [p.name, p.employeeCode, p.email, p.designation, p.company, p.reportsTo?.name, ...p.teams.map((t) => t.name)].filter(Boolean).join(" ").toLowerCase();
  return s.split(/\s+/).every((w) => hay.includes(w));
}

/** "2 years 3 months", "5 months", "12 days"; null when no joining date is recorded or it is in the future. Dates are calendar days (YYYY-MM-DD). */
export function tenure(dateOfJoining: string | null, todayIso: string): string | null {
  if (!dateOfJoining) return null;
  const from = dateOfJoining.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || from > todayIso) return null;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = todayIso.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  if (months >= 12) {
    const y = Math.floor(months / 12);
    const m = months % 12;
    return `${y} ${y === 1 ? "year" : "years"}${m ? ` ${m} ${m === 1 ? "month" : "months"}` : ""}`;
  }
  if (months >= 1) return `${months} ${months === 1 ? "month" : "months"}`;
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
  return `${days} ${days === 1 ? "day" : "days"}`;
}
