-- Office network allow-list for clock-in. A NEW table only: no column is added to any existing table and no
-- existing row is touched. A company with no rows stays unrestricted.
CREATE TABLE "office_ips" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "cidr" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "office_ips_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "office_ips_platformId_cidr_key" ON "office_ips"("platformId", "cidr");

ALTER TABLE "office_ips" ADD CONSTRAINT "office_ips_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
