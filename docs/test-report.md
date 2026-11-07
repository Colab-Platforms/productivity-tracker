# Avatar HRMS - Test Report

Living document. Status values: **PASS / FAIL / BLOCKED / NOT RUN**. Severity: Critical / High / Medium / Low.
Last updated: 2026-11-07. Stage: **Phase 1 (audit) complete, plan awaiting review. No code has been modified.**

## 1. Ground rules

- All data-writing tests run ONLY against the throwaway local PostgreSQL (`127.0.0.1:54329/hrms_test`) with an isolated backend on port 5012 and, for browser checks, a copied frontend on port 3100. Never the live Neon database, never `backend/.env`.
- No fake employees in the live database. No reset, truncate or delete of live data. Existing migrations untouched.
- Browser end-to-end scripts stay OUTSIDE the repo (decision 2026-11-07). No new test dependency (e.g. Playwright) is added without a stated requirement and the owner's approval.
- A bug is fixed only after its root cause is identified; affected tests are re-run after each fix, then the full suite.

## 2. Testing inventory (existing coverage, 73 files in `backend/tests/`)

| Module | Existing tests | Coverage assessment |
|---|---|---|
| Authentication, login, tokens | api-suite (272), role-identity, route-sweep, body-fuzz, input-validation | Good. Gap: session expiry / suspended-user timing as an explicit case |
| Admin panel | admin-console, admin-accounts, admin-tabs, hr-admin-boundary, privileges | Good |
| HR panel | hr-admin-boundary, hr-visibility, hr-filters*, hr-team-tasks | Good |
| Manager panel | manager-step*, hr-team-tasks, manager-self-tasks | Good. Gap: one explicit "manager cannot reach people outside his hierarchy" matrix across modules |
| Employee panel | role-home, role-identity, task-form-managers | Good. Gap: employee-reads-another-employee matrix |
| Employee management, hierarchy | phase1-company-hr, org-hierarchy-logic, org-hierarchy-workflows, company-access-logic | Good |
| Attendance, late and half-day | arrival-logic, attendance-calendar, attendance-leave-priority, late-remark-*, timezone | Good |
| Biometric records | none | **BLOCKED**: no importer exists (`biometric_punches` unused) |
| Breaks, productive time | activity-class, activity-policy, productive-breakdown, planned-hours | Good |
| Leave and approvals | leave, manager-step*, org-hierarchy-workflows | Good. **No leave quota exists** (days are counted, not a balance) |
| Daily tasks | task-entry-logic, task-form-managers, task-revert*, self-task-logic | Good |
| Meetings and huddles | meetings, participation-logic, huddle-*, invite-status-logic, admin-meeting-participation | Good. Two older files known to fail for test-setup reasons |
| Real-time chat | none | **BLOCKED / does not exist**: no chat module in the code |
| Real-time signals, notifications | realtime, realtime-e2e, notifications-read | Good |
| Query Desk / Complaint Centre | queries-logic (rules only) | **Gap**: no API-level test |
| Profiles, documents, photos | documents, photos, photos-logic | Good |
| Reports and Excel exports | report-xlsx, report-export-data, hr-filters-reports | Good. Not opened in desktop Excel (none on this machine) |
| Companies, projects | companies, pinned-scope | Projects: role guards only |
| Payroll, offers, onboarding | hiring-offers-payslips | Role guards only |
| Frontend pages | none in repo (one-off Chrome scripts in scratchpad) | **Gap** |
| Performance, concurrency | none | **Gap** |

## 3. Baseline run (2026-11-07)

### 3.1 No-database logic tests: 26 files, 542 checks

