-- Per-person capabilities (a named extra permission for one account, independent of the person's role).
-- First capability: TASK_ASSIGN_COMPANY = may assign tasks to active employees of their own company through the existing assigned-task workflow.
-- NEW TABLE ONLY: no column is added to any existing table, and the code reads it only after checking that it exists, so the application keeps
-- working (with nobody holding a capability) until this migration is applied. Rows are created by scripts/provision-capabilities.cjs, never by an API.
CREATE TABLE "user_capabilities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "capability" TEXT NOT NULL,
  "grantedById" UUID,
  "note" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "user_capabilities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_capabilities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_capabilities_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "user_capabilities_capability_check" CHECK ("capability" IN ('TASK_ASSIGN_COMPANY'))
);
CREATE UNIQUE INDEX "user_capabilities_userId_capability_key" ON "user_capabilities"("userId", "capability");
