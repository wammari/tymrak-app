# Customer release candidate — 30 October 2026

This candidate combines the tested clock/geofence/company/workplace stack, the verified backup and migration rehearsal, production Worker preparation, and the current main branch's approved portal homepage. The current marketing site is not changed by this branch. Automatic Vercel deployment is disabled for `release/customer-candidate`. Production Worker routes remain empty, previews remain disabled and `TYMRAK_RELEASE_READY` remains false.

## Integration decisions

- Preserve the approved portal homepage byte-for-byte from main commit `57368a2645596494e6d0aefe86441a9653efd712`. Keep the existing tested brown/gold application styles and approved logo assets.
- Verify manager bearer sessions with the configured public key; retain the server key for scoped database access. Require a valid runtime public key and the existing deployment/project boundary checks. Do not copy main's hardcoded production key/project into staging.
- Preserve manager password recovery with the configured deployment callback. Provide Employee Login and Manager Login after reset. Support verified recovery token hashes and PKCE recovery events; a normal sign-in session cannot enable this reset form. Verify the current identity before changing its password, and clear recovery parameters from browser history after authorization.
- The portal callback origin is `https://app.tymrak.com`; the marketing site remains `https://www.tymrak.com`. This is candidate configuration only and does not change Auth settings or DNS.
- Do not merge the parallel PR #33 prerequisite migration into this stack: it creates overlapping company/workplace objects. The rehearsed stack already enforces those boundaries. PR #35's browser-only GPS experiment is superseded by the server-side implementation in this candidate. No alternative PR is closed automatically.

## Existing database evidence

Backup/restore verification: https://github.com/wammari/tymrak-app/actions/runs/40786029927 . Migration and rolled-back acceptance rehearsal: https://github.com/wammari/tymrak-app/actions/runs/40787797476 . The migration files remain unchanged from that rehearsal. Verified encrypted evidence is retained privately. These were production read-only exports and local-only writes.

## Release gates still open

1. The owner confirmed **1 Speedvale Ave E, Guelph** on October 30. This supersedes the Hamilton staging address and PR #35's 11 Speedvale address. The production plan uses the previously requested 50 m radius. Verify the building's exact map pin and indoor/outside GPS behavior before activation; coordinates have not been assumed or copied from staging. See `supabase/verification/production-workplace-plan.json`.
2. Prepare and review production I Care Pharmacy ownership, Outlook administrator and workplace mapping using production IDs. Preserve all test histories and validate required-company constraints after assignment.
3. Confirm production Auth redirect allowlist for app.tymrak.com and external invitation/recovery email delivery. No real employee recipients have been supplied in this thread.
4. Complete authenticated hosted acceptance. Vercel connector deployment access still returns HTTP 403/404, but the authorized dashboard was accessible and a manual **Preview** of commit `e51ae2c01ff74ed9e200e42bbba4067bec8dfb69` reached **READY** in 9 seconds: https://tymrak-staging-2kppfvdu1-wammari.vercel.app/ . The preview public configuration identifies the staging Supabase project `ctztwqcsizwkrqgpgrgg`; portal and Manager Login load, anonymous clocking is rejected, and checked package/private-auth source URLs return 404. GitHub CI for that exact commit passed: https://github.com/wammari/tymrak-app/actions/runs/41096330461 . No production deployment was created or promoted. Authenticated manager/clocking and external email delivery remain unverified.
5. Provision the isolated production Worker and fresh runtime keys, retire old privileged snapshots/credentials, take the final maintenance-window backup, then perform the reviewed database/app/domain cutover and hosted mobile/cross-company acceptance.

No production migration, deployment, invitation, paid service or plan change is performed by preparing this branch. Existing pending/WIP feature PRs are not automatically included.

## Staging sign-in check

On October 30, a secure browser sign-in attempt returned the application's explicit “Email or password not recognized” message. A subsequent read-only check confirmed that the intended staging account `w.ammari@outlook.com` exists, has confirmed email, is not currently banned, and has the `admin` role for the active I Care Pharmacy company. Do not change its role, create a duplicate account, copy production credentials, or treat this failed attempt as authenticated acceptance. Staging and production use separate Auth databases. Resume the hosted checks after a successful staging sign-in; any password change must be completed by the account owner through the recovery flow.
