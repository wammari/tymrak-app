# Customer release candidate — 30 October 2026

This candidate combines the tested clock/geofence/company/workplace stack, the verified backup and migration rehearsal, production Worker preparation, and the current main branch's approved portal homepage. The current marketing site is not changed by this branch. Automatic Vercel deployment is disabled for `release/customer-candidate`. Production Worker routes remain empty, previews remain disabled and `TYMRAK_RELEASE_READY` remains false.

## Current status — October 31

This section supersedes the older snapshot counts and hosted-state observations in the historical notes below.

- Hosted runtime `39bacc2` is READY at the stable staging branch alias: https://tymrak-staging-git-release-customer-candidate-wammari.vercel.app/ . Its public configuration identifies staging and the staging database. The branch-specific Preview SITE_URL and two exact activation/reset callbacks are saved. Subsequent published runtime-equivalent commits add tests only.
- Authenticated administrator and employee read acceptance passed: three company test employees, manager summary/detail, employee clock state and personal timecard, invitation form without sending, workplace assignment controls and free numbered-address search/map selection.
- Actual staging database scope functions returned exactly the expected staff for both restricted-manager company fixtures and the pharmacy administrator. Unknown manager denied; privileged scope/workplace functions and trigger helpers deny direct browser invocation. Restricted-manager HTTP/browser session acceptance remains separate.
- Five deployed geofence RPC rejection cases passed. A synthetic service-role clock-in, identical-result retry and clock-out at the saved staging centre produced exactly two temporary punches, receipts and location verifications, then rolled back. Follow-up found no punches/receipts added that day for the test employee. This does not establish physical GPS acceptance.
- The saved staging workplace was independently changed to 11 Speedvale Avenue East, Guelph, 50 m, three assignments, centre `43.5584418124796 / -80.267497094979`. Preserve it. The earlier unsaved Photon candidate in the production review plan is different; neither pin is proof of an on-site test.
- Fresh read-only backup/restore verification passed: https://github.com/wammari/tymrak-app/actions/runs/41228493414 . The encrypted artifact digest, export file hashes and restored inventory were verified locally. Snapshot: four employees, four Auth users, 47 punches, two manager memberships, zero Storage objects. Encrypted evidence is retained privately; recovery credentials are not in the repository.
- The refreshed rollback-only bootstrap guard requires that 47-punch snapshot and two reviewed manager memberships. It promotes only the owner-designated confirmed Outlook administrator inside the rolled-back review. The other existing activated test manager membership remains unchanged and has no automatic company/workplace scope. Other role changes or inventory drift stop the review.
- `ops/rehearse_release.py` now reviews this concrete bootstrap in the already verified loopback restore after the five unchanged release migrations and rollback-only access tests. It checks the temporary mapping report and original record hashes. It never applies the setup to production.
- Production still lacks the company/workplace/geofence schema. External email/activation/recovery completion, restricted-manager HTTP/browser checks, on-site inside/outside phone GPS tests, production credential/runtime preparation and explicit cutover approval remain open. No production business-data write, migration, merge, application deployment, real invitation or paid-service change was made by this follow-up.

The latest application suite has 167 passing tests, including four bootstrap review tests. Seven Python operations guard tests pass. The earlier counts below describe prior verification steps.

## Integration decisions

- Preserve the approved portal homepage byte-for-byte from main commit `57368a2645596494e6d0aefe86441a9653efd712`. Keep the existing tested brown/gold application styles and approved logo assets.
- Verify manager bearer sessions with the configured public key; retain the server key for scoped database access. Require a valid runtime public key and the existing deployment/project boundary checks. Do not copy main's hardcoded production key/project into staging.
- Preserve manager password recovery with the configured deployment callback. Provide Employee Login and Manager Login after reset. Support verified recovery token hashes and PKCE recovery events; a normal sign-in session cannot enable this reset form. Verify the current identity before changing its password, and clear recovery parameters from browser history after authorization.
- The portal callback origin is `https://app.tymrak.com`; the marketing site remains `https://www.tymrak.com`. This is candidate configuration only and does not change Auth settings or DNS.
- Do not merge the parallel PR #33 prerequisite migration into this stack: it creates overlapping company/workplace objects. The rehearsed stack already enforces those boundaries. PR #35's browser-only GPS experiment is superseded by the server-side implementation in this candidate. No alternative PR is closed automatically.

## Existing database evidence

Backup/restore verification: https://github.com/wammari/tymrak-app/actions/runs/40786029927 . Migration and rolled-back acceptance rehearsal: https://github.com/wammari/tymrak-app/actions/runs/40787797476 . The migration files remain unchanged from that rehearsal. Verified encrypted evidence is retained privately. These were production read-only exports and local-only writes.

## Release gates still open

