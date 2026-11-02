-- Extra managers per team. Team.managerId stays the primary manager; each row here is a co-manager with the same authority.
-- New table only (additive). Apply after a backup; hand-written because the database has drifted from the migration files.
CREATE TABLE "team_managers" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "team_managers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "team_managers_teamId_userId_key" ON "team_managers"("teamId", "userId");
CREATE INDEX "team_managers_userId_idx" ON "team_managers"("userId");
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_managers" ADD CONSTRAINT "team_managers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
