-- Quick Add drafts can hold a "To Do" task. The drafts table (migration 20261116100000_task_drafts) only allowed three progress values; this widens
-- that one CHECK rule to four. NO column, table or row is added, changed or removed, and the Prisma model does not change (so the running code
-- is not affected before or after this is applied). Until it is applied, saving a draft that contains a To Do task answers a clear message.
ALTER TABLE "task_drafts" DROP CONSTRAINT IF EXISTS "task_drafts_progress_check";
ALTER TABLE "task_drafts" ADD CONSTRAINT "task_drafts_progress_check" CHECK ("progress" IN ('TODO', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED'));
