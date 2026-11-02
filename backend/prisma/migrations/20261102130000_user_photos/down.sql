-- Undo: removes the photo links only (everyone shows initials again). Employees and documents are untouched; the stored image files stay in stored_blobs.
DROP TABLE IF EXISTS "user_photos";
