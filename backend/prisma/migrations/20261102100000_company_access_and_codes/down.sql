-- Undo: removes the new tables and indexes only. No employee, company or team row is touched.
DROP INDEX IF EXISTS "teams_platform_name_ci_key";
DROP INDEX IF EXISTS "platforms_prefix_ci_key";
DROP INDEX IF EXISTS "platforms_name_ci_key";
DROP TABLE IF EXISTS "designations";
DROP TABLE IF EXISTS "employee_code_sequences";
DROP TABLE IF EXISTS "company_access";
