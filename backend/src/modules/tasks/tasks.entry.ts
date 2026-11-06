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
 * The people who may approve a task of a PROJECT: the project's manager and its co-managers, read from the existing project assignments
 * (teams.managerId + team_managers; nothing is hardcoded and nothing new is stored). An active Manager OR Admin qualifies, in any company
 * (a project can be run from another company). The person's own reporting manager is NOT part of this: it is a separate relationship and
 * is only offered when that same person also manages the selected project.
 */
export type ProjectManagerChoices = { options: { id: string; name: string; code: string | null }[]; defaultId: string | null };

export async function projectManagerChoices(teamIds: string[], exceptUserId: string): Promise<Map<string, ProjectManagerChoices>> {
  const out = new Map<string, ProjectManagerChoices>();
  const ids = [...new Set(teamIds)];
  if (ids.length === 0) return out;
  const byTeam = await managerIdsByTeam(ids); // primary manager first, then co-managers
  const allIds = [...new Set([...byTeam.values()].flat())].filter((id) => id !== exceptUserId);
  const users = allIds.length
    ? await prisma.user.findMany({ where: { id: { in: allIds }, status: "ACTIVE", role: { in: ["MANAGER", "ADMIN"] } }, select: { id: true, firstName: true, lastName: true, employeeCode: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const team = await prisma.team.findMany({ where: { id: { in: ids } }, select: { id: true, managerId: true } });
  const primaryOf = new Map(team.map((t) => [t.id, t.managerId]));
  for (const t of ids) {
    const options = (byTeam.get(t) ?? []).filter((id) => byId.has(id)).map((id) => {
      const u = byId.get(id)!;
      return { id, name: `${u.firstName} ${u.lastName}`.trim(), code: u.employeeCode };
    });
    const primary = primaryOf.get(t);
    const defaultId = primary && options.some((o) => o.id === primary) ? primary : options.length === 1 ? options[0].id : null;
    out.set(t, { options, defaultId });
  }
  return out;
}

/**
 * "Other managers": any active Manager or Admin of the person's OWN company (never the person), for work done for a project they are not
 * on, or when their project has no manager. Same-company only: a manager of an unrelated company is never offered.
 */
export async function otherManagerChoices(platformId: string, exceptUserId: string) {
  const users = await prisma.user.findMany({
    where: { platformId, status: "ACTIVE", role: { in: ["MANAGER", "ADMIN"] }, id: { not: exceptUserId } },
    select: { id: true, firstName: true, lastName: true, employeeCode: true },
    orderBy: { firstName: "asc" },
  });
  return users.map((u) => ({ id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), code: u.employeeCode }));
}

/**
 * Who a new task goes to. The choices are (1) the managers of the PROJECT picked for the task and (2) any other manager of the person's
 * own company. Anyone else is refused (BAD_TAGGED_MANAGER).
 * Nothing sent: the project's own manager is used. If the project has none, the person must choose (TAGGED_MANAGER_REQUIRED), and when
 * nobody at all is available the task cannot be sent (PROJECT_HAS_NO_MANAGER). A person with NO project is not blocked: no tag unless they
 * choose one, and the task then keeps the earlier review rule (the reporting line). The tag is saved with the task, so a later change of
 * the project's manager never moves a task that is already submitted.
 */
export async function resolveTaggedManager(owner: { id: string; platformId: string }, taggedId: unknown, teamId: string | null): Promise<string | null> {
  const tagged = typeof taggedId === "string" && taggedId ? taggedId : null;
  if (taggedId !== undefined && taggedId !== null && taggedId !== "" && !tagged) throw new Error("BAD_TAGGED_MANAGER");
  const project = teamId ? ((await projectManagerChoices([teamId], owner.id)).get(teamId) ?? { options: [], defaultId: null }) : { options: [], defaultId: null };
  const others = await otherManagerChoices(owner.platformId, owner.id);
  if (tagged) {
    if (!project.options.some((m) => m.id === tagged) && !others.some((m) => m.id === tagged)) throw new Error("BAD_TAGGED_MANAGER");
    return tagged;
  }
  if (!teamId) return null;
  if (project.defaultId) return project.defaultId;
  if (project.options.length === 0 && others.length === 0) throw new Error("PROJECT_HAS_NO_MANAGER");
  throw new Error("TAGGED_MANAGER_REQUIRED");
}

/** What the form needs: per project who may approve it and who is preselected, plus the other managers of the person's company. */
export async function entryFormChoices(userId: string, platformId: string, teamIds: string[]) {
  const [map, others] = await Promise.all([projectManagerChoices(teamIds, userId), otherManagerChoices(platformId, userId)]);
  const byProject: Record<string, ProjectManagerChoices> = {};
  for (const [id, c] of map) byProject[id] = c;
  return { byProject, others };
}
