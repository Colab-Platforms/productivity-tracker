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
 * The Managers a person is AUTHORISED to tag, read from the existing relationships (nothing is stored for this):
 *  - their own reporting manager (when an active Manager; allowed even in another company, the owner's decision), and
 *  - the active Managers of the same company who manage (primary or co-manager) an active project the person is an active member of.
 * An unrelated manager, or one from an unrelated company, is never offered and is refused on the server.
 */
export async function authorizedManagers(owner: { id: string; platformId: string }) {
  const me = await prisma.user.findUnique({
    where: { id: owner.id },
    select: {
      reportsToId: true,
      reportsTo: { select: { id: true, firstName: true, lastName: true, employeeCode: true, role: true, status: true } },
      teamMemberships: { where: { isActive: true, team: { isActive: true } }, select: { teamId: true } },
    },
  });
  const byTeam = await managerIdsByTeam((me?.teamMemberships ?? []).map((m) => m.teamId));
  const projectManagerIds = [...new Set([...byTeam.values()].flat())].filter((id) => id !== owner.id);
  const projectManagers = projectManagerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: projectManagerIds }, role: "MANAGER", status: "ACTIVE", platformId: owner.platformId },
        select: { id: true, firstName: true, lastName: true, employeeCode: true },
      })
    : [];
  const list = new Map<string, { id: string; firstName: string; lastName: string; employeeCode: string | null }>();
  const rt = me?.reportsTo;
  const reportingOk = !!rt && rt.id !== owner.id && String(rt.role) === "MANAGER" && String(rt.status) === "ACTIVE";
  if (reportingOk) list.set(rt!.id, rt!);
  for (const m of projectManagers) list.set(m.id, m);
  const options = [...list.values()].sort((a, b) => a.firstName.localeCompare(b.firstName));
  // Preselected: the reporting manager; failing that, the only authorised manager there is.
  const defaultId = reportingOk ? rt!.id : options.length === 1 ? options[0].id : null;
  return { options, defaultId };
}

/**
 * Who a new task is tagged to. The tag must be one of the person's authorised managers (BAD_TAGGED_MANAGER otherwise).
 * Nothing sent: the preselected manager is used; if the person has authorised managers but none is preselected, they must choose
 * (TAGGED_MANAGER_REQUIRED). A person with NO authorised manager gets no tag and keeps the earlier review rule (project/team manager or
 * reporting line), so nobody is locked out of submitting while reporting lines are being mapped.
 */
export async function resolveTaggedManager(owner: { id: string; platformId: string }, taggedId: unknown): Promise<string | null> {
  const tagged = typeof taggedId === "string" && taggedId ? taggedId : null;
  if (taggedId !== undefined && taggedId !== null && taggedId !== "" && !tagged) throw new Error("BAD_TAGGED_MANAGER");
  const { options, defaultId } = await authorizedManagers(owner);
  if (tagged) {
    if (!options.some((m) => m.id === tagged)) throw new Error("BAD_TAGGED_MANAGER");
    return tagged;
  }
  if (defaultId) return defaultId;
  if (options.length > 0) throw new Error("TAGGED_MANAGER_REQUIRED");
  return null;
}

/** The Managers an employee may tag, and who is preselected. */
export async function taggedManagerChoices(owner: { id: string; platformId: string }) {
  const { options, defaultId } = await authorizedManagers(owner);
  return { defaultId, options: options.map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}`.trim(), code: m.employeeCode })) };
}
