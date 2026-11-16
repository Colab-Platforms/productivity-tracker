-- Only safe once no draft holds To Do: those rows are turned into In Progress first.
UPDATE "task_drafts" SET "progress" = 'IN_PROGRESS' WHERE "progress" = 'TODO';
ALTER TABLE "task_drafts" DROP CONSTRAINT IF EXISTS "task_drafts_progress_check";
ALTER TABLE "task_drafts" ADD CONSTRAINT "task_drafts_progress_check" CHECK ("progress" IN ('COMPLETED', 'IN_PROGRESS', 'BLOCKED'));
