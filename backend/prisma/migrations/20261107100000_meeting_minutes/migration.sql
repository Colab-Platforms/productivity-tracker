-- Meeting minutes (MOM): NEW tables only. No existing table or row is touched.
CREATE TABLE "meeting_minutes" (
    "id" UUID NOT NULL,
    "meetingId" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT NOT NULL DEFAULT '',
    "decisions" JSONB NOT NULL DEFAULT '[]',
    "actionItems" JSONB NOT NULL DEFAULT '[]',
    "attendees" JSONB NOT NULL DEFAULT '[]',
    "attendeeBasis" TEXT NOT NULL DEFAULT 'INVITED',
    "transcript" TEXT,
    "language" TEXT,
    "aiModel" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "publishedById" UUID,
    "createdById" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "meeting_minutes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "meeting_minutes_status_check" CHECK ("status" IN ('DRAFT', 'PUBLISHED'))
);
CREATE UNIQUE INDEX "meeting_minutes_meetingId_key" ON "meeting_minutes"("meetingId");
CREATE INDEX "meeting_minutes_platformId_idx" ON "meeting_minutes"("platformId");
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "meeting_minutes_versions" (
    "id" UUID NOT NULL,
    "minutesId" UUID NOT NULL,
    "meetingId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "decisions" JSONB NOT NULL,
    "actionItems" JSONB NOT NULL,
    "attendees" JSONB NOT NULL,
    "attendeeBasis" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "publishedById" UUID NOT NULL,
    CONSTRAINT "meeting_minutes_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "meeting_minutes_versions_minutesId_version_key" ON "meeting_minutes_versions"("minutesId", "version");
ALTER TABLE "meeting_minutes_versions" ADD CONSTRAINT "meeting_minutes_versions_minutesId_fkey" FOREIGN KEY ("minutesId") REFERENCES "meeting_minutes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Earlier versions are history: rows may be added, never changed (a deleted meeting still cascades).
CREATE OR REPLACE FUNCTION meeting_minutes_versions_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'meeting_minutes_versions rows cannot be changed';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER meeting_minutes_versions_no_update BEFORE UPDATE ON "meeting_minutes_versions" FOR EACH ROW EXECUTE FUNCTION meeting_minutes_versions_guard();
