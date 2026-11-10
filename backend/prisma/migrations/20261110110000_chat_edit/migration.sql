-- Chat: a message can be edited by its sender (shown as "edited"). One new nullable column on a table created for chat; no existing data changes.
ALTER TABLE "chat_messages" ADD COLUMN "editedAt" TIMESTAMP(3);
