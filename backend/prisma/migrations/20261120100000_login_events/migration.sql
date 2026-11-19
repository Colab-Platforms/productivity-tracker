-- Login activity: one row per authentication attempt (success, failed, blocked by the network rule), with the device and the session's later life
-- (last activity, logout). NEW TABLE ONLY: no existing table or column changes.
-- The audit log cannot hold this because a session's last-activity and logout times are filled in LATER; so the table is protected by a rule instead:
--   * a row can never be edited, except to move its last-activity time forward, to stamp its logout once, or (by the foreign keys) to unlink a deleted person
--   * a row younger than 90 days can never be deleted; older rows can (the server removes them after the retention period, 6 months)
CREATE TABLE "login_events" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "result"         TEXT NOT NULL,
  "reason"         TEXT,
  "wouldBlock"     BOOLEAN NOT NULL DEFAULT false,
  "mode"           TEXT,
  "userId"         UUID,
  "platformId"     UUID,
  "employeeCode"   TEXT,
  "username"       TEXT,
  "ip"             TEXT,
  "country"        TEXT,
  "region"         TEXT,
  "city"           TEXT,
  "locationSource" TEXT,
  "browserName"    TEXT,
  "browserVersion" TEXT,
  "osName"         TEXT,
  "osVersion"      TEXT,
  "deviceType"     TEXT,
  "userAgent"      TEXT,
  "sessionId"      UUID,
  "expiresAt"      TIMESTAMP(3),
  "lastActiveAt"   TIMESTAMP(3),
  "loggedOutAt"    TIMESTAMP(3),
  CONSTRAINT "login_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "login_events_result_check" CHECK ("result" IN ('SUCCESS', 'FAILED', 'BLOCKED'))
);

ALTER TABLE "login_events" ADD CONSTRAINT "login_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "login_events_sessionId_key" ON "login_events"("sessionId");
CREATE INDEX "login_events_userId_createdAt_idx" ON "login_events"("userId", "createdAt" DESC);
CREATE INDEX "login_events_platformId_createdAt_idx" ON "login_events"("platformId", "createdAt" DESC);
CREATE INDEX "login_events_createdAt_idx" ON "login_events"("createdAt" DESC);
CREATE INDEX "login_events_ip_idx" ON "login_events"("ip");

CREATE OR REPLACE FUNCTION login_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."createdAt" < (CURRENT_TIMESTAMP - INTERVAL '90 days') THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'login history younger than 90 days cannot be deleted';
  END IF;

  -- UPDATE: everything that describes the attempt is frozen
  IF (NEW."id", NEW."createdAt", NEW."result", NEW."reason", NEW."wouldBlock", NEW."mode", NEW."employeeCode", NEW."username", NEW."ip",
      NEW."country", NEW."region", NEW."city", NEW."locationSource", NEW."browserName", NEW."browserVersion", NEW."osName", NEW."osVersion",
      NEW."deviceType", NEW."userAgent", NEW."sessionId", NEW."expiresAt")
     IS DISTINCT FROM
     (OLD."id", OLD."createdAt", OLD."result", OLD."reason", OLD."wouldBlock", OLD."mode", OLD."employeeCode", OLD."username", OLD."ip",
      OLD."country", OLD."region", OLD."city", OLD."locationSource", OLD."browserName", OLD."browserVersion", OLD."osName", OLD."osVersion",
      OLD."deviceType", OLD."userAgent", OLD."sessionId", OLD."expiresAt") THEN
    RAISE EXCEPTION 'login history rows cannot be changed';
  END IF;
  -- the only links that may change: cleared when the person or company is deleted
  IF NEW."userId" IS DISTINCT FROM OLD."userId" AND NEW."userId" IS NOT NULL THEN
    RAISE EXCEPTION 'login history rows cannot be re-attributed';
  END IF;
  IF NEW."platformId" IS DISTINCT FROM OLD."platformId" AND NEW."platformId" IS NOT NULL THEN
    RAISE EXCEPTION 'login history rows cannot be re-attributed';
  END IF;
  -- a logout is stamped once and never moved
  IF OLD."loggedOutAt" IS NOT NULL AND NEW."loggedOutAt" IS DISTINCT FROM OLD."loggedOutAt" THEN
    RAISE EXCEPTION 'a logout time cannot be changed';
  END IF;
  -- last activity only moves forward
  IF OLD."lastActiveAt" IS NOT NULL AND (NEW."lastActiveAt" IS NULL OR NEW."lastActiveAt" < OLD."lastActiveAt") THEN
    RAISE EXCEPTION 'last activity cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER login_events_no_edit BEFORE UPDATE ON "login_events" FOR EACH ROW EXECUTE FUNCTION login_events_guard();
CREATE TRIGGER login_events_no_delete BEFORE DELETE ON "login_events" FOR EACH ROW EXECUTE FUNCTION login_events_guard();
