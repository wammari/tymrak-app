# Isolated employee activation staging setup

Prepared for review only. No deployment, SQL execution, credentials configuration,
email sending or production data changes are authorized by this preparation.
Obtain separate authorization before carrying out the setup steps below.

## Source and review scope

- Main reviewed: `1fe60fda19a94167a069c0b773cf8d4cbf41b6bc`.
- Draft PR #17 reviewed: `ed6280789d6571c23681a50012f7595a6231d542`.
- This draft is stacked on `fix/employee-activation-reliability-phase1`, so its
  diff contains staging work only. PR #17 and this PR stay unmerged.
- Staging Supabase: `https://cztwqcsizwkrqgpgrgg.supabase.co`.
- Dedicated Vercel project to create later: `tymrak-staging`.
- Preparation branch: `setup/isolated-staging`. Its `vercel.json` disables automatic
  Git deployment for this exact branch before the branch is published. It does
  not change other branches or any existing Vercel project settings.
- Do not deploy the original main/PR #17 pages: they embed production Supabase
  settings. Do not deploy this branch to any existing production project.

## Configuration behavior

Seven Auth/data pages load `/api/public-config` through `supabase-config.js`.
That endpoint exposes only Supabase URL, public/anon key, site URL and environment.
It never includes the server credential. APIs use the same Supabase target parser.
Both configuration responses and browser requests bypass caching.

Every environment must explicitly configure `APP_ENV`. Hosted development is
rejected. Hosted previews cannot use `APP_ENV=production`. Staging accepts only the
project ref above and requires the matching expected-ref setting. There is no
production URL/key/site fallback. Invalid configuration blocks the browser and
server APIs. Errors from configuration are fixed text, without environment values.

The public key must be `sb_publishable_...` or a legacy JWT with `role=anon`;
secret keys and service-role JWTs are rejected by the public endpoint.
Modern publishable keys do not encode an inspectable project ref: obtain the key
from the staging project's Dashboard, then verify the real Auth request in staging.
The expected-ref check validates the URL, not the cryptographic identity of a key.

Invitations now derive their existing redirect from required `SITE_URL`.
Password recovery uses the same site origin. Sending/resending logic, employee
identity handling and PR #17's isolated invitation session remain otherwise intact.
Normal login/recovery storage remains Supabase's existing per-project default.
Recovery errors now use textContent; its fixed successful-reset link still renders.
The activation callback is captured in memory and removed from the URL before
configuration fetching. Activation/recovery pages suppress referrer headers so
token-hash callbacks are not sent as referrers to shared module/config requests.

## Prepared database files

These files are outside `supabase/migrations`; normal production migrations must
never pick up this reconstructed baseline or the synthetic fixtures.

| File | Purpose |
| --- | --- |
| `supabase/staging/base-schema.sql` | Recovered employees, overtime_rules, punches, constraints, indexes, timestamp trigger and four RLS policies |
| `supabase/staging/least-privilege-and-fixtures.sql` | Narrowed grants, staging marker and one synthetic ON overtime rule |
| `supabase/staging/initialize-empty-staging.sql` | Generated, single-transaction, empty-project bootstrap containing the baseline and all seven existing migrations |
| `supabase/staging/test-manager-role.sql` | Optional later assignment of one explicitly selected test Auth account to manager |
| `supabase/staging/verify-staging.sql` | Read-only catalog and privilege checks for a later operator |

Run `npm run prepare:staging-sql` to regenerate the bundle. This command only
assembles files: it has no database client or SQL execution. The generated bundle
includes the seven migration bodies in filename order, including PR #17's RPC.
Only PR #17's outer BEGIN/COMMIT are omitted from the bundle so it retains one
transaction. The original migration file is unchanged.

Bootstrap refuses to run unless the operator explicitly confirms the staging ref,
the public schema has no application relations (including views, materialized views,
sequences, foreign tables or indexes), routines, types, collations, operators,
operator classes/families, conversions, text-search objects or extensions,
and Auth has no users. Public extension objects are deliberately not exempted;
an unexpected extension blocks initialization and requires inspection.
Supabase-managed objects in other schemas and existing schema/default grants
are not treated as public application objects.

