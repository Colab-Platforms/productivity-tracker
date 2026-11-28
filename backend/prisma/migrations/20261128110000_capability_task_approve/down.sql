DELETE FROM "user_capabilities" WHERE "capability" = 'TASK_APPROVE_COMPANY';
ALTER TABLE "user_capabilities" DROP CONSTRAINT IF EXISTS "user_capabilities_capability_check";
ALTER TABLE "user_capabilities" ADD CONSTRAINT "user_capabilities_capability_check" CHECK ("capability" IN ('TASK_ASSIGN_COMPANY'));
