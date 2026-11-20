-- Rollback: held requests go back to PENDING and HELD history rows are removed is NOT done here (history rows are immutable); instead only the
-- constraint is restored AFTER no HELD rows remain. A Postgres enum value cannot be dropped, so ON_HOLD stays in the list (harmless when unused).
-- Run first:  UPDATE "leave_requests" SET "status" = 'PENDING' WHERE "status" = 'ON_HOLD';
ALTER TABLE "leave_approval_events" DROP CONSTRAINT IF EXISTS "leave_approval_events_action_check";
ALTER TABLE "leave_approval_events" ADD CONSTRAINT "leave_approval_events_action_check"
  CHECK ("action" IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'AUTO_APPROVED'));
