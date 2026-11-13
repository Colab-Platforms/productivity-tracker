-- Additional reporting managers: a NEW table only. No existing table or row is touched; with no rows everything behaves exactly as before.
CREATE TABLE "reporting_manager_links" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "managerId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reporting_manager_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reporting_manager_links_not_self" CHECK ("userId" <> "managerId")
);
CREATE UNIQUE INDEX "reporting_manager_links_userId_managerId_key" ON "reporting_manager_links"("userId", "managerId");
CREATE INDEX "reporting_manager_links_managerId_idx" ON "reporting_manager_links"("managerId");
ALTER TABLE "reporting_manager_links" ADD CONSTRAINT "reporting_manager_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reporting_manager_links" ADD CONSTRAINT "reporting_manager_links_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reporting_manager_links" ADD CONSTRAINT "reporting_manager_links_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
