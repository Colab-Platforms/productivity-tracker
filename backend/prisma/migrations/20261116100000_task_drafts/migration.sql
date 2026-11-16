-- Quick Add task drafts: NEW TABLE ONLY. No existing table, column or row is touched.
-- A draft is a person's own unsent task row. It is never a task: reports, approval queues, notifications and productivity never read it.
-- Until this is applied the draft endpoints answer "not ready" and Quick Add still submits (drafts are simply unavailable).
CREATE TABLE "task_drafts" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT,
    "teamId" UUID,
    "taggedManagerId" UUID,
    "hoursSpent" DOUBLE PRECISION,
    "weight" TEXT NOT NULL DEFAULT 'MEDIUM',
    "progress" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "task_drafts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_drafts_weight_check" CHECK ("weight" IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    CONSTRAINT "task_drafts_progress_check" CHECK ("progress" IN ('COMPLETED', 'IN_PROGRESS', 'BLOCKED'))
);
CREATE INDEX "task_drafts_userId_sortOrder_idx" ON "task_drafts"("userId", "sortOrder");
ALTER TABLE "task_drafts" ADD CONSTRAINT "task_drafts_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_drafts" ADD CONSTRAINT "task_drafts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A draft keeps pointing at a project / manager only as an id; if either is later removed the draft just loses that choice.
ALTER TABLE "task_drafts" ADD CONSTRAINT "task_drafts_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "task_drafts" ADD CONSTRAINT "task_drafts_taggedManagerId_fkey" FOREIGN KEY ("taggedManagerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
