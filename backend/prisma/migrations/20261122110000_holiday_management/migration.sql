-- Holiday Management. NEW TABLES ONLY: no column is added to "holidays" and no holiday row is changed.
--   Fixed holiday    = a holidays row with dayType PUBLIC_HOLIDAY (already how attendance and reports treat it)
--   Optional holiday = a holidays row with dayType OPTIONAL_HOLIDAY (a normal working day unless an approved request exists)
--   Published        = a row in "holidays" (every existing holiday is already published). Drafts live ONLY in holiday_drafts, so an unpublished
--                      calendar can never reach attendance, reports or leave.
CREATE TABLE "holiday_imports" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "platformId" UUID NOT NULL REFERENCES "platforms"("id") ON DELETE CASCADE,
  "calendarYear" INTEGER NOT NULL,
  "fileName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "importedRows" INTEGER NOT NULL DEFAULT 0,
  "skippedRows" INTEGER NOT NULL DEFAULT 0,
  "failedRows" INTEGER NOT NULL DEFAULT 0,
  "createdById" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  "publishedById" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "holiday_imports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "holiday_imports_status_check" CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'DISCARDED'))
);
CREATE INDEX "holiday_imports_platformId_calendarYear_idx" ON "holiday_imports"("platformId", "calendarYear");

CREATE TABLE "holiday_drafts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "importId" UUID NOT NULL REFERENCES "holiday_imports"("id") ON DELETE CASCADE,
  "platformId" UUID NOT NULL REFERENCES "platforms"("id") ON DELETE CASCADE,
  "date" DATE NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "religion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "holiday_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "holiday_drafts_kind_check" CHECK ("kind" IN ('FIXED', 'OPTIONAL'))
);
CREATE UNIQUE INDEX "holiday_drafts_importId_date_name_key" ON "holiday_drafts"("importId", "date", lower("name"));
CREATE INDEX "holiday_drafts_platformId_date_idx" ON "holiday_drafts"("platformId", "date");

-- Extra facts about a published holiday (the holidays table itself is untouched). No row = an older holiday with no category.
CREATE TABLE "holiday_details" (
  "holidayId" UUID NOT NULL REFERENCES "holidays"("id") ON DELETE CASCADE,
  "religion" TEXT,
  "calendarYear" INTEGER NOT NULL,
  "importId" UUID REFERENCES "holiday_imports"("id") ON DELETE SET NULL,
  "createdById" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "updatedById" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "holiday_details_pkey" PRIMARY KEY ("holidayId")
);

-- A deactivated (archived) holiday: a full copy, kept so it can be restored. It no longer counts anywhere.
CREATE TABLE "holiday_archive" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "platformId" UUID NOT NULL REFERENCES "platforms"("id") ON DELETE CASCADE,
  "date" DATE NOT NULL,
  "name" TEXT NOT NULL,
  "dayType" TEXT NOT NULL,
  "religion" TEXT,
  "calendarYear" INTEGER NOT NULL,
  "archivedById" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "restoredAt" TIMESTAMP(3),
  CONSTRAINT "holiday_archive_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "holiday_archive_platformId_calendarYear_idx" ON "holiday_archive"("platformId", "calendarYear");

CREATE TABLE "holiday_policy" (
  "platformId" UUID NOT NULL REFERENCES "platforms"("id") ON DELETE CASCADE,
  "optionalAllowance" INTEGER NOT NULL DEFAULT 2,
  "updatedById" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "holiday_policy_pkey" PRIMARY KEY ("platformId"),
  CONSTRAINT "holiday_policy_allowance_check" CHECK ("optionalAllowance" BETWEEN 0 AND 30)
);

CREATE TABLE "optional_holiday_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "platformId" UUID NOT NULL REFERENCES "platforms"("id") ON DELETE CASCADE,
  "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "holidayId" UUID NOT NULL REFERENCES "holidays"("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'PENDING_MANAGER',
  "managerId" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "managerNote" TEXT,
  "managerDecidedAt" TIMESTAMP(3),
  "hrNote" TEXT,
  "decidedById" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "optional_holiday_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "optional_holiday_requests_status_check" CHECK ("status" IN ('PENDING_MANAGER', 'PENDING_HR', 'APPROVED', 'REJECTED', 'CANCELLED'))
);
-- one live request per person per holiday
CREATE UNIQUE INDEX "optional_holiday_requests_live_key" ON "optional_holiday_requests"("userId", "holidayId") WHERE "status" IN ('PENDING_MANAGER', 'PENDING_HR', 'APPROVED');
CREATE INDEX "optional_holiday_requests_platformId_status_idx" ON "optional_holiday_requests"("platformId", "status");
