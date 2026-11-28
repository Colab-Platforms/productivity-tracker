-- Employee personal details: a NEW table only. No existing table, column or row is touched; everyone simply has no row until HR/Admin enters their details.
-- Holds what the profile could not store before: gender, date of birth, marital status, secondary contact, address, and a few work labels.
CREATE TABLE "employee_personal_details" (
    "userId" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "gender" TEXT,
    "dateOfBirth" DATE,
    "maritalStatus" TEXT,
    "phoneCode" TEXT,
    "secondaryPhoneCode" TEXT,
    "secondaryPhone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "employeeStatusType" TEXT,
    "reportingOffice" TEXT,
    "grade" TEXT,
    "vertical" TEXT,
    "department" TEXT,
    "extraField1" TEXT,
    "extraField2" TEXT,
    "extraField3" TEXT,
    "extraField4" TEXT,
    "extraField5" TEXT,
    "notes" TEXT,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "employee_personal_details_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "employee_personal_details_gender_chk" CHECK ("gender" IS NULL OR "gender" IN ('MALE', 'FEMALE', 'OTHER')),
    CONSTRAINT "employee_personal_details_marital_chk" CHECK ("maritalStatus" IS NULL OR "maritalStatus" IN ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED')),
    CONSTRAINT "employee_personal_details_status_chk" CHECK ("employeeStatusType" IS NULL OR "employeeStatusType" IN ('FULL_TIME', 'PART_TIME'))
);
CREATE INDEX "employee_personal_details_platformId_idx" ON "employee_personal_details"("platformId");
ALTER TABLE "employee_personal_details" ADD CONSTRAINT "employee_personal_details_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_personal_details" ADD CONSTRAINT "employee_personal_details_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employee_personal_details" ADD CONSTRAINT "employee_personal_details_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
