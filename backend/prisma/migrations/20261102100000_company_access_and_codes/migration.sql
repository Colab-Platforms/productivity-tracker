-- HR & Company Management (Phase 1): NEW tables plus three case-insensitive unique INDEXES. No column is added to an existing table
-- and no existing row is changed. If an index cannot be created because two names already differ only by upper/lower case, the whole
-- migration stops and nothing is applied (check first with the query in the comment at the end).

CREATE TABLE "company_access" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platformId" UUID,
    "grantedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "company_access_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "company_access_userId_platformId_key" ON "company_access"("userId", "platformId");
-- NULLs are distinct in a unique index, so "all companies" gets its own: at most one such row per person.
CREATE UNIQUE INDEX "company_access_all_companies_key" ON "company_access"("userId") WHERE "platformId" IS NULL;
CREATE INDEX "company_access_userId_idx" ON "company_access"("userId");
ALTER TABLE "company_access" ADD CONSTRAINT "company_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_access" ADD CONSTRAINT "company_access_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "company_access" ADD CONSTRAINT "company_access_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "employee_code_sequences" (
    "platformId" UUID NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "padWidth" INTEGER NOT NULL DEFAULT 4,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "employee_code_sequences_pkey" PRIMARY KEY ("platformId"),
    CONSTRAINT "employee_code_sequences_next_check" CHECK ("nextNumber" >= 1),
    CONSTRAINT "employee_code_sequences_pad_check" CHECK ("padWidth" BETWEEN 1 AND 8)
);
ALTER TABLE "employee_code_sequences" ADD CONSTRAINT "employee_code_sequences_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "designations" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "designations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "designations_platformId_isActive_idx" ON "designations"("platformId", "isActive");
CREATE UNIQUE INDEX "designations_platform_name_ci_key" ON "designations"("platformId", lower("name"));
ALTER TABLE "designations" ADD CONSTRAINT "designations_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "designations" ADD CONSTRAINT "designations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- No duplicate companies, departments (teams) or prefixes, whatever the upper/lower case.
CREATE UNIQUE INDEX "platforms_name_ci_key" ON "platforms"(lower("name"));
CREATE UNIQUE INDEX "platforms_prefix_ci_key" ON "platforms"(lower("employeeCodePrefix")) WHERE "employeeCodePrefix" IS NOT NULL;
CREATE UNIQUE INDEX "teams_platform_name_ci_key" ON "teams"("platformId", lower("name"));

-- Check BEFORE applying (each must return no rows):
--   SELECT lower(name), count(*) FROM platforms GROUP BY 1 HAVING count(*) > 1;
--   SELECT lower("employeeCodePrefix"), count(*) FROM platforms WHERE "employeeCodePrefix" IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--   SELECT "platformId", lower(name), count(*) FROM teams GROUP BY 1, 2 HAVING count(*) > 1;