1. The owner's latest correction on October 30 confirms **11 Speedvale Ave E, Guelph**, superseding the earlier 1 Speedvale entry and Hamilton staging address. The owner will perform on-site testing later. The production plan uses the previously requested 50 m radius. Verify the building's exact map pin and indoor/outside GPS behavior before activation; coordinates have not been assumed or copied from staging. See `supabase/verification/production-workplace-plan.json`.
2. Prepare and review production I Care Pharmacy ownership, Outlook administrator and workplace mapping using production IDs. Preserve all test histories and validate required-company constraints after assignment.
3. Confirm production Auth redirect allowlist for app.tymrak.com and external invitation/recovery email delivery. The owner supplied the two real pilot recipients in this thread. Their details are kept out of this public repository; no invitations have been sent.
4. Complete authenticated hosted acceptance. Vercel connector deployment access still returns HTTP 403/404, but the authorized dashboard was accessible and a manual **Preview** of commit `e51ae2c01ff74ed9e200e42bbba4067bec8dfb69` reached **READY** in 9 seconds: https://tymrak-staging-2kppfvdu1-wammari.vercel.app/ . The preview public configuration identifies the staging Supabase project `ctztwqcsizwkrqgpgrgg`; portal and Manager Login load, anonymous clocking is rejected, and checked package/private-auth source URLs return 404. GitHub CI for that exact commit passed: https://github.com/wammari/tymrak-app/actions/runs/41096330461 . No production deployment was created or promoted. Authenticated manager/clocking and external email delivery remain unverified.
5. Provision the isolated production Worker and fresh runtime keys, retire old privileged snapshots/credentials, take the final maintenance-window backup, then perform the reviewed database/app/domain cutover and hosted mobile/cross-company acceptance.

No production migration, deployment, invitation, paid service or plan change is performed by preparing this branch. Existing pending/WIP feature PRs are not automatically included.

## Staging sign-in check

On October 30, an initial sign-in attempt failed; a read-only check confirmed that the intended staging administrator account was active and correctly assigned. The owner subsequently completed sign-in. Fresh browser evidence on the exact `e51ae2c` preview confirmed the authenticated ADMIN portal, three I Care Pharmacy test employees, the semi-monthly timecard summary and a test employee's detailed completed clock-in/out row. The workplace screen loaded its existing workplace and all three employee assignment controls. Leaflet/OpenStreetMap tiles rendered successfully. No employee, punch, approval, workplace or assignment was saved or changed during these checks. This verifies the administrator workflow; it does not establish hosted acceptance for a restricted workplace-manager account or a new employee clock-in/out.

The actual in-app free address search for **1 Speedvale Ave E, Guelph, Ontario, Canada** returned several street-level matches, without building number 1. No result was selected or saved as the pharmacy's exact pin. The follow-up code change labels results without house numbers as street/area matches, retains the manager's entered address when such a result is selected, and explicitly asks the manager to place the pin on the exact building. It does not claim that a numbered result is automatically verified. All **156 application tests** pass locally after this change, including provider result precision coverage. The original hosted preview predates this follow-up and remains at `e51ae2c`; deploy a new staging preview before claiming hosted verification of the warning.

## Latest owner correction

The correct release address is **11 Speedvale Ave E, Guelph, Ontario, Canada**. The earlier hosted search for number 1 remains a historical test only and does not verify number 11. On-site testing is deferred. The owner subsequently supplied both real pilot employee names and email addresses directly in this thread. Those exact recipients are resolved; do not publish their details in this public repository.

## Corrected-address and invitation preflight

The authenticated staging application searched **11 Speedvale Ave E, Guelph, Ontario, Canada** and returned numbered matches, including **I.D.A., 11 Speedvale Avenue East, Guelph, Ontario, N1H 1J3, Canada**. Selecting that result filled latitude `43.5585125` and longitude `-80.2676337` in the unsaved form and rendered a draggable map pin. These are candidate coordinates only, recorded separately in the review-only plan; the approved coordinate fields remain unset, map verification remains false and production activation remains false. The saved Hamilton staging workplace and its assignments were not changed.

A fresh production **read-only** preflight on October 30 found four employees, four Auth users, **43 punches**, no Storage objects and no duplicate employee/Auth mappings. The earlier backup/rehearsal snapshot had 37 punches; take and verify a fresh backup immediately before any approved production cutover. Production still lacks the company/workplace tables and the geofenced punch/manager scope RPCs. The intended Outlook administrator is confirmed but still has the legacy manager role. Trigger helpers retain direct anonymous/authenticated EXECUTE; the candidate includes the previously rehearsed revocation migration. This check did not apply it.

