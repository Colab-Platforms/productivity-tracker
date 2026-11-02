-- Manager step for leave and attendance-correction requests: a NEW table only. No existing table or row is touched.
-- A request without a row here has no manager step (it goes straight to HR, as before).
CREATE TABLE "request_approvals" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approverIds" UUID[] NOT NULL,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "request_approvals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "request_approvals_kind_check" CHECK ("kind" IN ('LEAVE', 'CORRECTION')),
    CONSTRAINT "request_approvals_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'SKIPPED'))
);
CREATE UNIQUE INDEX "request_approvals_kind_requestId_key" ON "request_approvals"("kind", "requestId");
CREATE INDEX "request_approvals_platformId_kind_status_idx" ON "request_approvals"("platformId", "kind", "status");
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
