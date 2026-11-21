-- Employment status: two new values, TERMINATED and ABSCONDED (EXITED, ACTIVE stay). NO table, NO column, NO data change.
-- CANDIDATE, INVITED and SUSPENDED stay in the list as LEGACY values so no existing record is invalidated.
-- Until this is applied the app keeps working with the old list (see src/lib/userStatus.ts statusReady()).
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'TERMINATED';
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'ABSCONDED';
