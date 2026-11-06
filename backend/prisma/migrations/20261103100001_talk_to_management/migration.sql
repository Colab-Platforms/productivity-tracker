-- Talk to Management: NEW tables only. No existing table or row is touched.
-- A private conversation between one person and the ONE Admin they choose. Nobody else can read it (enforced in the API).
CREATE TABLE "management_threads" (
    "id" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "senderId" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "management_threads_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "management_threads_status_check" CHECK ("status" IN ('OPEN', 'REPLIED', 'CLOSED')),
    CONSTRAINT "management_threads_not_self_check" CHECK ("senderId" <> "adminId")
);
CREATE INDEX "management_threads_senderId_updatedAt_idx" ON "management_threads"("senderId", "updatedAt");
CREATE INDEX "management_threads_adminId_updatedAt_idx" ON "management_threads"("adminId", "updatedAt");
ALTER TABLE "management_threads" ADD CONSTRAINT "management_threads_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "management_threads" ADD CONSTRAINT "management_threads_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "management_threads" ADD CONSTRAINT "management_threads_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "management_messages" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "attachmentKey" TEXT,
    "attachmentName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "management_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "management_messages_threadId_createdAt_idx" ON "management_messages"("threadId", "createdAt");
ALTER TABLE "management_messages" ADD CONSTRAINT "management_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "management_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "management_messages" ADD CONSTRAINT "management_messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
