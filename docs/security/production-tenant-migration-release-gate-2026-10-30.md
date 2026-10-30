# Tymrak production tenant-security migration — release gate (2026-10-30)

Status: BLOCKED until every gate is verified. This is an operational checklist, not an executable migration. Never copy production credentials into Git.

## Confirmed read-only production baseline
- 4 employees, 2 user-role records, 43 punches, 2 timecard approvals.
- 4 employee accounts linked to Supabase Auth; no orphan punches or timecard approvals.
- 6 public tables with RLS enabled.
- No tenant organization_id columns yet on employees or user_roles.
- Supabase migration history currently returns no migrations; reconcile this with the existing live schema before rollout.

## Preconditions (all mandatory)
1. Identify the authorized company for EACH existing employee and manager. Obtain explicit confirmation of the mapping; do not infer it from email domains or user names.
2. Create a fresh recoverable production backup using the documented Supabase database-backup method; record UTC timestamp, source project, storage destination, encryption/access controls, and retention. Never put a backup or credentials in Git.
3. Restore that backup to an isolated test database and verify counts, table constraints, triggers, roles, grants, functions, and RLS policies. A backup is NOT validated until restoration succeeds.
4. Run the forward-only prerequisite migration on the restored copy first. Confirm all expected tables, composite foreign keys, indexes and RLS.
5. Populate company assignments on the restored copy using only the confirmed mapping; verify every active employee and role is assigned exactly once, and no company boundary violations exist.
6. Run the remaining tenant isolation migration(s) on the restored copy, including RPC grants and functions; test employee and manager logins, timecards, punches, approvals, and denied cross-company access.
7. Compare pre/post counts and sample record hashes; verify all 43 punches and 2 approvals preserved, and audit history remains intact.
8. Test an actual rollback / restore of the test database, with measured recovery time.
9. Only then schedule a production release with a write freeze, a rollback plan, and explicit go/no-go checks.

## Current staging evidence
- 3 organizations, 3 manager/admin role records, 5 employees.
- 10 cross-company manager/employee combinations: 0 allowed.
- Employee/workplace and manager/workplace cross-company assignment violations: 0.
- All 14 public tables have RLS enabled; direct authenticated grants on employees/punches/overtime_rules are SELECT only.
- These checks do NOT replace authenticated endpoint abuse testing or restored-backup migration tests.

## Production safety
- No direct DDL or DML against production until the backup and restored-copy tests pass.
- Never publish service-role keys, database URLs, user lists, or personal data in CI logs.
- Keep the first-manager onboarding feature postponed until the company-security release gate is complete.
