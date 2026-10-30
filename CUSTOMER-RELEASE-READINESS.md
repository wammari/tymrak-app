# Customer release readiness — 23 October 2026

Status: workplace-scoped candidate deployed to staging; production unchanged; customer launch gates remain open.
This document supersedes historical deployment-status statements in BASIC-CLOCK-RELEASE.md.

## Evidence

- Basic clock fixes: draft PR #25, commit f1e991cc5b549d9efb4c73b63255511823d93852.
- Geofencing and free map: draft PR #26, application commit 55b158db2dc037a55d5c04a35c85bd1c423bba9d.
- Stable staging https://tymrak-staging.vercel.app uses deployment AWpzat3DYowhMiuitdkcp4Q8EHmW, Ready, application commit 3ca8a2e, as of 24 October 2026.
- Local suite: 135 passed, zero failed/skipped; GitHub Actions run 40031800643 succeeded. Includes executable SQL and API/browser harness tests; map interaction uses Leaflet mocks.
- Company and manager/workplace migrations are applied only to staging. I Care Pharmacy is configured with w.ammari@outlook.com as company administrator and explicitly linked to its pharmacy workplace. The three existing employees are test accounts; they and all 22 punches are retained. No employee workplace assignments or real-employee invitations were added. Authenticated manager UI acceptance remains pending.
- User confirmed mobile clock-in, clock-out and password recovery on the earlier staging candidate. This does not establish acceptance of the newly added map/geofence flow.
- Staging geofence migration applied; service-only RPC permissions and transactional inside/outside/retry/evidence assertions verified. Tests rolled back synthetic records.
- Free map: Leaflet 1.9.4 pinned with SRI, OpenStreetMap tiles and visible attribution; no paid key, geocoding/autocomplete, account or billing setup. Manual coordinate fallback retained.
- Production read-only schema inspection found no company/organization/tenant columns or tables. Manager authorization is a global role; employees API lists all employees and updates by employee ID without company scope. Workplace RPC similarly returns all workplaces.

## Must fix before inviting unrelated companies

1. Company/workplace isolation: draft PR #27 implements this boundary and is deployed to staging. Do not place unrelated customers in production until its reviewed migration/mapping, hosted negative-access acceptance, and retirement of old unscoped deployments are complete. See COMPANY-ISOLATION-RELEASE.md.
2. Hosting: the observed Vercel account is Hobby. Vercel currently restricts Hobby to personal/non-commercial usage. Keep development on its existing account while evaluating commercially suitable free hosting; do not claim customer production can run there for free. No plan was upgraded. Cloudflare Workers is a candidate requiring compatibility and account/terms review, not an approved or deployed replacement.
3. Recovery: verified manual database backup and a successful restore rehearsal are absent. A table CSV is not a full backup. Preserve schema, data, functions, grants, Auth and external storage/configuration as applicable. Do not put backup contents or credentials in GitHub. Supabase Free has no automatic project backup in this account.
4. Email: establish production custom SMTP/sending-domain configuration and verify invitation and password recovery delivery to an address outside the project team. Current production configuration has not been verified. Supabase default SMTP is a test service, restricted to team recipients and two messages/hour; a successful recovery for the owner's address is insufficient evidence for customers.
5. Real geofence acceptance: signed-in manager selects a map point, confirms radius and saves; an assigned employee succeeds inside, is denied outside, and can recover from denied/inaccurate GPS. Verify map failure fallback and mobile display. Current workplace exists but has no assigned employees; do not assign real employees as a test without choosing the intended workplace.
6. Operations: verify production Auth callbacks, secure configuration, actual CI checks, target deployment controls across all repo-linked Vercel projects, rollback procedure, and monitoring before migration/domain cutover. Geofence code-only rollback cannot work after the old punch RPC is revoked.

## Concrete shared-company implementation

Use an explicit organization membership boundary. Do not infer company from email domain, editable profile metadata, browser IDs, department or location.

- Add organizations and organization_memberships (Auth UUID, organization UUID, role, active), with server-controlled membership and no client role writes. Preserve existing global roles only as a documented legacy transition, never as cross-company manager authorization.
- Give employees and workplaces a non-null organization ID after an explicit, reviewed legacy-data backfill. The owner must identify which company owns existing records; do not guess or rewrite production records during development.
- Constrain employee/workplace assignments to the same organization with database-enforced composite references. Scope uniqueness for usernames per company; decide explicitly whether one Auth identity may have several employee memberships before relaxing existing identity constraints.
- Scope every privileged endpoint: employees list/update/invite/resend, timecards, approvals/reopen, workplaces and assignments. Service-role requests bypass RLS, so every query and RPC must carry a server-validated membership boundary. Enforce ownership inside transactional SQL as well as API handlers.
- Scope employee punches/activation to the authenticated employee membership; never let a request select an unrelated company by ID. Store company identifiers on audit/receipt records or constrain them through immutable parent ownership.
- Add RLS and restrictive grants throughout; inspect views/functions and revoke unintended PUBLIC EXECUTE. Keep secrets server-side.
- Add pagination for employee/timecard lists and avoid silent Data API row limits. Replace the global geofence advisory lock with a scoped strategy only after concurrency correctness is established; the current global lock serializes all company punch decisions.
- Require two-company tests: A cannot list/read/update/invite/approve/reopen/assign employees or workplaces belonging to B, including guessed UUIDs and direct RPC/REST access. Exercise inactive membership, role changes, stale sessions, cross-company foreign keys and duplicate requests under concurrency.
- Add an owner-controlled company onboarding flow only after the boundary and tests pass. Do not expose public organization/role self-assignment.

## Safest release sequence

1. Accept the free map/geofence flow on staging using synthetic accounts; fix failures there.
2. Implement and test company isolation on a separate branch; rehearse forward migration and legacy backfill on synthetic data. Keep production unchanged.
3. Select a free hosting option compatible with current server handlers. Validate secrets, runtime, callbacks, limits and commercial use before any domain move. No paid fallback or automatic upgrade.
4. Verify customer email delivery and backup/restore. Obtain the actual legacy company mapping and secure database access needed for the backup; never request passwords in chat.
5. Create one exact release candidate from #25, reviewed #26 and isolation work. Retarget stacked PRs after dependencies merge; leave presentation/optional timecard drafts out. Disable unintended repo-linked deployments before merging.
6. Run full CI, negative authorization tests, concurrency/load tests sized to the intended pilot, and mobile acceptance. Record tested commit, migration hashes and rollback/recovery procedure.
7. Release first to one controlled customer cohort during a short maintenance window, monitor failed punches/auth/email and verify hours. Expand only after isolation and operational evidence is complete.

## Can wait

Google Places/address autocomplete, automatic lunch deductions, optional timecard presentation changes, advanced reports, subscriptions/billing, bulk imports and elaborate analytics. Browser GPS is user-provided location evidence, not proof against a determined spoofing client; do not market it as tamper-proof.

## References

- https://vercel.com/docs/limits/fair-use-guidelines
- https://supabase.com/docs/guides/auth/auth-smtp
- https://supabase.com/docs/guides/platform/backups
- https://developers.cloudflare.com/workers/platform/limits/
- https://operations.osmfoundation.org/policies/tiles/
