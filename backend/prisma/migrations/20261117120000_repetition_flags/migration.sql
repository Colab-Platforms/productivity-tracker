-- Repetitive task detection: NEW TABLES ONLY. No existing table, column or row is touched.
-- Until this is applied nothing is detected and every screen behaves exactly as before.
CREATE TABLE "repetition_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minCount" INTEGER NOT NULL DEFAULT 3,
    "windowDays" INTEGER NOT NULL DEFAULT 7,
    "similarityPct" INTEGER NOT NULL DEFAULT 60,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repetition_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repetition_settings_single_row" CHECK ("id" = 'global'),
    CONSTRAINT "repetition_settings_min_check" CHECK ("minCount" BETWEEN 2 AND 20),
    CONSTRAINT "repetition_settings_window_check" CHECK ("windowDays" BETWEEN 1 AND 60),
    CONSTRAINT "repetition_settings_sim_check" CHECK ("similarityPct" BETWEEN 30 AND 100)
);
ALTER TABLE "repetition_settings" ADD CONSTRAINT "repetition_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "repetition_flags" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "teamId" UUID,
    "patternKey" TEXT NOT NULL,
    "sampleTitle" TEXT NOT NULL,
    "repeatCount" INTEGER NOT NULL,
    "firstDate" DATE NOT NULL,
    "lastDate" DATE NOT NULL,
    "similarity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "escalatedAt" TIMESTAMP(3),
    "escalatedById" UUID,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repetition_flags_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repetition_flags_status_check" CHECK ("status" IN ('NEW', 'UNDER_REVIEW', 'VALID', 'FALSE_POSITIVE', 'RESOLVED')),
    CONSTRAINT "repetition_flags_count_check" CHECK ("repeatCount" >= 2)
);
CREATE INDEX "repetition_flags_userId_status_idx" ON "repetition_flags"("userId", "status");
CREATE INDEX "repetition_flags_platformId_status_idx" ON "repetition_flags"("platformId", "status");
-- One live flag per pattern: the same pattern cannot be flagged twice until the first is Resolved.
CREATE UNIQUE INDEX "repetition_flags_one_live_pattern" ON "repetition_flags"("userId", "patternKey") WHERE "status" <> 'RESOLVED';
ALTER TABLE "repetition_flags" ADD CONSTRAINT "repetition_flags_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repetition_flags" ADD CONSTRAINT "repetition_flags_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repetition_flags" ADD CONSTRAINT "repetition_flags_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "repetition_flags" ADD CONSTRAINT "repetition_flags_escalatedById_fkey" FOREIGN KEY ("escalatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "repetition_flag_tasks" (
    "id" UUID NOT NULL,
    "flagId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "taskDate" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL,
    "approvalStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repetition_flag_tasks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "repetition_flag_tasks_flagId_taskId_key" ON "repetition_flag_tasks"("flagId", "taskId");
CREATE INDEX "repetition_flag_tasks_taskId_idx" ON "repetition_flag_tasks"("taskId");
ALTER TABLE "repetition_flag_tasks" ADD CONSTRAINT "repetition_flag_tasks_flagId_fkey" FOREIGN KEY ("flagId") REFERENCES "repetition_flags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repetition_flag_tasks" ADD CONSTRAINT "repetition_flag_tasks_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "daily_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "repetition_flag_events" (
    "id" UUID NOT NULL,
    "flagId" UUID NOT NULL,
    "actorId" UUID,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repetition_flag_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repetition_flag_events_kind_check" CHECK ("kind" IN ('DETECTED', 'UPDATED', 'STATUS', 'COMMENT', 'ESCALATED'))
);
CREATE INDEX "repetition_flag_events_flagId_createdAt_idx" ON "repetition_flag_events"("flagId", "createdAt");
ALTER TABLE "repetition_flag_events" ADD CONSTRAINT "repetition_flag_events_flagId_fkey" FOREIGN KEY ("flagId") REFERENCES "repetition_flags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repetition_flag_events" ADD CONSTRAINT "repetition_flag_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- The review trail only ever grows (a cascade delete of the flag itself, or of a deleted user's link, is still allowed).
CREATE OR REPLACE FUNCTION repetition_flag_events_no_edit() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."actorId" IS NULL AND OLD."actorId" IS NOT NULL
     AND NEW."flagId" = OLD."flagId" AND NEW."kind" = OLD."kind" AND NEW."note" IS NOT DISTINCT FROM OLD."note" THEN
    RETURN NEW; -- only the foreign key clearing a deleted user's id
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; -- cascade from the flag
  RAISE EXCEPTION 'review history rows cannot be changed';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER repetition_flag_events_no_update BEFORE UPDATE ON "repetition_flag_events" FOR EACH ROW EXECUTE FUNCTION repetition_flag_events_no_edit();
