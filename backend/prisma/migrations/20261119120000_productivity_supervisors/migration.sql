-- Productivity Supervisor: a person who stays an ordinary EMPLOYEE for every personal feature and additionally gets READ-ONLY organisation-wide
-- monitoring. NEW TABLE ONLY: nothing is added to users or to the role list. Rows are written only by backend/scripts/provision-supervisors.cjs
-- (no API route creates one), so the role cannot be handed out from the app.
CREATE TABLE "productivity_supervisors" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId"      UUID NOT NULL,
  "note"        TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "productivity_supervisors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "productivity_supervisors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "productivity_supervisors_userId_key" ON "productivity_supervisors"("userId");