One narrow exception permits the existing `public.rls_auto_enable()` and
`ensure_rls` event trigger recovered from staging on 2026-10-12. The guard verifies
the exact function body using a SHA-256 fingerprint (normalizing CRLF only),
postgres ownership, plpgsql language, event_trigger return type, SECURITY DEFINER,
exact pg_catalog search path and standard volatility/strictness/parallel settings.
It requires exactly one binding: ensure_rls, ddl_command_end, enabled O,
postgres owner, and precisely CREATE TABLE / CREATE TABLE AS / SELECT INTO tags.
Only that verified function OID is excluded from the routine inventory.
An overload, altered helper, disabled/missing/extra binding or any other public
object still blocks initialization. The function and trigger are inspected only:
the bootstrap never changes their definition, ownership, ACLs, settings or enabled
state. They are not installed by this bootstrap when absent. Do not delete them
or manually remove the guard to resolve an initialization error.

This is consistent with Supabase's documented automatic-RLS pattern; the metadata
does not prove who originally installed it. Its existing presence does not mean
the project contains employee data. The test-only fixture lives under
`tests/fixtures/` and must never be copied to a Supabase SQL editor.
The confirmation string is an
operator safeguard, not a reliable way to detect a Supabase project from PostgreSQL.
Verify the actual Dashboard URL/project ref before running any SQL.
The error reports the kind and name of the first conflicting public object.
Do not weaken the guards. If the project is not empty, stop and review its contents;
do not delete users/tables to make the bootstrap pass.

The baseline includes all supplied columns, including both `mobile_number` and
`mobile`, literal `punches.float8`, text `punch_type`, and BY DEFAULT bigint
identity `public.punches_id_seq`. Supporting unique indexes are created by their
constraints once. The standalone overtime partial unique index is preserved.
RLS is enabled, not forced, on all six application tables. Roles, approvals and
history have no browser-facing policies. The supplied employee and punch policies
are reproduced; browser grants narrow their practical scope to authenticated users.

Production already has UNIQUE(auth_user_id). Preserve it in staging. Do not
remove it to create duplicate mappings: duplicate defense is covered by PR #17's
mock/disposable database tests. A duplicate insert in staging should be rejected.

### Deliberate grant differences from production

| Role | Staging access |
| --- | --- |
| anon | No application table/sequence privileges, no activation RPC |
| authenticated | SELECT employees/overtime_rules/punches; INSERT punches subject to RLS; identity sequence USAGE |
| service_role | SELECT/INSERT/UPDATE employees; SELECT/INSERT/UPDATE/DELETE punches; SELECT overtime_rules/user_roles/history; SELECT/INSERT/UPDATE approvals; sequence USAGE; activation RPC EXECUTE |

Browser TRUNCATE/TRIGGER/REFERENCES and punch UPDATE/DELETE are not copied.
TRUNCATE is not row-filtered by RLS. Production grant cleanup is separate work,
not an effect of this staging bootstrap. Service access is intended only for the
protected server APIs; manager-role provisioning uses the Dashboard SQL operator.
Audit history is written by its trigger, not a direct app writer.
Default privileges and unrelated schemas/objects are not globally changed.

## Definitions recovered and remaining gaps

The repository lacked the base table DDL, the four application policies, grants,
identity sequence definition and `set_updated_at()`. They are reconstructed from
the read-only production exports supplied on 2026-10-11. Existing migrations
provide user_roles, approval/audit tables and triggers, optional reopen reasons,
the obsolete-constraint correction, and the Phase 1 activation RPC.

No `invitations` or `timecards` table is used by the reviewed invitation/activation
workflow. Do not invent these tables or copy employee/Auth records.
Supabase provisions its own managed auth schema, Auth functions and roles.
Do not reconstruct or import production auth.users, identities, passwords,
refresh tokens, signing keys or Supabase-managed internal schema.

These exports are not a complete production database dump. Production Auth
templates, SMTP, expiry/rate settings, enabled providers, hook configuration,
exposed API schema settings and additional objects outside the supplied inventory
have not been recovered. To establish exact parity, inspect these settings
read-only in the production Dashboard and recover schema-only definitions for
any configured custom hooks/dependencies through pg_catalog or an authorized
schema-only dump. Do not copy secret values or execute unknown functions.
Do not enable production hooks in staging without separately reviewing every
external destination and dependency. Basic staging invites use default Auth.

The synthetic ON fixture is enough for ON-only smoke tests, not national payroll
parity. Real overtime rule contents/effective dates/business seed definitions are
missing from the repository. Recover nonpersonal rule definitions read-only and
review them separately if broader payroll tests are required. They are not needed
to verify employee activation. No real employee or punch seed is included.

