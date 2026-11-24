-- Reverts 20261124100000_user_capabilities (drops the table; nothing else references it).
DROP TABLE IF EXISTS "user_capabilities";
