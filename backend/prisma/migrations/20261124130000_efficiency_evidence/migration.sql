-- Evidence the Work Efficiency Index needs. NEW TABLES ONLY: nothing is added to an existing table, nothing is changed or backfilled.
-- task_review_attempts : one row per time a manager sent a Completed task back, with WHY (quality or the requirement changed).
-- task_partial_progress: the manager-verified progress % (and a milestone note) behind a "partially completed" mark.
-- task_time_reviews    : the time the tagged manager confirmed as reasonable for a completed task (the expected time the timer is compared with).
CREATE TABLE IF NOT EXISTS "task_review_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "taskId" UUID NOT NULL REFERENCES "daily_tasks"("id") ON DELETE CASCADE,
  "platformId" UUID NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('QUALITY', 'REQUIREMENT_CHANGE')),
  "revertType" TEXT NOT NULL,
  "remark" TEXT,
  "byId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_review_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "task_review_attempts_task_idx" ON "task_review_attempts" ("taskId");

CREATE TABLE IF NOT EXISTS "task_partial_progress" (
  "taskId" UUID NOT NULL REFERENCES "daily_tasks"("id") ON DELETE CASCADE,
  "percent" INTEGER NOT NULL CHECK ("percent" BETWEEN 1 AND 99),
  "milestone" TEXT NOT NULL CHECK (char_length(btrim("milestone")) >= 3),
  "verifiedById" UUID,
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_partial_progress_pkey" PRIMARY KEY ("taskId")
);

CREATE TABLE IF NOT EXISTS "task_time_reviews" (
  "taskId" UUID NOT NULL REFERENCES "daily_tasks"("id") ON DELETE CASCADE,
  "expectedSeconds" INTEGER NOT NULL CHECK ("expectedSeconds" > 0 AND "expectedSeconds" <= 86400),
  "note" TEXT,
  "reviewedById" UUID,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_time_reviews_pkey" PRIMARY KEY ("taskId")
);
