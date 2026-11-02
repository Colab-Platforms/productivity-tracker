-- Employee profile photos: a NEW table only. No existing table or row is touched; everyone keeps showing initials until a photo is uploaded.
CREATE TABLE "user_photos" (
    "userId" UUID NOT NULL,
    "platformId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_photos_pkey" PRIMARY KEY ("userId")
);
CREATE INDEX "user_photos_platformId_idx" ON "user_photos"("platformId");
ALTER TABLE "user_photos" ADD CONSTRAINT "user_photos_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_photos" ADD CONSTRAINT "user_photos_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_photos" ADD CONSTRAINT "user_photos_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
