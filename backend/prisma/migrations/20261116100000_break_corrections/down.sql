-- UNDO for 20261116100000_break_corrections. Drops the correction columns and the log; recorded break rows are untouched.
-- Run `UPDATE tracker_breaks SET ...` / recompute is NOT needed for the recorded data, but any day that used a correction will
-- show the original (longer) break again once the columns are gone, until its session is next recomputed.
DROP TRIGGER IF EXISTS break_correction_log_no_change ON "break_correction_log";
DROP FUNCTION IF EXISTS break_correction_log_immutable();
DROP TABLE IF EXISTS "break_correction_log";
ALTER TABLE "tracker_breaks" DROP COLUMN IF EXISTS "correctedDurationSeconds";
ALTER TABLE "tracker_breaks" DROP COLUMN IF EXISTS "correctionReason";
ALTER TABLE "tracker_breaks" DROP COLUMN IF EXISTS "correctedById";
ALTER TABLE "tracker_breaks" DROP COLUMN IF EXISTS "correctedAt";
