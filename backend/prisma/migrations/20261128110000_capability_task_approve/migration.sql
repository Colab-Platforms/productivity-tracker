-- Second capability: TASK_APPROVE_COMPANY = an Employee account may be TAGGED as the approving manager of employees' daily tasks and then approve, reject and
-- rate ONLY the tasks tagged to them (never anyone else's). Needs 20261124100000_user_capabilities. Only widens the CHECK on that table: no column, no row.
ALTER TABLE "user_capabilities" DROP CONSTRAINT IF EXISTS "user_capabilities_capability_check";
ALTER TABLE "user_capabilities" ADD CONSTRAINT "user_capabilities_capability_check" CHECK ("capability" IN ('TASK_ASSIGN_COMPANY', 'TASK_APPROVE_COMPANY'));
