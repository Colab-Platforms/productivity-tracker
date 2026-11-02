-- Undo: removes the manager-step records only. Requests themselves are untouched (an open one simply goes straight to HR).
DROP TABLE IF EXISTS "request_approvals";
