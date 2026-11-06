import { prisma } from "../../lib/prisma.js";
import { managerIdsByTeam } from "../../lib/teamManagers.js";
import { getPinnedCompany, onlyPinnedCompany } from "../../lib/deployment.js";
import { progressOf, type Progress } from "./tasks.entry.logic.js";

// ---------------------------------------------------------------------------
// TASK ENTRY DETAILS (database side): hours spent, the tagged reporting manager, "Blocked", the manager's approval comment.
// Before migration 20261103100000_org_hierarchy_workflows the table does not exist: entryReady() is false, every read returns nothing, and
// tasks behave exactly as before.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/task_entry_details/.test(msg) && /does not exist|relation/.test(msg));
};

let readyValue = false;
let readyCheckedAt = 0;
export async function entryReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await prisma.taskEntryDetail.findFirst({ select: { id: true } });
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

export type EntryDetail = {
  hoursSpent: number | null;
  taggedManagerId: string | null;
  taggedManagerName: string | null;
  taggedManagerActive: boolean;
  blocked: boolean;
  blockedNote: string | null;
  approvalNote: string | null;
};

/** task id -> its details (only tasks that have a row). */
export async function entryDetailsFor(taskIds: string[]): Promise<Map<string, EntryDetail>> {
  const out = new Map<string, EntryDetail>();
  if (taskIds.length === 0 || !(await entryReady())) return out;
  const rows = await prisma.taskEntryDetail.findMany({ where: { taskId: { in: taskIds } } });
  const mgrIds = [...new Set(rows.map((r) => r.taggedManagerId).filter((x): x is string => !!x))];
  const mgrs = mgrIds.length ? await prisma.user.findMany({ where: { id: { in: mgrIds } }, select: { id: true, firstName: true, lastName: true, status: true } }) : [];
  const byId = new Map(mgrs.map((m) => [m.id, m]));
  for (const r of rows) {
    const m = r.taggedManagerId ? byId.get(r.taggedManagerId) : undefined;
    out.set(r.taskId, {
      hoursSpent: r.hoursSpent,
      taggedManagerId: r.taggedManagerId,
      taggedManagerName: m ? `${m.firstName} ${m.lastName}`.trim() : null,
      taggedManagerActive: m ? String(m.status) === "ACTIVE" || String(m.status) === "INVITED" : false,
      blocked: r.blocked,
      blockedNote: r.blockedNote,
      approvalNote: r.approvalNote,
    });
  }
  return out;
}

/** The fields a task row carries for the new form: progress, hours, tagged manager, the manager's comment. Null fields when there is no row. */
export function entryView(status: string, d: EntryDetail | undefined) {
  return {
    progress: progressOf(status, d?.blocked === true) as Progress | "NOT_STARTED",
    hoursSpent: d?.hoursSpent ?? null,
    taggedManagerId: d?.taggedManagerId ?? null,
    taggedManager: d?.taggedManagerName ?? null,
    blocked: d?.blocked === true,
    blockedNote: d?.blockedNote ?? null,
    approvalNote: d?.approvalNote ?? null,
  };
}

/**
 * Who an employee may TAG as the approver of a task. Read from the existing records, never typed in, and independent of the employee's own
 * project and reporting line. The list is every ACTIVE Manager or Admin who is
 *  - someone's reporting manager (the distinct targets of users.reportsToId), or
 *  - the main manager or a co-manager of an active project (teams.managerId, team_managers),
 * in any company (a deployment pinned to one company keeps only that company). Each person appears once (by user id). Never the employee,
 * HR, Employee-role people (a project "manager" who is an Employee is not eligible) or suspended people.
 */
export async function eligibleManagers(owner: { id: string; platformId: string }) {
  const [reportTargets, activeTeams] = await Promise.all([
    prisma.user.findMany({ where: { reportsToId: { not: null }, status: { in: ["ACTIVE", "INVITED"] } }, select: { reportsToId: true }, distinct: ["reportsToId"] }),
    prisma.team.findMany({ where: { isActive: true }, select: { id: true } }),
  ]);
  const byTeam = await managerIdsByTeam(activeTeams.map((t) => t.id));
  const ids = new Set<string>();
  for (const r of reportTargets) if (r.reportsToId) ids.add(r.reportsToId);
  for (const list of byTeam.values()) for (const id of list) ids.add(id);
  ids.delete(owner.id);
  const pinned = await onlyPinnedCompany([...ids]);
  const users = await prisma.user.findMany({
    where: { id: { in: pinned }, status: "ACTIVE", role: { in: ["MANAGER", "ADMIN"] } },
    select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });
  return users.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), code: u.employeeCode, role: String(u.role) }));
}

/**
 * Who a new task is tagged to: exactly the manager the employee chose, nothing is filled in for them. It must be one of their eligible
 * managers (BAD_TAGGED_MANAGER otherwise). When managers exist and none was chosen the task is refused (TAGGED_MANAGER_REQUIRED); only a
 * company with no eligible manager at all keeps the earlier review rule (the reporting line). The choice is saved with the task, so a
 * later change of a project's manager or of the reporting line never moves a task that is already submitted.
 */
export async function resolveTaggedManager(owner: { id: string; platformId: string }, taggedId: unknown): Promise<string | null> {
  const tagged = typeof taggedId === "string" && taggedId ? taggedId : null;
  if (taggedId !== undefined && taggedId !== null && taggedId !== "" && !tagged) throw new Error("BAD_TAGGED_MANAGER");
  const eligible = await eligibleManagers(owner);
  if (tagged) {
    if (!eligible.some((m) => m.id === tagged)) throw new Error("BAD_TAGGED_MANAGER");
    return tagged;
  }
  if (eligible.length === 0) return null;
  throw new Error("TAGGED_MANAGER_REQUIRED");
}

/**
 * Every ACTIVE project in the records (any company; a deployment pinned to one company keeps only that company), whether or not the
 * employee is on it. Real project ids. Two projects that share a name in different companies (for example "Colab Delivery") are different
 * records, so the company is added to their label to tell them apart; a unique name is shown as it is. Nothing is merged or created.
 */
export async function selectableProjects(_owner: { id: string; platformId: string }) {
  const pin = await getPinnedCompany();
  const teams = await prisma.team.findMany({
    where: { isActive: true, ...(pin ? { platformId: pin.id } : {}) },
    select: { id: true, name: true, platform: { select: { name: true } }, platformId: true },
    orderBy: [{ name: "asc" }],
  });
  const count = new Map<string, number>();
  for (const t of teams) count.set(t.name.trim().toLowerCase(), (count.get(t.name.trim().toLowerCase()) ?? 0) + 1);
  return teams
    .map((t) => ({
      id: t.id,
      name: t.name,
      company: t.platform?.name ?? null,
      ownCompany: t.platformId === _owner.platformId,
      label: (count.get(t.name.trim().toLowerCase()) ?? 0) > 1 && t.platform?.name ? `${t.name} · ${t.platform.name}` : t.name,
    }))
    .sort((x, y) => x.label.localeCompare(y.label));
}

/** What the form needs: all selectable projects and all eligible managers, as two independent lists. */
export async function entryFormChoices(userId: string, platformId: string) {
  const owner = { id: userId, platformId };
  const [projects, managers] = await Promise.all([selectableProjects(owner), eligibleManagers(owner)]);
  return { projects, managers };
}
