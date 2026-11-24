-- Reverts 20261124120000_task_work_timer: removes the triggers, the functions and the sessions table (task data itself is untouched).
DROP TRIGGER IF EXISTS "task_deletions_timer" ON "task_deletions";
DROP FUNCTION IF EXISTS trg_task_timer_deleted();
DROP TRIGGER IF EXISTS "task_entry_details_timer_update" ON "task_entry_details";
DROP TRIGGER IF EXISTS "task_entry_details_timer_insert" ON "task_entry_details";
DROP FUNCTION IF EXISTS trg_task_timer_blocked();
DROP TRIGGER IF EXISTS "daily_tasks_timer_status" ON "daily_tasks";
DROP TRIGGER IF EXISTS "daily_tasks_timer_insert" ON "daily_tasks";
DROP FUNCTION IF EXISTS trg_task_timer_status();
DROP FUNCTION IF EXISTS task_timer_close(UUID, TEXT);
DROP FUNCTION IF EXISTS task_timer_open(UUID, UUID, UUID);
DROP TABLE IF EXISTS "task_work_sessions";
