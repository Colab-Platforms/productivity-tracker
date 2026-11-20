-- Leave "Hold": an approver can pause a request (with a reason) without approving or rejecting it. NO new table, NO column, NO data change.
--   1. a new status value ON_HOLD on the leave request status list;
--   2. the approval-history table also accepts the action HELD (who held it, when and why are the history row itself).
-- Until this is applied the app answers "not ready" when someone presses Hold and everything else works as before.
ALTER TYPE "LeaveRequestStatus" ADD VALUE IF NOT EXISTS 'ON_HOLD';

ALTER TABLE "leave_approval_events" DROP CONSTRAINT IF EXISTS "leave_approval_events_action_check";
ALTER TABLE "leave_approval_events" ADD CONSTRAINT "leave_approval_events_action_check"
  CHECK ("action" IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'AUTO_APPROVED', 'HELD'));
