-- Soft delete of tasks by their tagged manager: NEW TABLE ONLY. No existing table, column or row is touched.
-- A row here marks a task as deleted (who, their role, when, why). The task itself, its rating and comments stay exactly as they were.
-- Until this is applied the Delete action is unavailable (503 FEATURES_NOT_READY) and every list and report behaves as before.
CREATE TABLE "task_deletions" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "deletedById" UUID,
    "deletedByName" TEXT NOT NULL,
    "deletedByRole" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonNote" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_deletions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_deletions_reasonCode_check" CHECK ("reasonCode" IN ('WRONG_EMPLOYEE', 'WRONG_PROJECT', 'MISTAKE', 'DUPLICATE', 'OTHER'))
);
CREATE UNIQUE INDEX "task_deletions_taskId_key" ON "task_deletions"("taskId");
CREATE INDEX "task_deletions_platformId_deletedAt_idx" ON "task_deletions"("platformId", "deletedAt");
CREATE INDEX "task_deletions_deletedById_idx" ON "task_deletions"("deletedById");
ALTER TABLE "task_deletions" ADD CONSTRAINT "task_deletions_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_deletions" ADD CONSTRAINT "task_deletions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "daily_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_deletions" ADD CONSTRAINT "task_deletions_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
