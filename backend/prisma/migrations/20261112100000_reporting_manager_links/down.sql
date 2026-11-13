-- Undo: removes the additional-manager links only. Main reporting managers (users.reportsToId) and everyone's data are untouched.
DROP TABLE IF EXISTS "reporting_manager_links";
