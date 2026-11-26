import { prisma } from "../../lib/prisma.js";
import { parseIsoDay, platformToday } from "../../lib/dates.js";
import { auditNote } from "../../lib/auditContext.js";

// ---------------------------------------------------------------------------
// MANAGER "PREVIOUS TASKS": a manager's personal notebook of work finished before the system, shown as a tab inside Daily Tasks.
//
// Stored in daily_tasks (owner's choice, no migration), MARKED by carryCount = -1 (carry-forward was never built, so the column is otherwise
// always 0). The ONE shared filter every task reader already uses, activeTasks() (tasks.deleted.ts), now also requires carryCount >= 0, so these
// rows are invisible to the employee list, the approval queue, ratings, productivity, Reports, the Excel exports, the attendance counts, the
// efficiency index and the timer, and no task action (edit, approve, rate, revert, delete) can reach them: they answer "not found".
// Only this module reads or writes them, and only for the manager who owns them.
// ---------------------------------------------------------------------------

export const PREVIOUS_MARK = -1;
const MAX_ENTRIES = 500;

export type PreviousTask = { id: string; title: string; description: string; completedOn: string; createdAt: string; updatedAt: string };

async function manager(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, platformId: true, platform: { select: { timezone: true } } } });
  if (!u) throw new Error("USER_NOT_FOUND");
  // Only managers keep a previous-task notebook. HR, Admin and Employees have their own screens and are refused here.
  if (String(u.role) !== "MANAGER") throw new Error("FORBIDDEN");
  return { platformId: u.platformId, timezone: u.platform?.timezone ?? "Asia/Kolkata" };
}

const row = (t: { id: string; title: string; description: string | null; date: Date; createdAt: Date; updatedAt: Date }): PreviousTask => ({
  id: t.id,
  title: t.title,
  description: t.description ?? "",
  completedOn: t.date.toISOString().slice(0, 10), // @db.Date comes back as UTC midnight: slice, never getDate()
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
}) ;

/** title 3-120, description up to 1000 (optional), completion date a real day that is not in the future (company time zone). */
export function checkPrevious(input: { title?: unknown; description?: unknown; completedOn?: unknown }, todayIso: string, partial = false) {
  const out: { title?: string; description?: string | null; date?: Date } = {};
  if (!partial || input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (title.length < 3) throw new Error("PREV_TITLE_SHORT");
    if (title.length > 120) throw new Error("PREV_TITLE_LONG");
    out.title = title;
  }
  if (input.description !== undefined) {
    const d = typeof input.description === "string" ? input.description.trim() : input.description === null ? "" : null;
    if (d === null) throw new Error("PREV_BAD_DESCRIPTION");
    if (d.length > 1000) throw new Error("PREV_DESCRIPTION_LONG");
    out.description = d.length ? d : null;
  }
  if (!partial || input.completedOn !== undefined) {
    if (input.completedOn === undefined || input.completedOn === null || input.completedOn === "") throw new Error("PREV_DATE_REQUIRED");
    const date = parseIsoDay(input.completedOn); // strict YYYY-MM-DD, real calendar days only (throws BAD_DATE)
    if (date.toISOString().slice(0, 10) > todayIso) throw new Error("PREV_FUTURE_DATE");
    out.date = date;
  }
  return out;
}

export async function listPrevious(userId: string): Promise<{ entries: PreviousTask[]; today: string }> {
  const m = await manager(userId);
  const rows = await prisma.dailyTask.findMany({
    where: { userId, carryCount: PREVIOUS_MARK },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    select: { id: true, title: true, description: true, date: true, createdAt: true, updatedAt: true },
    take: MAX_ENTRIES,
  });
  return { entries: rows.map(row), today: platformToday(m.timezone).toISOString().slice(0, 10) };
}

export async function addPrevious(userId: string, input: { title?: unknown; description?: unknown; completedOn?: unknown }): Promise<PreviousTask> {
  const m = await manager(userId);
  const v = checkPrevious(input, platformToday(m.timezone).toISOString().slice(0, 10));
  if ((await prisma.dailyTask.count({ where: { userId, carryCount: PREVIOUS_MARK } })) >= MAX_ENTRIES) throw new Error("PREV_TOO_MANY");
  const t = await prisma.dailyTask.create({
    data: {
      platformId: m.platformId,
      userId,
      date: v.date!,
      title: v.title!,
      description: v.description ?? null,
      status: "COMPLETED" as never,
      approvalStatus: "APPROVED" as never, // it is the manager's own record; nobody approves it
      approvedById: userId,
      approvedAt: new Date(),
      completedAt: new Date(v.date!.getTime() + 12 * 3600_000), // noon UTC of the completion day
      carryCount: PREVIOUS_MARK,
    },
    select: { id: true, title: true, description: true, date: true, createdAt: true, updatedAt: true },
  });
  auditNote({ platformId: m.platformId, recordType: "PreviousTask", recordId: t.id, summary: `Added a previous task "${t.title}" (completed ${t.date.toISOString().slice(0, 10)})`, after: { title: t.title, completedOn: t.date.toISOString().slice(0, 10) } });
  return row(t);
}

export async function editPrevious(userId: string, id: string, input: { title?: unknown; description?: unknown; completedOn?: unknown }): Promise<PreviousTask> {
  const m = await manager(userId);
  const v = checkPrevious(input, platformToday(m.timezone).toISOString().slice(0, 10), true);
  if (v.title === undefined && v.description === undefined && v.date === undefined) throw new Error("PREV_NOTHING_TO_CHANGE");
  const before = await prisma.dailyTask.findFirst({ where: { id, userId, carryCount: PREVIOUS_MARK }, select: { title: true, description: true, date: true } });
  if (!before) throw new Error("NOT_FOUND"); // not yours, not a previous task, or already deleted
  const data: Record<string, unknown> = {};
  if (v.title !== undefined) data.title = v.title;
  if (v.description !== undefined) data.description = v.description;
  if (v.date !== undefined) { data.date = v.date; data.completedAt = new Date(v.date.getTime() + 12 * 3600_000); }
  const res = await prisma.dailyTask.updateMany({ where: { id, userId, carryCount: PREVIOUS_MARK }, data: data as never });
  if (res.count !== 1) throw new Error("NOT_FOUND");
  const t = await prisma.dailyTask.findUniqueOrThrow({ where: { id }, select: { id: true, title: true, description: true, date: true, createdAt: true, updatedAt: true } });
  auditNote({ platformId: m.platformId, recordType: "PreviousTask", recordId: id, summary: `Edited a previous task "${t.title}"`, before: { title: before.title, description: before.description, completedOn: before.date.toISOString().slice(0, 10) }, after: { title: t.title, description: t.description, completedOn: t.date.toISOString().slice(0, 10) } });
  return row(t);
}

export async function deletePrevious(userId: string, id: string): Promise<{ ok: true }> {
  const m = await manager(userId);
  const before = await prisma.dailyTask.findFirst({ where: { id, userId, carryCount: PREVIOUS_MARK }, select: { title: true, description: true, date: true } });
  if (!before) throw new Error("NOT_FOUND");
  const res = await prisma.dailyTask.deleteMany({ where: { id, userId, carryCount: PREVIOUS_MARK } });
  if (res.count !== 1) throw new Error("NOT_FOUND");
  // It is gone for good, so a readable copy goes to the immutable audit log first.
  auditNote({ platformId: m.platformId, recordType: "PreviousTask", recordId: id, summary: `Deleted a previous task "${before.title}"`, before: { title: before.title, description: before.description, completedOn: before.date.toISOString().slice(0, 10) } });
  return { ok: true };
}
