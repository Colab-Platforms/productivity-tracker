-- Complaint Centre / Query Desk: NEW tables only. No existing table or row is touched; every ticket, message and attachment stays as it is.
-- A ticket without a query_meta row is an older ticket and keeps its old category.
CREATE TABLE "query_meta" (
    "ticketId" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "categoryKey" TEXT NOT NULL,
    "awaitingInfoSince" TIMESTAMP(3),
    "awaitingInfoById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "query_meta_pkey" PRIMARY KEY ("ticketId"),
    CONSTRAINT "query_meta_category_check" CHECK ("categoryKey" IN ('LEAVE', 'PAYROLL', 'PROFILE_DOCUMENT', 'TECHNICAL', 'GENERAL_HR', 'OTHER'))
);
CREATE INDEX "query_meta_platformId_categoryKey_idx" ON "query_meta"("platformId", "categoryKey");
ALTER TABLE "query_meta" ADD CONSTRAINT "query_meta_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "query_meta" ADD CONSTRAINT "query_meta_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "query_meta" ADD CONSTRAINT "query_meta_awaitingInfoById_fkey" FOREIGN KEY ("awaitingInfoById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "query_events" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "actorId" UUID,
    "kind" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "query_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "query_events_kind_check" CHECK ("kind" IN ('CREATED', 'ASSIGNED', 'STATUS', 'INFO_REQUESTED', 'INFO_RECEIVED'))
);
CREATE INDEX "query_events_ticketId_createdAt_idx" ON "query_events"("ticketId", "createdAt");
ALTER TABLE "query_events" ADD CONSTRAINT "query_events_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "query_events" ADD CONSTRAINT "query_events_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "query_events" ADD CONSTRAINT "query_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The history can be added to but never rewritten by a normal update. (Removing a person only clears the actor link: SET NULL above is
-- the one allowed change, and deleting a ticket removes its history with it.)
CREATE OR REPLACE FUNCTION query_events_no_edit() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."actorId" IS NULL AND OLD."actorId" IS NOT NULL
     AND NEW."ticketId" = OLD."ticketId" AND NEW."kind" = OLD."kind" AND NEW."note" IS NOT DISTINCT FROM OLD."note"
     AND NEW."fromValue" IS NOT DISTINCT FROM OLD."fromValue" AND NEW."toValue" IS NOT DISTINCT FROM OLD."toValue" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'query history rows cannot be changed';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER query_events_no_update BEFORE UPDATE ON "query_events" FOR EACH ROW EXECUTE FUNCTION query_events_no_edit();
