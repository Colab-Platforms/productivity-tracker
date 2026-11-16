import { prisma } from "../../lib/prisma.js";
import { parseIsoDay } from "../../lib/dates.js";
import { auditNote } from "../../lib/auditContext.js";
import { entryReady } from "./tasks.entry.js";
import { selfTasksReady } from "./tasks.self.js";
import { createProposedTask } from "./tasks.service.js";
import { bulkRows, cleanDraftRows, summarize, type DraftRow, type RowResult } from "./tasks.bulk.logic.js";

// ---------------------------------------------------------------------------
// QUICK ADD: several tasks from one screen.
//  - Submit all = the existing single-task creation, run once per row, each in its own transaction. A row that fails changes nothing
//    for the others. Every task is its own record, tagged to its own manager, waiting for THAT manager only.
//  - Drafts = the person's own unsent rows, kept in the NEW table task_drafts (never read by reports, queues or notifications).
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/task_drafts/.test(msg) && /does not exist|relation/.test(msg));
};

let readyValue = false;
let readyCheckedAt = 0;
export async function draftsReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await prisma.taskDraft.findFirst({ select: { id: true } });
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

/** The person's own draft rows (only theirs: the id comes from the sign-in). */
export async function listDrafts(userId: string) {
  if (!(await draftsReady())) return { ready: false, drafts: [] as DraftRow[], updatedAt: null as string | null };
  const rows = await prisma.taskDraft.findMany({ where: { userId }, orderBy: { sortOrder: "asc" } });
  const latest = rows.reduce<Date | null>((m, r) => (!m || r.updatedAt > m ? r.updatedAt : m), null);
  return {
    ready: true,
    drafts: rows.map((r) => ({ title: r.title, description: r.description, teamId: r.teamId, taggedManagerId: r.taggedManagerId, hoursSpent: r.hoursSpent, weight: r.weight, progress: r.progress })),
    updatedAt: latest ? latest.toISOString() : null,
  };
}

/** Replaces the person's whole draft sheet. Unknown projects/managers are dropped from a draft (a draft may be incomplete). */
export async function saveDrafts(userId: string, raw: unknown) {
  if (!(await draftsReady())) throw new Error("FEATURES_NOT_READY");
  const rows = cleanDraftRows(raw);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { platformId: true } });
  if (!user) throw new Error("USER_NOT_FOUND");
  const teamIds = [...new Set(rows.map((r) => r.teamId).filter((x): x is string => !!x))];
  const mgrIds = [...new Set(rows.map((r) => r.taggedManagerId).filter((x): x is string => !!x))];
  const [teams, mgrs] = await Promise.all([
    teamIds.length ? prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true } }) : Promise.resolve([]),
    mgrIds.length ? prisma.user.findMany({ where: { id: { in: mgrIds } }, select: { id: true } }) : Promise.resolve([]),
  ]);
  const okTeam = new Set(teams.map((t) => t.id));
  const okMgr = new Set(mgrs.map((m) => m.id));
  await prisma.$transaction([
    prisma.taskDraft.deleteMany({ where: { userId } }),
    prisma.taskDraft.createMany({
      data: rows.map((r, i) => ({
        platformId: user.platformId,
        userId,
        sortOrder: i,
        title: r.title,
        description: r.description,
        teamId: r.teamId && okTeam.has(r.teamId) ? r.teamId : null,
        taggedManagerId: r.taggedManagerId && okMgr.has(r.taggedManagerId) ? r.taggedManagerId : null,
        hoursSpent: r.hoursSpent,
        weight: r.weight,
        progress: r.progress,
      })),
    }),
  ]);
  return listDrafts(userId);
}

/** Submit all: each row on its own. Returns a result per row (never throws for a single bad row). */
export async function submitBulk(userId: string, raw: unknown, previous: { forDate?: unknown; lateReason?: unknown } = {}) {
  const rows = bulkRows(raw);
  // One previous date for the whole send (Add Previous Day's Tasks). A bad date refuses the whole request before anything is saved.
  const forDate = previous.forDate === undefined || previous.forDate === null || previous.forDate === "" ? undefined : parseIsoDay(previous.forDate);
  if (!(await entryReady())) throw new Error("FEATURES_NOT_READY");
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!me) throw new Error("USER_NOT_FOUND");
  // A manager's own tasks need no approval and have their own screen.
  if (String(me.role) === "MANAGER" && (await selfTasksReady())) throw new Error("BULK_NOT_AVAILABLE");

  const results: RowResult[] = [];
  for (const row of rows) {
    try {
      const created = await createProposedTask(userId, row.body, { rejectDuplicate: true, forDate, lateReason: previous.lateReason });
      results.push({ key: row.key, ok: true, taskId: created.id });
    } catch (e) {
      const code = e instanceof Error ? e.message : "UNKNOWN";
      if (!/^[A-Z_]+$/.test(code)) console.error("[tasks.bulk]", e);
      results.push({ key: row.key, ok: false, code: /^[A-Z_]+$/.test(code) ? code : "UNKNOWN" });
    }
  }
  const summary = summarize(results);
  auditNote({ summary: `Quick Add: ${summary.submitted} of ${summary.total} task${summary.total === 1 ? "" : "s"} sent for approval${forDate ? ` for ${forDate.toISOString().slice(0, 10)} (late submission)` : ""}` });
  return { results, ...summary };
}
