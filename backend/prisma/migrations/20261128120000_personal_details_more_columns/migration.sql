-- Adds the columns that were added to employee_personal_details AFTER its first version was applied (phone code, department, extra fields 1-5, notes).
-- IF NOT EXISTS: safe whether or not the table already has them. Additive only; no row is touched.
ALTER TABLE "employee_personal_details" ADD COLUMN IF NOT EXISTS "phoneCode" TEXT;
ALTER TABLE "employee_personal_details" ADD COLUMN IF NOT EXISTS "department" TEXT;
ALTER TABLE "employee_personal_details" ADD COLUMN IF NOT EXISTS "extraField1" TEXT;
ALTER TABLE "employee_personal_details" ADD COLUMN IF NOT EXISTS "extraField2" TEXT;
ALTER TABLE "employee_personal_details" ADD COLUMN IF NOT EXISTS "extraField3" TEXT;
ALTER TABLE "employee_personal_details" ADD COLUMN IF NOT EXISTS "extraField4" TEXT;
ALTER TABLE "employee_personal_details" ADD COLUMN IF NOT EXISTS "extraField5" TEXT;
ALTER TABLE "employee_personal_details" ADD COLUMN IF NOT EXISTS "notes" TEXT;
