-- Undo: removes the query categories and history only. Tickets, messages and attachments are untouched (they simply show their older categories).
DROP TABLE IF EXISTS "query_events";
DROP FUNCTION IF EXISTS query_events_no_edit();
DROP TABLE IF EXISTS "query_meta";
