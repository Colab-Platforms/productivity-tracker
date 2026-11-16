-- Early Logout Policy (2nd and 4th Saturday): NEW TABLE ONLY. No existing table, column or row is touched.
-- One organisation-wide row (id 'global'). No row = the policy is off. Until this is applied the policy is off and nothing changes.
CREATE TABLE "early_logout_policy" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "logoutTime" TEXT NOT NULL DEFAULT '16:00',
    "startDate" DATE,
    "targetHours" DOUBLE PRECISION,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "early_logout_policy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "early_logout_policy_single_row" CHECK ("id" = 'global'),
    CONSTRAINT "early_logout_policy_target_check" CHECK ("targetHours" IS NULL OR ("targetHours" >= 1 AND "targetHours" <= 12)),
    CONSTRAINT "early_logout_policy_time_check" CHECK ("logoutTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);
ALTER TABLE "early_logout_policy" ADD CONSTRAINT "early_logout_policy_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