| File | Checks | Status |
|---|---|---|
| activity-class | 32 | PASS |
| admin-tabs | 8 | PASS |
| arrival-logic | 39 | PASS |
| company-access-logic | 22 | PASS |
| hr-filters-logic | 19 | PASS |
| huddle-section | 21 | PASS |
| invite-status-logic | 15 | PASS |
| late-remark-text | 10 | PASS |
| management-talk-logic | 17 | PASS |
| manager-step-logic | 16 | PASS |
| org-hierarchy-logic | 44 | PASS |
| participation-logic | 28 | PASS |
| photos-logic | 21 | PASS |
| planned-hours | 5 | PASS |
| policy-docs | 14 | PASS |
| productive-breakdown | 39 | PASS |
| queries-logic | 31 | PASS |
| realtime | 30 | PASS |
| report-xlsx | 26 | PASS |
| role-home | 11 | PASS |
| role-labels | 11 | PASS |
| self-task-logic | 18 | PASS |
| task-entry-logic | 14 | PASS |
| task-revert-logic | 20 | PASS |
| team-tasks-picker | 21 | PASS |
| ui-wording | 10 | PASS |

### 3.2 Database-backed tests: 47 files - NOT RUN yet
Need the isolated backend (port 5012) and seeded users on the throwaway DB. Planned for step 1 of the plan below. Two of these are already known to fail for test-setup reasons (documented in CLAUDE.md): `meeting-participation.test.cjs` (invites people who do not report to the manager) and one leftover-leave-row case in `org-hierarchy-workflows`; `manager-self-tasks` has 2 failures from this machine's IST timezone shifting a DATE read. These will be re-confirmed, not assumed.

## 4. Findings so far

| # | Module | Finding | Severity | Status |
|---|---|---|---|---|
| F1 | Chat | Real-time chat is not built; the "chat message received" workflow cannot be tested | n/a (scope) | BLOCKED - owner to confirm whether chat is planned |
| F2 | Leave | No yearly quota, so "leave balance" = days taken only (half day 0.5) | n/a (design) | Test counts only |
| F3 | Biometric | No importer; attendance comes from clock-in only | n/a (scope) | BLOCKED |
| F4 | Frontend | No frontend test framework in the repo | Low | Kept outside repo by decision |

No bugs have been confirmed yet.

## 5. Test plan (awaiting review)

| Step | Work | Output |
|---|---|---|
| 1 | Start isolated backend (5012) on throwaway DB; run all 47 DB-backed files; record PASS/FAIL per file | Section 3.2 filled in |
| 2 | Gap tests (new files in `backend/tests/`): (a) permission matrix 4 roles x key endpoints incl. manager-outside-hierarchy and employee-reads-other, at API level; (b) Query Desk API; (c) session expiry and suspended user; (d) data accuracy: dashboard vs raw rows, no double-counted meeting time, no duplicate rows, IST day boundaries; (e) light concurrency / response-time check | Section 6 |
| 3 | Browser end-to-end in real Chrome (scripts outside repo) for the 7 workflows (chat excluded, F1) as the four roles | Section 7 |
| 4 | Fix bugs with root cause only; re-run affected tests, then the full suite | Sections 8-9 |
| 5 | Final coverage table and pass/fail per module | Section 10 |

## 6. Test cases (to be filled)

| Module | Test case | Expected | Actual | Status | Severity |
|---|---|---|---|---|---|
| - | - | - | - | NOT RUN | - |

## 7. End-to-end workflows (to be filled)

| Workflow | Status |
|---|---|
| Employee login, clock in, clock out, attendance report | NOT RUN |
| Leave: employee, manager, HR final | NOT RUN |
| Manager views/assigns tasks, employee submits | NOT RUN |
| Huddle: manager creates, employee joins, ends | NOT RUN |
| Chat message received | BLOCKED (F1) |
| HR generates report, downloads Excel | NOT RUN |
| Admin creates employee, assigns manager, employee logs in | NOT RUN |

## 8. Bugs, root causes, fixes (to be filled)
None yet.

## 9. Regression results (to be filled)
None yet.

## 10. Remaining issues and final status per module
Not available until steps 1-4 are done. **The HRMS must not be called fully tested before then.**
