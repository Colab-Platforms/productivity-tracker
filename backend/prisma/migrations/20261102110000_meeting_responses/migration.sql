-- Meeting invitation responses (Accept / Decline): a NEW table only. No existing table or row is touched.
-- Invitations made before this migration simply have no answer yet ("Invited").
CREATE TABLE "meeting_responses" (
    "id" UUID NOT NULL,
    "meetingId" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "response" TEXT NOT NULL,
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "meeting_responses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "meeting_responses_response_check" CHECK ("response" IN ('ACCEPTED', 'DECLINED'))
);
CREATE UNIQUE INDEX "meeting_responses_meetingId_userId_key" ON "meeting_responses"("meetingId", "userId");
CREATE INDEX "meeting_responses_userId_idx" ON "meeting_responses"("userId");
ALTER TABLE "meeting_responses" ADD CONSTRAINT "meeting_responses_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_responses" ADD CONSTRAINT "meeting_responses_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_responses" ADD CONSTRAINT "meeting_responses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
