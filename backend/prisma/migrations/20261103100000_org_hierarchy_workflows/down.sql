-- Rolls back 20261103100000_org_hierarchy_workflows. Drops only the three tables it created (the history in them is lost).
DROP TABLE IF EXISTS "task_entry_details";
DROP TRIGGER IF EXISTS leave_approval_events_no_update ON "leave_approval_events";
DROP TABLE IF EXISTS "leave_approval_events";
DROP FUNCTION IF EXISTS leave_approval_events_no_edit();
DROP TABLE IF EXISTS "leave_request_projects";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103100000_org_hierarchy_workflows';
