import { prisma } from "../../lib/prisma.js";

// ---------------------------------------------------------------------------
// DELETED TASKS: the one filter every task reader uses.
// A task is "deleted" when it has a row in task_deletions (the task itself is never changed). Every list, count, rating average and report
// adds `...(await activeTasks())` to its `where`, so a deleted task disappears from all of them at once and cannot be double-counted.
// Before migration 20261116120000_task_deletions the table does not exist: nothing is deleted yet and the filter is empty.
// ---------------------------------------------------------------------------

const isMissingTable = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  const msg = e instanceof Error ? e.message : "";
  return code === "P2021" || (/task_deletions/.test(msg) && /does not exist|relation/.test(msg));
};

let readyValue = false;
let readyCheckedAt = 0;
export async function deletionsReady(): Promise<boolean> {
  if (readyValue) return true;
  if (Date.now() - readyCheckedAt < 15_000) return false;
  readyCheckedAt = Date.now();
  try {
    await prisma.taskDeletion.findFirst({ select: { id: true } });
    readyValue = true;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    readyValue = false;
  }
  return readyValue;
}

/** Spread into a DailyTask `where`: tasks that have NOT been deleted. Empty until the table exists. */
export async function activeTasks(): Promise<{ deletion?: { is: null } }> {
  return (await deletionsReady()) ? { deletion: { is: null } } : {};
}

/** Is this one task deleted? (For actions on a single task.) */
export async function isTaskDeleted(taskId: string): Promise<boolean> {
  if (!(await deletionsReady())) return false;
  return (await prisma.taskDeletion.findUnique({ where: { taskId }, select: { id: true } })) !== null;
}
