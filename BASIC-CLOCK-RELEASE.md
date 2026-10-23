# Basic clock release candidate — draft, not deployed

## Findings and scope

The reviewed main commit is e6f66a2d87f150491064104360f1656a3cc09f85.
Login, invitation activation with completion-only retry, manual breaks, employee timecards,
manager authorization, approval locking and reopening already exist. Main CI was 74/74.
PRs #16 and #17 are merged. Drafts #18, #20, #23 and #24 remain separate.
Geofencing is not enforced: #20 contains pure helpers and a plan, not an integrated punch flow.
No GPS promise should be made for this release.

This candidate preserves manual breaks and existing timecard calculations. It does not add
customer tenancy or automatic lunch deductions. Use only a dedicated single-customer
application/database with customer-specific manager accounts. A shared multi-customer
launch remains blocked: manager APIs currently access all employees in their database.
Do not add a second customer's records until actual tenancy and authorization are implemented.

## Changes

- Shared runtime configuration replaces embedded production Supabase credentials on Auth,
  employee and manager pages. All privileged APIs use the same target validation.
- Hosted production configuration is rejected in preview deployments; staging is pinned to
  ctztwqcsizwkrqgpgrgg. Missing configuration fails closed. Secret keys never reach the browser.
- Activation URL credentials are removed before configuration fetching. Invitation sessions
  remain in memory. Password recovery uses configured redirects, renders errors as text,
  and rejects arbitrary destinations in the legacy recovery bridge.
- New authenticated /api/employee-punch reads state and records punches through a privileged
  RPC using a remotely verified Auth identity. Browser employee IDs/timestamps are ignored.
- New forward-only migration serializes each employee's punch decisions, checks activation
  and employment status, enforces transitions, uses server timestamps, records idempotent
  request receipts and revokes direct browser INSERT, including column-level grants.
  Unnecessary browser TRUNCATE/TRIGGER/REFERENCES privileges on employees/punches are revoked.
- Existing approval-lock triggers still run. A locked insert rolls back its receipt.
- Browser retry preserves the request ID in local storage through lost responses/reload.
  Stale tabs refresh before another punch; uncertain writes show a retry-only action.
- Clock state survives midnight/reload and display uses the province timezone. The summary
  explicitly includes the active overnight shift. This retains the existing province-based
  timezone model, not a newly configurable workplace timezone.

## Before staging deployment (requires explicit authorization)

1. Identify intended Vercel project and its branch/environment mapping. GitHub reported
   four project deployment statuses on main. The available Vercel connection returned no
   matching Tymrak projects, so live settings could not be verified.
2. Reconcile overlapping configuration changes with draft #18; do not merge both blindly.
   No staging bootstrap or historical migration is copied/reapplied by this candidate.
3. Run supabase/verification/basic-clock-preflight.sql read-only on the intended staging
   project. Confirm UUID employees.id and the punches fields/types, active/activated
   ownership policies, unique Auth mapping, and approval/audit triggers. Inspect broad
   TRUNCATE/TRIGGER grants separately; do not assume RLS alone blocks TRUNCATE.
4. Configure APP_ENV=staging, staging SUPABASE_URL and SUPABASE_EXPECTED_PROJECT_REF,
   matching SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY, SITE_URL at the dedicated
   stable staging origin. See .env.example; never copy production secrets to staging.
5. Check Supabase Auth site URL, exact activation/recovery callbacks, SMTP sender/domain,
   email delivery and Deployment Protection behavior with real test identities.
6. After schema review, apply only 202610230001_atomic_employee_punches.sql to staging.
   It does not backfill or edit punches. Old open clock pages will lose direct INSERT
   rights: use a short maintenance window and force users to reload the new page.
7. Deploy this exact candidate to isolated staging and perform real mobile acceptance.
   Automatic Vercel Git deployment is disabled for fix/basic-clock-release in its first
   published commit. No infrastructure or production deployment is performed here.

## Acceptance

- Invite a synthetic employee, activate, retry activation completion, login, logout,
  reset password, and verify unrelated/expired links fail safely.
- Clock in, refresh, start/end break, clock out; reconcile persisted timestamps and hours
  on employee and manager timecards. Check an overnight shift and timezone/device mismatch.
- Use two tabs, rapid clicks, lost POST response, HTTP 5xx, reload and retry. Confirm one
  punch per request, with stale state rejected and no false success.
- Verify another employee, inactive/pending employee, anonymous request, direct Supabase
  browser INSERT, client timestamp and forged employee identity cannot write punches.
- Approve a period and verify writes are locked; reopen and verify writes/audit history.
- Verify expected overtime rule exists for every participating employee's province.
- Verify customer manager cannot access a different customer's data (separate deployment
  and database in this initial scope). Keep a documented manager process for missed punches.

## Production approval and recovery

Production remains unchanged. Approval must cover the exact PR commit, intended customer
isolation, canonical domain, environment variables, SQL migration and maintenance window.
Production configuration requires APP_ENV=production, the verified production project URL
and matching SUPABASE_EXPECTED_PROJECT_REF, and SITE_URL=https://www.tymrak.com.
Confirm domain ownership/routing before using this canonical redirect. Merely copying the
candidate without these variables intentionally makes the app unavailable.

Take a database backup and record the deployed commit before approved rollout. Prefer a
forward repair. Rolling application code back alone will NOT restore old clock pages,
because direct browser INSERT is revoked. Any emergency privilege restoration must be
reviewed explicitly; never delete punches or request receipts as a rollback shortcut.
Existing employee activation/approval migrations must be verified as applied, not rerun
indiscriminately. Real Supabase/JWT/SMTP/GPS/mobile tests are not replaced by local tests.

## Validation completed locally

`npm test`: 100 passed, 0 failed, 0 skipped on Node 24.19.0 with PGlite 0.5.8.
The existing GitHub workflow also tests on Node 22; its PR result must be checked after publication.
All inline HTML scripts parse and `git diff --check` passes. Tests cover the existing workflows,
new SQL execution and browser permissions, API identity validation, stale states, request retries,
VM-based clock-page behavior, configuration isolation and password-recovery security.
These are not real mobile/browser or hosted Supabase acceptance results.