## Step-by-step setup, after separate authorization

### 1. Review and initialize the empty staging database

Verify Supabase Dashboard project ref `cztwqcsizwkrqgpgrgg`, not production.
Before creating any test Auth accounts, review the generated initialization SQL.
In the staging SQL editor, paste the full file and uncomment only the explicit
staging-confirmation line. Run it once as the administrative SQL operator.
If it errors, roll back the transaction and investigate; do not continue with
selected fragments. The transaction either initializes all app objects or none.

Run the prepared read-only verification SQL. Expect six RLS-enabled app tables,
four supplied policies, recovered constraints, approval/audit triggers, the
employee updated_at trigger, and `public.punches_id_seq`.
anon/authenticated must lack employee UPDATE/TRUNCATE and role SELECT;
authenticated alone among browser roles has punch INSERT. Only service_role
among the three API roles may execute the activation RPC. Repeated RPC calls
must be tested later with test users; the bootstrap itself changes no accounts.

Manual SQL-editor execution does not populate Supabase CLI migration history.
Do not subsequently run `supabase db push` against this database blindly.
If CLI migration tracking is wanted, separately plan recording the seven already
applied versions as applied after verifying the exact schema; do not rerun them.
The bootstrap is deliberately one-time and is not an upgrade path.

### 2. Create the dedicated Vercel project without an initial main deployment

Use a new project named `tymrak-staging` under the intended Vercel account/team.
Do not clone settings or credentials from any of the existing three projects.
Reserve/verify its stable HTTPS domain; intended `https://tymrak-staging.vercel.app`
may have an account suffix. The application accepts a staging host starting
`tymrak-staging` and ending `.vercel.app`, or a separately configured
`staging.tymrak.com`. No domain or DNS change is included in this PR.

Vercel's import wizard can create an initial deployment. Do not click Deploy
until the reviewed staging commit and all staging variables are selected.
If the wizard cannot select this branch before its first deployment, stop.
An alternative for an authorized operator is `vercel link`: choose the intended
account/team, create a NEW project named tymrak-staging, and stop after linking.
Linking and deploying are separate CLI operations. Confirm the resulting
`.vercel/project.json` belongs to the new project before any deployment.
Do not select an existing project, run `vercel pull` against production, or
check linked-project files into Git.

Use Framework Preset Other and repository root. The app uses static HTML plus
root `api/*.js` Vercel functions; no static-only host or custom build is needed.
Use Vercel's default root serving behavior rather than publishing a separate
output directory that omits the API. Do not run a migration in a build command.
If connecting Git later, select a reviewed staging branch rather than main and
retain the current branch's automatic-deployment guard. Manual deployment of an
exact reviewed commit is preferable during initial testing.

### 3. Enter staging credentials directly in the new Vercel project

| Variable | Value/source |
| --- | --- |
| APP_ENV | `staging` |
| SUPABASE_URL | `https://cztwqcsizwkrqgpgrgg.supabase.co` |
| SUPABASE_EXPECTED_PROJECT_REF | `cztwqcsizwkrqgpgrgg` |
| SUPABASE_PUBLISHABLE_KEY | Staging Dashboard's publishable key, or its legacy anon key |
| SUPABASE_SECRET_KEY | Staging secret key, entered as Secret; server only |
| SITE_URL | Verified stable staging HTTPS origin, no path/query |

Apply staging values to Production and Preview scopes IN THE NEW STAGING PROJECT
only. Vercel's Production scope here means its stable staging deployment; it does
not mean TYMRAK's production database. Development can also use these staging
values if explicitly approved. Never attach production credentials to previews.
Do not paste secret values into chat, committed files, screenshots or logs.
RESEND_API_KEY is not needed by these Auth-admin invitation endpoints; configuring
it in Vercel would not configure Supabase Auth email delivery.

### 4. Configure only staging Auth

In staging Authentication > URL Configuration, replace the initial localhost
Site URL with the verified staging origin. Add exact redirect entries:

- `<STAGING_ORIGIN>/activate.html`
- `<STAGING_ORIGIN>/reset-password.html`

No production URL and no wildcard across Vercel projects. For this app's direct
recovery flow, the reset-password page is the callback; the password-recovery
wrapper does not need an additional URL for default templates.

