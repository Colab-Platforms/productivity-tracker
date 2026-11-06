import { prisma } from "../../lib/prisma.js";
import { managerIdsByTeam } from "../../lib/teamManagers.js";
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
 * Who an employee may TAG as the approver of a task. Independent of the project picked and of the reporting line:
 *  - every active Manager of the employee's OWN company,
 *  - active Admins who carry project approval responsibility (they are the main manager or a co-manager of an active project of that company),
 *  - the managers (Manager or Admin) of projects the employee is already assigned to, even when that project is run from another company.
 * Never the employee, HR, an Employee-role person, someone suspended, or an unrelated company's people.
 */
export async function eligibleManagers(owner: { id: string; platformId: string }) {
  const [companyTeams, myTeams] = await Promise.all([
    prisma.team.findMany({ where: { platformId: owner.platformId, isActive: true }, select: { id: true } }),
    prisma.team.findMany({ where: { isActive: true, members: { some: { userId: owner.id, isActive: true } } }, select: { id: true } }),
  ]);
  const byTeam = await managerIdsByTeam([...companyTeams, ...myTeams].map((t) => t.id));
  const companyTeamIds = new Set(companyTeams.map((t) => t.id));
  const myTeamIds = new Set(myTeams.map((t) => t.id));
  const responsible = new Set<string>(); // manage a project of this company
  const mine = new Set<string>(); // manage a project the employee is on
  for (const [teamId, ids] of byTeam) for (const id of ids) {
    if (companyTeamIds.has(teamId)) responsible.add(id);
    if (myTeamIds.has(teamId)) mine.add(id);
  }
  const users = await prisma.user.findMany({
    where: {
      id: { not: owner.id },
      status: "ACTIVE",
      role: { in: ["MANAGER", "ADMIN"] },
      OR: [{ platformId: owner.platformId, role: "MANAGER" }, { id: { in: [...responsible] } }, { id: { in: [...mine] } }],
    },
    select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true },
    orderBy: { firstName: "asc" },
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

/** Every project the employee may pick: all ACTIVE projects of their own company, plus the ones they are already assigned to. */
export async function selectableProjects(owner: { id: string; platformId: string }) {
  const teams = await prisma.team.findMany({
    where: { isActive: true, OR: [{ platformId: owner.platformId }, { members: { some: { userId: owner.id, isActive: true } } }] },
    select: { id: true, name: true, platform: { select: { name: true } }, platformId: true },
    orderBy: { name: "asc" },
  });
  return teams.map((t) => ({ id: t.id, name: t.name, company: t.platform?.name ?? null, ownCompany: t.platformId === owner.platformId }));
}

/** What the form needs: all selectable projects and all eligible managers, as two independent lists. */
export async function entryFormChoices(userId: string, platformId: string) {
  const owner = { id: userId, platformId };
  const [projects, managers] = await Promise.all([selectableProjects(owner), eligibleManagers(owner)]);
  return { projects, managers };
}
