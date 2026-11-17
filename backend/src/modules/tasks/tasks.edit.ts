// Reading and writing a task's change history (see tasks.edit.logic.ts for what a row holds). The rows live in the existing append-only `task_events`.

import { prisma } from "../../lib/prisma.js";
import { selfTasksReady } from "./tasks.self.js";
import { CHANGE_PREFIX, decodeChange, editInfoOf, encodeChange, type ChangeEventRow, type ChangePayload, type EditInfo } from "./tasks.edit.logic.js";

/** True once task_events exists (it does on the live database since the manager self-tasks migration). */
export const changesReady = selfTasksReady;

/** Every change row of these tasks, oldest first, grouped by task. Empty before the table exists. */
export async function changeEvents(taskIds: string[], db: Pick<typeof prisma, "taskEvent"> = prisma): Promise<Map<string, ChangeEventRow[]>> {
  const out = new Map<string, ChangeEventRow[]>();
  if (taskIds.length === 0 || !(await changesReady())) return out;
  const rows = await db.taskEvent.findMany({
    where: { taskId: { in: taskIds }, kind: "EDITED", note: { startsWith: CHANGE_PREFIX } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, taskId: true, actorId: true, createdAt: true, note: true },
  });
  for (const r of rows) {
    const payload = decodeChange(r.note);
    if (!payload) continue;
    const list = out.get(r.taskId) ?? [];
    list.push({ id: r.id, actorId: r.actorId, createdAt: r.createdAt, payload });
    out.set(r.taskId, list);
  }
  return out;
}

/** For the "Edited" label and the correction badge on many tasks at once (one query). */
export async function editInfoFor(taskIds: string[]): Promise<Map<string, EditInfo>> {
  const events = await changeEvents(taskIds);
  const out = new Map<string, EditInfo>();
  for (const [id, list] of events) out.set(id, editInfoOf(list));
  return out;
}

type TxLike = { taskEvent: { create: (a: { data: { taskId: string; platformId: string; actorId: string; kind: string; note: string }; select: { id: true } }) => Promise<{ id: string }> } };

/** Writes one change row inside the caller's transaction, so the edit and its history succeed or fail together. Returns the row id. */
export async function writeChange(tx: TxLike, o: { taskId: string; platformId: string; actorId: string; payload: ChangePayload }): Promise<string> {
  const row = await tx.taskEvent.create({ data: { taskId: o.taskId, platformId: o.platformId, actorId: o.actorId, kind: "EDITED", note: encodeChange(o.payload) }, select: { id: true } });
  return row.id;
}

/** Task ids that have any change row created after a date. Used to find correction requests without reading every task. */
export async function taskIdsWithChangesSince(since: Date): Promise<string[]> {
  if (!(await changesReady())) return [];
  const rows = await prisma.taskEvent.findMany({
    where: { kind: "EDITED", createdAt: { gte: since }, note: { startsWith: `${CHANGE_PREFIX}{"v":1,"type":"CORRECTION_` } },
    select: { taskId: true },
    distinct: ["taskId"],
  });
  return rows.map((r) => r.taskId);
}