Enable email/password Auth. Keep public signup disabled for an invite-only test
environment; the manager is created administratively and employees are invited
through the protected API. Keep email confirmation enabled. Set a reviewed
minimum password length of at least eight; eight matches the current page check.
If stronger requirements are chosen, use compliant test passwords and test errors.
Keep ordinary session/token lifetimes and rate protections enabled. Record the
actual email-link expiry, resend interval and email rate limit for repeatable tests;
these production values were not recovered. Do not reduce production settings.

Start with the default Invite and Reset Password templates using
`{{ .ConfirmationURL }}`. This app accepts verified invite fragments with
`type=invite` and invite token-hash query callbacks. Admin invitations do not
support PKCE. A template that redirects straight to a bare activation URL will
fail. If a custom invite template is required, review its nonsecret HTML and
redirect handling before testing; do not copy hardcoded production destinations.
The reset page retains its existing PASSWORD_RECOVERY-event flow.

For actual controlled employee inboxes, configure dedicated staging custom SMTP
later, directly in Supabase Auth, with a staging sender. Supabase's default SMTP
only sends to organization team addresses and is rate limited; do not add test
employees to the Supabase organization simply to bypass that restriction.
Use separate scoped staging SMTP credentials if Resend is the chosen provider.
No SMTP credentials or provider configuration are included in this preparation.

### 5. Create only controlled test identities

After database initialization, create one separate test manager in staging
Authentication > Users using a controlled test email and test-only password.
Confirm its email if needed for sign-in. Replace the email placeholder in
`test-manager-role.sql`, verify the staging project again, uncomment confirmation
and execute that optional script. It assigns one role; it does not alter Auth or
silently overwrite an existing role. Record the test manager UUID privately.

Create employee A and employee B from the manager page with distinct controlled
inboxes and usernames such as `staging.employee.a` and `staging.employee.b`,
province ON, and clearly synthetic names. Their employee profiles/Auth identities
must be created by the existing invitation API, not manual seed inserts.
Do not precreate their Auth users: that would alter invitation behavior.
Use a separate ordinary staging Auth account with no manager role for denial
tests. Never import real names, emails, punches, managers or activated accounts.

### 6. Deploy only after database/configuration review

This step requires explicit deployment authorization. Check account, project,
branch, exact commit, and all six staging settings immediately beforehand.
Deploy the reviewed staging commit to the NEW project. Automatic Git deployment
is disabled for the preparation branch; a manual deployment is a separate action.
Do not remove the guard to trigger previews in the existing projects.

Before any employee invitation, visit `/api/public-config`: it must show the
staging Supabase URL, staging site, staging environment and public key only.
Check browser Network on manager login, activation, recovery, employee and
timecard pages: every Supabase request must target the staging project.
Check the deployment's server configuration without exposing its secret values.
Stop on any production request, missing configuration, Auth hook surprise or
wrong site URL. Do not proceed by replacing settings in production.

Keep Deployment Protection on while preparing. For email callbacks, the tester
must be able to access the app without losing the callback parameters. Use an
authorized tester browser/team access or a separately reviewed staging-only
protection policy. Do not put protection bypass secrets in invitation emails.
If a sign-in wall consumes the link or blocks the app, stop and resolve staging
access before generating more invites.

### 7. End-to-end acceptance using test employees only

| Scenario | Expected result |
| --- | --- |
| Manager invites employee A, employee follows newest email | Password saved, one mapped profile becomes Account Activated, first activated_at set |
| Completion request is blocked after password success | Page offers Retry Activation Completion; password fields cleared/disabled |
| Unblock request and retry on the same open page | Completion succeeds with no second Auth password update |
| Retry a completion whose response was lost | Success, same auth_user_id and original activated_at; no further profile write |
| Already activated account completes again | Idempotent success; identity, timestamps and profile unchanged |
| Authenticated test user with no employee mapping | 404; no employee row created/changed |
| Duplicate mapping attempt | Existing unique constraint rejects it; do not remove the constraint |
| Missing, invalid or expired bearer session | Rejected before activation writes |
| Bare activation URL while another employee/manager is signed in | No password form enabled; saved session is not invitation proof |
| Expired or consumed invite link | Clear error; no password update from unrelated browser session |
| Ordinary test user requests an invitation | 403; anonymous request 401; no email or employee creation |
| Duplicate invite request for existing test email/username | Rejected; record any existing race/resend issue separately |
| Resend to activated test employee | Rejected; identity and original activation time remain intact |
| Test password recovery from login | Email returns to staging reset page; recovery session updates only that test Auth user |
| Activated employee punches and opens timecard | Own profile/punches available; other employee data and manager APIs denied |

