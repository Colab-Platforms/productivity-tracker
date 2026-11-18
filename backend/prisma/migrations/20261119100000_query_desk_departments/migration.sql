-- Query Desk department requests. NEW TABLES ONLY: nothing is added to tickets, query_meta or any table that is already live,
-- so code deployed before this migration keeps working (department requests answer "not switched on yet").
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "departments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "departments_name_check" CHECK (char_length(btrim("name")) BETWEEN 2 AND 80)
);
CREATE INDEX "departments_platformId_idx" ON "departments"("platformId");
CREATE UNIQUE INDEX "departments_platform_name_ci" ON "departments"("platformId", lower("name"));
ALTER TABLE "departments" ADD CONSTRAINT "departments_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "department_members" (
    "id" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "department_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "department_members_departmentId_userId_key" ON "department_members"("departmentId", "userId");
CREATE INDEX "department_members_userId_idx" ON "department_members"("userId");
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE SEQUENCE "dept_request_ref_seq" START 1;

CREATE TABLE "dept_requests" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "raisedById" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "departmentId" UUID NOT NULL,
    "approvalStatus" TEXT NOT NULL,
    "managerId" UUID,
    "adminApproverIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "managerDecidedAt" TIMESTAMP(3),
    "adminDecidedAt" TIMESTAMP(3),
    "workStatus" TEXT,
    "assigneeId" UUID,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dept_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dept_requests_priority_check" CHECK ("priority" IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
    CONSTRAINT "dept_requests_approval_check" CHECK ("approvalStatus" IN ('PENDING_MANAGER', 'PENDING_ADMIN', 'APPROVED', 'REJECTED')),
    CONSTRAINT "dept_requests_work_check" CHECK ("workStatus" IS NULL OR "workStatus" IN ('AWAITING_ACTION', 'NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'REOPENED')),
    -- department work can exist only after the final approval
    CONSTRAINT "dept_requests_work_after_approval" CHECK ("workStatus" IS NULL OR "approvalStatus" = 'APPROVED')
);
CREATE UNIQUE INDEX "dept_requests_reference_key" ON "dept_requests"("reference");
CREATE INDEX "dept_requests_platformId_approvalStatus_idx" ON "dept_requests"("platformId", "approvalStatus");
CREATE INDEX "dept_requests_departmentId_workStatus_idx" ON "dept_requests"("departmentId", "workStatus");
CREATE INDEX "dept_requests_raisedById_idx" ON "dept_requests"("raisedById");
CREATE INDEX "dept_requests_managerId_idx" ON "dept_requests"("managerId");
ALTER TABLE "dept_requests" ADD CONSTRAINT "dept_requests_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dept_requests" ADD CONSTRAINT "dept_requests_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dept_requests" ADD CONSTRAINT "dept_requests_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "dept_request_events" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "actorId" UUID,
    "kind" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'ALL',
    "attachmentKey" TEXT,
    "attachmentName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dept_request_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dept_request_events_visibility_check" CHECK ("visibility" IN ('ALL', 'APPROVERS', 'DEPT'))
);
CREATE INDEX "dept_request_events_requestId_createdAt_idx" ON "dept_request_events"("requestId", "createdAt");
ALTER TABLE "dept_request_events" ADD CONSTRAINT "dept_request_events_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "dept_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dept_request_events" ADD CONSTRAINT "dept_request_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- History only grows. Clearing the actor when a user is deleted (foreign key) and the cascade from the request are still allowed.
CREATE OR REPLACE FUNCTION dept_request_events_no_edit() RETURNS trigger AS $$
BEGIN
  IF NEW."actorId" IS NULL AND OLD."actorId" IS NOT NULL AND NEW."requestId" = OLD."requestId" AND NEW."kind" = OLD."kind" AND NEW."note" IS NOT DISTINCT FROM OLD."note" AND NEW."visibility" = OLD."visibility" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'query history cannot be changed';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER dept_request_events_no_update BEFORE UPDATE ON "dept_request_events" FOR EACH ROW EXECUTE FUNCTION dept_request_events_no_edit();
