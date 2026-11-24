-- AUTOMATIC TASK TIMER. Time is tracked from the task's STATUS, never from a Start button:
--   status becomes In Progress           -> a work session opens (server clock)
--   status leaves In Progress            -> the open session closes (To Do, Completed, Cancelled; "Blocked" is In Progress + the blocked flag)
--   status returns to In Progress        -> a NEW session opens; earlier sessions are kept, so the total carries on and nothing resets
-- NEW TABLE + TRIGGERS ONLY: no column is added to any existing table. The triggers run inside the SAME statement that changes the status, so the
-- status and the timer can never disagree, whichever screen, API route or script made the change, and every timestamp is the database clock.
-- Sessions are never edited or deleted by the application. Break and clock-out time is NOT removed here: it is subtracted when the time is read
-- (backend tasks.timer.ts), so attendance and break records and their calculations are untouched.
-- Tasks that were already In Progress before this migration have no session and read "Not tracked" until their next status change (nothing is invented).
-- Timestamps are UTC without time zone, like every other timestamp in this database.

CREATE TABLE "task_work_sessions" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "taskId"     UUID NOT NULL,
  "userId"     UUID NOT NULL,
  "platformId" UUID NOT NULL,
  "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
  "endedAt"    TIMESTAMP(3),
  "endReason"  TEXT,
  CONSTRAINT "task_work_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_work_sessions_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "daily_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_work_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_work_sessions_order_check" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt")
);
-- at most ONE open session per task: a duplicate timer is impossible even if two requests race
CREATE UNIQUE INDEX "task_work_sessions_one_open_per_task" ON "task_work_sessions"("taskId") WHERE "endedAt" IS NULL;
CREATE INDEX "task_work_sessions_taskId_idx" ON "task_work_sessions"("taskId", "startedAt");
CREATE INDEX "task_work_sessions_userId_startedAt_idx" ON "task_work_sessions"("userId", "startedAt");

CREATE FUNCTION task_timer_open(p_task UUID, p_user UUID, p_platform UUID) RETURNS void AS $$
BEGIN
  INSERT INTO "task_work_sessions" ("taskId", "userId", "platformId", "startedAt")
  SELECT p_task, p_user, p_platform, (now() AT TIME ZONE 'utc')
  WHERE NOT EXISTS (SELECT 1 FROM "task_work_sessions" WHERE "taskId" = p_task AND "endedAt" IS NULL)
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION task_timer_close(p_task UUID, p_reason TEXT) RETURNS void AS $$
BEGIN
  UPDATE "task_work_sessions"
     SET "endedAt" = GREATEST((now() AT TIME ZONE 'utc'), "startedAt"), "endReason" = p_reason
   WHERE "taskId" = p_task AND "endedAt" IS NULL;
END;
$$ LANGUAGE plpgsql;

-- A task row is created or its status changes.
CREATE FUNCTION trg_task_timer_status() RETURNS trigger AS $$
DECLARE
  today DATE;
  is_blocked BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Created already In Progress (the employee declares work under way right now). A task entered for an EARLIER day (a late submission)
    -- is not work happening now: it is never timed from its creation.
    IF NEW."status"::text = 'IN_PROGRESS' THEN
      SELECT (now() AT TIME ZONE p."timezone")::date INTO today FROM "platforms" p WHERE p."id" = NEW."platformId";
      IF NEW."date" >= COALESCE(today, NEW."date") THEN
        PERFORM task_timer_open(NEW."id", NEW."userId", NEW."platformId");
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    PERFORM task_timer_close(NEW."id", CASE NEW."status"::text WHEN 'COMPLETED' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'STATUS' END);
    IF NEW."status"::text = 'IN_PROGRESS' THEN
      -- "Blocked" is In Progress with the blocked flag: it does not run
      SELECT COALESCE(d."blocked", FALSE) INTO is_blocked FROM "task_entry_details" d WHERE d."taskId" = NEW."id";
      IF NOT COALESCE(is_blocked, FALSE) THEN
        PERFORM task_timer_open(NEW."id", NEW."userId", NEW."platformId");
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "daily_tasks_timer_insert" AFTER INSERT ON "daily_tasks" FOR EACH ROW EXECUTE FUNCTION trg_task_timer_status();
CREATE TRIGGER "daily_tasks_timer_status" AFTER UPDATE OF "status" ON "daily_tasks" FOR EACH ROW WHEN (NEW."status" IS DISTINCT FROM OLD."status") EXECUTE FUNCTION trg_task_timer_status();

-- The blocked flag (a submitted task's "Blocked" progress) changes: blocking pauses, unblocking resumes (only while the task is In Progress).
CREATE FUNCTION trg_task_timer_blocked() RETURNS trigger AS $$
DECLARE
  t RECORD;
BEGIN
  IF NEW."blocked" IS TRUE THEN
    PERFORM task_timer_close(NEW."taskId", 'BLOCKED');
  ELSIF TG_OP = 'UPDATE' AND OLD."blocked" IS TRUE AND NEW."blocked" IS FALSE THEN
    SELECT "id", "userId", "platformId", "status" INTO t FROM "daily_tasks" WHERE "id" = NEW."taskId";
    IF FOUND AND t."status"::text = 'IN_PROGRESS' THEN
      PERFORM task_timer_open(t."id", t."userId", t."platformId");
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_entry_details_timer_insert" AFTER INSERT ON "task_entry_details" FOR EACH ROW WHEN (NEW."blocked" IS TRUE) EXECUTE FUNCTION trg_task_timer_blocked();
CREATE TRIGGER "task_entry_details_timer_update" AFTER UPDATE OF "blocked" ON "task_entry_details" FOR EACH ROW WHEN (NEW."blocked" IS DISTINCT FROM OLD."blocked") EXECUTE FUNCTION trg_task_timer_blocked();

-- A deleted task (a soft delete row) stops timing.
DO $$
BEGIN
  IF to_regclass('task_deletions') IS NOT NULL THEN
    EXECUTE 'CREATE FUNCTION trg_task_timer_deleted() RETURNS trigger AS $f$ BEGIN PERFORM task_timer_close(NEW."taskId", ''DELETED''); RETURN NEW; END; $f$ LANGUAGE plpgsql';
    EXECUTE 'CREATE TRIGGER "task_deletions_timer" AFTER INSERT ON "task_deletions" FOR EACH ROW EXECUTE FUNCTION trg_task_timer_deleted()';
  END IF;
END $$;
