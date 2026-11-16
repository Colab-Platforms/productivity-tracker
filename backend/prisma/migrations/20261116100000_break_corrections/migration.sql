-- Admin break corrections. Four NULLABLE columns on tracker_breaks (no existing row changes: all stay NULL) and one new append-only log table.
-- The recorded startedAt / endedAt / durationSeconds are never touched by this feature.
ALTER TABLE "tracker_breaks" ADD COLUMN "correctedDurationSeconds" INTEGER;
ALTER TABLE "tracker_breaks" ADD COLUMN "correctionReason" TEXT;
ALTER TABLE "tracker_breaks" ADD COLUMN "correctedById" UUID;
ALTER TABLE "tracker_breaks" ADD COLUMN "correctedAt" TIMESTAMP(3);

CREATE TABLE "break_correction_log" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "breakId" UUID NOT NULL,
    "workSessionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "originalSeconds" INTEGER NOT NULL,
    "beforeSeconds" INTEGER NOT NULL,
    "afterSeconds" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actedById" UUID NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "break_correction_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "break_correction_log_breakId_actedAt_idx" ON "break_correction_log"("breakId", "actedAt");
CREATE INDEX "break_correction_log_userId_actedAt_idx" ON "break_correction_log"("userId", "actedAt");
CREATE INDEX "break_correction_log_platformId_actedAt_idx" ON "break_correction_log"("platformId", "actedAt");

-- The log can be added to but never edited or deleted (same rule as the audit log).
CREATE OR REPLACE FUNCTION break_correction_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'break_correction_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER break_correction_log_no_change
BEFORE UPDATE OR DELETE ON "break_correction_log"
FOR EACH ROW EXECUTE FUNCTION break_correction_log_immutable();
