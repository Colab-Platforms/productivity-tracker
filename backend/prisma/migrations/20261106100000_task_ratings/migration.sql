-- Task ratings: NEW table only. No existing table or row is touched (daily_tasks.outcome is left exactly as it is).
CREATE TABLE "task_ratings" (
    "taskId" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "ratedById" UUID,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "ratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "task_ratings_pkey" PRIMARY KEY ("taskId"),
    CONSTRAINT "task_ratings_rating_check" CHECK ("rating" BETWEEN 1 AND 5)
);
CREATE INDEX "task_ratings_platformId_ratedAt_idx" ON "task_ratings"("platformId", "ratedAt");
ALTER TABLE "task_ratings" ADD CONSTRAINT "task_ratings_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "daily_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_ratings" ADD CONSTRAINT "task_ratings_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_ratings" ADD CONSTRAINT "task_ratings_ratedById_fkey" FOREIGN KEY ("ratedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
