-- Organization hierarchy + approval workflows: NEW TABLES ONLY. No existing table, column or row is touched.
-- Before this is applied every function that reads these tables does nothing, and leave/tasks behave exactly as they do today.

-- 1. Projects chosen on a leave request (a "project" is a Team). One row per request + project.
CREATE TABLE "leave_request_projects" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "leave_request_projects_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "leave_request_projects_requestId_teamId_key" ON "leave_request_projects"("requestId", "teamId");
CREATE INDEX "leave_request_projects_requestId_idx" ON "leave_request_projects"("requestId");
ALTER TABLE "leave_request_projects" ADD CONSTRAINT "leave_request_projects_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_request_projects" ADD CONSTRAINT "leave_request_projects_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_request_projects" ADD CONSTRAINT "leave_request_projects_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Approval history of a leave request: every submit / approve / reject / cancel, who did it, in what role, when and why. Rows are only added.
CREATE TABLE "leave_approval_events" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "actorId" UUID,
    "actorName" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "leave_approval_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "leave_approval_events_step_check" CHECK ("step" IN ('REQUEST', 'MANAGER', 'ADMIN', 'HR')),
    CONSTRAINT "leave_approval_events_action_check" CHECK ("action" IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'AUTO_APPROVED'))
);
CREATE INDEX "leave_approval_events_requestId_createdAt_idx" ON "leave_approval_events"("requestId", "createdAt");
ALTER TABLE "leave_approval_events" ADD CONSTRAINT "leave_approval_events_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_approval_events" ADD CONSTRAINT "leave_approval_events_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leave_approval_events" ADD CONSTRAINT "leave_approval_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION leave_approval_events_no_edit() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."actorId" IS NULL AND OLD."actorId" IS NOT NULL
     AND NEW."id" = OLD."id" AND NEW."requestId" = OLD."requestId" AND NEW."actorName" = OLD."actorName" AND NEW."actorRole" = OLD."actorRole"
     AND NEW."step" = OLD."step" AND NEW."action" = OLD."action" AND NEW."comment" IS NOT DISTINCT FROM OLD."comment" AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW; -- only the foreign-key clearing of a deleted user is allowed
  END IF;
  RAISE EXCEPTION 'leave_approval_events rows cannot be changed';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER leave_approval_events_no_update BEFORE UPDATE ON "leave_approval_events" FOR EACH ROW EXECUTE FUNCTION leave_approval_events_no_edit();

-- 3. Extra facts about a daily task entry: hours spent, the tagged reporting manager, "Blocked" (progress itself stays in daily_tasks.status),
--    and the manager's optional comment when approving. One row per task; a task without a row behaves exactly as before.
CREATE TABLE "task_entry_details" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "hoursSpent" DOUBLE PRECISION,
    "taggedManagerId" UUID,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "blockedNote" TEXT,
    "approvalNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "task_entry_details_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "task_entry_details_hours_check" CHECK ("hoursSpent" IS NULL OR ("hoursSpent" >= 0 AND "hoursSpent" <= 24))
);
CREATE UNIQUE INDEX "task_entry_details_taskId_key" ON "task_entry_details"("taskId");
CREATE INDEX "task_entry_details_taggedManagerId_idx" ON "task_entry_details"("taggedManagerId");
ALTER TABLE "task_entry_details" ADD CONSTRAINT "task_entry_details_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_entry_details" ADD CONSTRAINT "task_entry_details_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "daily_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_entry_details" ADD CONSTRAINT "task_entry_details_taggedManagerId_fkey" FOREIGN KEY ("taggedManagerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
