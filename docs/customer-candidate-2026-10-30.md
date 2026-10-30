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

1. Confirm pharmacy address/pin/radius: staging lists 2 Sparrow Court, Hamilton; PR #35 names 11 Speedvale Ave E, Guelph. Neither is promoted automatically.
2. Prepare and review production I Care Pharmacy ownership, Outlook administrator and workplace mapping using production IDs. Preserve all test histories and validate required-company constraints after assignment.
3. Confirm production Auth redirect allowlist for app.tymrak.com and external invitation/recovery email delivery. No real employee recipients have been supplied in this thread.
4. Restore hosting visibility/access: Vercel project listing succeeded, but deployment listing for the app returned HTTP 403 on October 30. No Vercel CLI was installed for the mapped fallback. GitHub can show build checks; it does not prove the live deployment matches this candidate.
5. Provision the isolated production Worker and fresh runtime keys, retire old privileged snapshots/credentials, take the final maintenance-window backup, then perform the reviewed database/app/domain cutover and hosted mobile/cross-company acceptance.

No production migration, deployment, invitation, paid service or plan change is performed by preparing this branch. Existing pending/WIP feature PRs are not automatically included.