For completion-failure testing, use browser request blocking on ONLY
`/api/complete-activation`; keep Supabase Auth unblocked so password save can
succeed. Count password-update requests, unblock, then retry without closing the
page. Reload intentionally discards PR #17's in-memory invite/retry state.
Capture before/after test UUIDs, invitation status, activated_at and updated_at
without logging passwords/tokens. The first activation updates updated_at through
the recovered trigger; subsequent already-activated completion must not change it.
Use application-created test accounts for activation/recovery, not real users.
Do not delete/recreate usable Auth accounts or resend invitations to repair a
completion failure. Investigate mapping/configuration separately.

SQL transactions and RLS have now been exercised in disposable embedded
PostgreSQL. Supabase's managed Auth/gateway behavior, SMTP delivery, one-time
links and Deployment Protection still require these real staging checks.
Local database success does not establish live deployment readiness.

## Validation and future production boundary

`npm run test:no-sql` covers all existing JavaScript/API/page tests and new
configuration regression/static SQL-assembly checks without executing SQL.
On 2026-10-12, disposable local SQL testing was separately authorized.
The full `npm test` passed: 129 tests, zero failures. This includes the 86
non-SQL checks, PR #17's five activation database tests, and 38 new checks in
`tests/staging-bootstrap-database.test.mjs`.

The new tests execute the entire generated bootstrap, enabling only its commented
confirmation inside an in-memory PGlite 0.5.8 database. The source SQL otherwise
matches the reviewed PR exactly. Simulated managed Auth UUID/email objects,
an auth.uid() claim helper, and anon/authenticated/service roles provide the local
dependencies; these are not a running Supabase Auth server. Broad initial default
table/sequence grants are included so the bootstrap must actually revoke them.
No Supabase API, remote database, actual passwords or real employees are used.

Verified:

- Successful creation of all six RLS-enabled tables, recovered column counts,
  identity sequence, four policies, final approval constraints and synthetic ON rule.
- Refusal of missing/wrong confirmation and pre-existing tables, views, materialized
  views, sequences, functions, procedures, enums, domains, collations, text-search
  configuration, public extensions and Auth accounts, without replacing them.
- Complete rollback after a deliberate failure following migration execution.
- Browser privilege restrictions, server-only activation RPC, own-profile/own-punch
  RLS, denial before activation and denial for inactive/cross-employee punches.
- Successful activation, unchanged identity/profile fields, timestamp-preserving
  retries, legacy activation evidence, missing mapping and real unique-ID rejection.
- Approval locking, optional-reason reopening, re-approval audit events and
  append-only history, with the server role unable to insert history directly.
- Refusal of repeated initialization, and test-manager seeding that changes only
  the selected role and rejects confirmation errors, employee identities and repeats.

The automatic-RLS exception was subsequently added after live staging metadata
revealed that helper in an otherwise empty project. Disposable regression tests
verify successful initialization with it present, unchanged function/trigger
metadata and continued automatic RLS on a new probe table, plus rejection of
changed bodies/owners/settings, missing/disabled/renamed triggers, incorrect tags,
additional bindings, overloaded routines and unexpected public objects.
Repeat the live
staging acceptance checklist after the separately authorized setup. The local
auth.uid() helper simulates verified claims; it does not test email delivery,
JWT verification, Supabase role configuration, real one-time callbacks or concurrency.

This staging PR cannot be merged to main without a separately reviewed production
configuration rollout. Before deploying the changed frontend to production,
production must explicitly configure APP_ENV=production, its own
SUPABASE_EXPECTED_PROJECT_REF, public key, server key, and SITE_URL in its existing
project. No production setting is changed here. PR #17's function still must be
applied to production before its new API is deployed, under separate authorization.
After PR #17 eventually merges, rebase/retarget this stacked PR to main and resolve
the activation-page configuration change without losing its invitation isolation.
No migration, project creation, credential entry or merge happens automatically.

## Official references reviewed

- [Vercel Git deployment controls](https://vercel.com/docs/project-configuration/git-configuration)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Vercel project setup from CLI](https://vercel.com/docs/projects/deploy-from-cli)
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Supabase admin invitations](https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail)
