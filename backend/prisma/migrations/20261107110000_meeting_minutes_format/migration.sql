-- Proper MOM layout: agenda, discussion by topic, next meeting. Columns are added ONLY to the two new minutes tables (nothing existing is touched).
ALTER TABLE "meeting_minutes" ADD COLUMN "agenda" JSONB NOT NULL DEFAULT '[]', ADD COLUMN "discussion" JSONB NOT NULL DEFAULT '[]', ADD COLUMN "nextMeeting" TEXT;
ALTER TABLE "meeting_minutes_versions" ADD COLUMN "agenda" JSONB NOT NULL DEFAULT '[]', ADD COLUMN "discussion" JSONB NOT NULL DEFAULT '[]', ADD COLUMN "nextMeeting" TEXT;

