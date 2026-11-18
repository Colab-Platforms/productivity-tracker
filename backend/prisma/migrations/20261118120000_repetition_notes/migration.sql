-- Repetitive task flags, part 2: employee explanations, reviewer notes with a "who can read this" level, and the escalation to Admin.
-- NEW TABLE ONLY. No column is added to the flag tables that are already live, so code deployed before this migration keeps working
-- (employee explanations, HR observations and escalation to Admin answer "not switched on yet" until it is applied).
CREATE TABLE "repetition_flag_notes" (
    "id" UUID NOT NULL,
    "flagId" UUID NOT NULL,
    "authorId" UUID,
    "authorRole" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repetition_flag_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repetition_flag_notes_kind_check" CHECK ("kind" IN ('EXPLANATION', 'MANAGER_COMMENT', 'HR_OBSERVATION', 'ADMIN_NOTE', 'ESCALATION_ADMIN')),
    -- EMPLOYEE = everyone who can see the flag (the employee's own explanation); STAFF = manager, HR and Admin; HR_ADMIN = HR and Admin only
    CONSTRAINT "repetition_flag_notes_visibility_check" CHECK ("visibility" IN ('EMPLOYEE', 'STAFF', 'HR_ADMIN')),
    CONSTRAINT "repetition_flag_notes_body_check" CHECK (char_length("body") BETWEEN 1 AND 1000)
);
CREATE INDEX "repetition_flag_notes_flagId_createdAt_idx" ON "repetition_flag_notes"("flagId", "createdAt");
ALTER TABLE "repetition_flag_notes" ADD CONSTRAINT "repetition_flag_notes_flagId_fkey" FOREIGN KEY ("flagId") REFERENCES "repetition_flags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repetition_flag_notes" ADD CONSTRAINT "repetition_flag_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Only one escalation to Admin per flag.
CREATE UNIQUE INDEX "repetition_flag_notes_one_admin_escalation" ON "repetition_flag_notes"("flagId") WHERE "kind" = 'ESCALATION_ADMIN';
-- Notes only ever grow (the foreign key clearing a deleted author, and the cascade from the flag, are still allowed).
CREATE OR REPLACE FUNCTION repetition_flag_notes_no_edit() RETURNS trigger AS $$
BEGIN
  IF NEW."authorId" IS NULL AND OLD."authorId" IS NOT NULL AND NEW."flagId" = OLD."flagId" AND NEW."body" = OLD."body" AND NEW."kind" = OLD."kind" AND NEW."visibility" = OLD."visibility" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'review notes cannot be changed';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER repetition_flag_notes_no_update BEFORE UPDATE ON "repetition_flag_notes" FOR EACH ROW EXECUTE FUNCTION repetition_flag_notes_no_edit();