The two owner-supplied pilot recipient emails have **zero matching employee rows and zero matching Auth users** in the production project as of this check. This is a preflight observation, not a reservation: repeat the duplicate check immediately before invitations. No employee records or invitations were created. Production migrations, company/admin/workplace mapping, Auth redirects and external delivery acceptance remain release gates. On-site 50 m GPS acceptance is deferred by the owner.

## Invitation integrity follow-up

The invitation API previously accepted an empty or ambiguous successful database response and could report success without a linked employee profile. It now requires exactly one saved row with an employee ID and the Auth identity returned by the invitation service. Resend previously ignored the returned Auth identity; it now rejects missing or mismatched links and preserves the existing mapping. Its status update also matches the original Auth identity and requires an unactivated employee, so concurrent activation cannot be overwritten as Invitation Sent. These guards do not make external email delivery and database persistence one transaction; an upstream invitation followed by a database failure still requires reconciliation and must not be presented as success.

All **160 application tests** pass locally after these changes, including missing/ambiguous profile responses, identity mismatches, missing links and concurrent activation. No hosted email was sent by these tests.

The connected Supabase tools expose database queries but not hosted Auth redirect or SMTP configuration. The dashboard initially required sign-in. The owner completed it on October 31; the verified configuration and targeted corrections are recorded below. External delivery acceptance remains pending.

## Hosted Auth configuration — October 31

The owner completed dashboard sign-in. Production project `tsosredghislnehfyypi` has Site URL `https://app.tymrak.com` and custom SMTP enabled at `smtp.resend.com`, port 465, sender name TYMRAK. The stored SMTP password was not revealed or replaced. Staging project `ctztwqcsizwkrqgpgrgg` also has Resend SMTP enabled on port 465, sender name TYMRAK Staging, and Site URL `https://tymrak-staging.vercel.app`. Its stable activation and reset callback URLs are already allowlisted.

Two production **Auth configuration** corrections were saved through the dashboard:

1. Added only `https://app.tymrak.com/activate.html` to the redirect list. The existing reset callback and legacy Vercel entry were preserved. The dashboard confirmed one added URL and a total of three. The live activation page exists and correctly rejects a visit without an invitation token.
2. Replaced the hardcoded `https://tymrak.vercel.app/password-recovery.html` hostname in the recovery email template with `{{ .SiteURL }}/password-recovery.html`. The original ConfirmationURL wrapper, subject, copy and recovery flow were preserved. The canonical live bridge exists and rejects a visit without a recovery URL. A dashboard reload verified that the updated template persisted and Save changes was disabled.

These checks verify stored configuration and public routes, **not** a delivered email or successful password update. No test recovery email or real employee invitation was sent. No employee, punch, company, role or workplace data was changed; no migration, merge or production application deployment occurred. The legacy Vercel redirect entry still needs retirement during the reviewed cutover after canonical invitation/recovery acceptance. The release still requires company/admin/workplace mapping, a fresh verified backup and deferred on-site GPS acceptance.

Rollback for the narrow configuration changes, only if required by a confirmed regression: remove the exact activation callback just added and restore the recovery template host to `https://tymrak.vercel.app/password-recovery.html`; do not alter SMTP credentials or other redirect entries.

## Reviewable company bootstrap

`ops/review-company-bootstrap.sql` is a separate review/rehearsal script, not an automatic migration. It always ends with **ROLLBACK**, and it has not been run against production. It requires the rehearsed release schema, the reviewed inventory of four employees/four Auth users/47 punches, empty company/workplace/assignment tables and two existing manager memberships. The confirmed Outlook identity is the only proposed company administrator; the second activated test manager stays unchanged without a company or workplace assignment. Any inventory, membership or ownership drift stops it before company creation.

Inside its rolled-back transaction it resolves the administrator by confirmed email, creates I Care Pharmacy, maps the four owner-confirmed legacy test employees to that company and makes the existing manager its company administrator. It prepares the candidate 11 Speedvale address with a 50 m workplace that remains **inactive** and grants no employee workplace assignments. Employee fields (other than the intended company/update timestamp), all punches and all Auth records are hash-checked for preservation. No real pilot employee names/emails are included. Activation/assignment requires the reviewed exact pin and deferred on-site test.

Four database-backed tests prove the intended temporary mapping, complete rollback/history preservation, inventory-drift rejection, refusal to overwrite an existing company and refusal of an unreviewed second administrator. This makes the intended production mapping concrete for later approval; it does not authorize a cutover or bypass remaining hosted/email/GPS acceptance.

The full application suite passes **163 tests** after adding the bootstrap review tests. The deployed application runtime remains commit `6e55fc3`; this follow-up changes only review SQL, tests and release documentation.

Integration verification: the concurrently published literal-underscore username duplicate fix and its test at `452c338` were reviewed and preserved. With that fix plus the three bootstrap review tests, the full local suite passes **164 tests**. No earlier release-branch commit was overwritten.
