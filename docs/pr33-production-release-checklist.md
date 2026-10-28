# PR #33 release checklist (company/workplace boundaries)

Status: **NOT APPROVED FOR PRODUCTION**. The PR is draft. No automatic production rollout.

## Confirmed
- Existing production employee records (four) and manager role (one) are test-only, per owner.
- Staging Alpha/Beta manager logins and separated employee views were manually verified.
- Automated cross-company and migration contract tests passed (GitHub Actions run #81).
- Existing staging database accepts the structural prerequisite migration; this does **not** test first-time creation on the older production schema.
- Production is missing tenant tables and `organization_id` columns. The migration deliberately does not backfill existing test accounts.
- The marketing website is a separate Vercel project/branch; its recent Ready deployments do not validate the time-tracking production app.

## Blockers / safe sequence
1. **Complete security inventory** of every serverless endpoint and database RPC that can read/write employees, punches, approvals, roles, workplace mappings or invitations. Test direct-ID and mixed-batch attacks. A passing test suite alone does not establish completeness.
2. **First-time schema validation:** verify migration in an isolated production-like schema, including all FK/index assumptions and RLS behavior. Do not claim the existing staging migration replay proves this.
3. **Account treatment:** existing production test users will have NULL organization IDs after the structural migration and manager login will fail closed. Before app deployment, explicitly plan either retaining test accounts in a designated test organization or retiring them safely. Never automatically delete or reassign.
4. **Backup:** confirm recoverable production database backup and a restoration procedure before any DDL.
5. **Database first:** apply reviewed forward-only tenant prerequisite migration to production; verify tables, FK constraints, RLS, service-role SELECT, and organization mappings.
6. **App second:** deploy security branch only after database and test-account mapping are verified; run authenticated smoke tests for manager login, clock in/out, timecards, approvals, invitations and cross-company denials.
7. **Rollback:** preserve previous app deployment for immediate application rollback. Database migration is forward-only; do not attempt destructive SQL rollback. If app rollback occurs, assess compatibility of old app with added nullable columns/tables.
8. **Go/no-go:** inspect current PR head CI, staging deployment, API coverage and migration proof. Explicitly record release decision before merging.

## Security notes
- `requireManager` validates identity and role, while `resolveManagerScope` enforces a single active organization and workplace assignments. Each privileged endpoint must call the scope function before data access.
- Company admin invitations currently create the Auth invitation **before** inserting the employee record; if persistence fails, the Auth account may be orphaned. Add compensation or reconciliation before general availability.
- Avoid exposing test data or secret values in build logs, PR comments, or screenshots.

## Independent review findings (2026-10-28)
- **Browser staging/production isolation:** previously, staging `employee.html`, `timecard.html`, and `activate.html` pointed at the production Supabase project, while manager/login pages pointed at staging. The security branch now uses `client-supabase-config.js` on all seven Auth/timecard pages to select the project by hostname and reject unknown hosts. Automated hostname and page-coverage regression tests pass on commit `4a5d36f`; verify the actual deployed pages after Vercel builds this commit.
- **Punch acceptance blocker:** the security branch's `employee.html` still uses a direct browser `punches.insert`, but read-only staging privilege inspection shows `authenticated` has SELECT and **no INSERT** on `public.punches`. Therefore do **not** claim clock-in/out works in staging based on API security tests. Coordinate the employee punch route with the separate geofence work and test with an authenticated staging employee before release.
- **Staging deploy blocked:** the most recent READY security-branch Vercel deployment observed was commit `0d75241`, older than the browser isolation fix and latest passing GitHub Actions run. A preview deployment attempt for the latest tested security branch returned **403 Forbidden: no permission to create a Preview Deployment for `tymrak-staging`**. No deployment was created. An authorized project owner must restore preview deployment permission or deploy the approved staging branch; then verify the actual browser pages.
- **Staging RLS read-only audit:** `employees` and `punches` have row-level security; `authenticated` has SELECT but no direct INSERT/UPDATE on these tables, and manager approval tables are service-role only. Server-side privileged endpoints still require full direct-ID and mixed-batch review.
- **Migration proof:** the tenant prerequisite migration has not been validated against a clean production-like schema. Existing staging tables cannot substitute for first-time migration verification.

