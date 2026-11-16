-- Late (previous-day) task submissions: NEW TABLES ONLY. No existing table, column or row is touched.
-- daily_tasks.date stays the original task date and daily_tasks.createdAt stays the real submission time.
-- Until this is applied, a request for a previous date is refused (503 FEATURES_NOT_READY); everything else works as before.
CREATE TABLE "task_late_details" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "lateByDays" INTEGER NOT NULL,
    "outsideWindow" BOOLEAN NOT NULL DEFAULT false,
    "allowedDays" INTEGER NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_late_details_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_late_details_lateByDays_check" CHECK ("lateByDays" >= 1 AND "lateByDays" <= 14),
    CONSTRAINT "task_late_details_allowedDays_check" CHECK ("allowedDays" >= 0 AND "allowedDays" <= 14)
);
CREATE UNIQUE INDEX "task_late_details_taskId_key" ON "task_late_details"("taskId");
CREATE INDEX "task_late_details_userId_idx" ON "task_late_details"("userId");
ALTER TABLE "task_late_details" ADD CONSTRAINT "task_late_details_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_late_details" ADD CONSTRAINT "task_late_details_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "daily_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_late_details" ADD CONSTRAINT "task_late_details_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "task_late_policies" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "allowedDays" INTEGER NOT NULL DEFAULT 3,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "task_late_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_late_policies_allowedDays_check" CHECK ("allowedDays" >= 0 AND "allowedDays" <= 14)
);
CREATE UNIQUE INDEX "task_late_policies_platformId_key" ON "task_late_policies"("platformId");
ALTER TABLE "task_late_policies" ADD CONSTRAINT "task_late_policies_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_late_policies" ADD CONSTRAINT "task_late_policies_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
