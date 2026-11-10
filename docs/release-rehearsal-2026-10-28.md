# Production migration rehearsal — 28 October 2026

Status: passed in a disposable local restore. No production migration, role/data update, deployment, merge or invitation was performed.

Evidence: https://github.com/wammari/tymrak-app/actions/runs/40787797476 (tested implementation 17b9875ccf344200bfe416320857020c592d8bfa). Application CI also passed: https://github.com/wammari/tymrak-app/actions/runs/40787803690 . Seven Python guard/encryption tests passed. The working checkout's application suite passed 149 tests, including three production-preparation tests that are on the separate PR #31 candidate.

The workflow exported production read-only with certificate/hostname verification, restored it, verified source record hashes and security metadata, applied the four pending clock/geofence/company/workplace migrations plus trigger EXECUTE hardening as the ordinary local postgres role, then ran transactional synthetic acceptance fixtures. All fixtures rolled back. Every original record hash matched after rehearsal, including four employee records, four Auth users and 37 punches. The encrypted evidence was authenticated/decrypted privately and original dump SHA-256 hashes were verified independently.

## Acceptance passed

- I Care Pharmacy legacy ownership and the confirmed Outlook administrator mapping, only inside the rolled-back fixture transaction.
- Regular managers see only employees assigned to their workplaces; a shared employee remains visible to both assigned managers.
- Company administrators remain company-scoped. Guessed foreign/unassigned workplace IDs and cross-company assignments are rejected.
- Browser employee reads remain personal; direct punch/manager-assignment writes and privileged RPC execution are denied.
- Inside-geofence clock-in/out, duplicate request retry, outside-geofence rejection, missing GPS and stale GPS rejection.
- Company-required constraints validate after mapping.
- Trigger helpers lose direct browser EXECUTE access while existing triggers continue to fire.

## Remaining production gates

1. Confirm the actual pharmacy workplace address, map pin and radius. Current staging says 2 Sparrow Court, Hamilton, radius 200 m; independent PR #35 references 11 Speedvale Ave E, Guelph. Neither setting is automatically promoted. Rehearsal locations are synthetic.
2. Choose one compatible release stack. PR #33 introduces overlapping organizations/workplaces prerequisites; applying it blindly before this stack would conflict with CREATE TABLE statements. PR #35 is a disabled browser-only GPS experiment and does not replace database geofence enforcement. PR #36 overlaps the already-tested staging branding. Review/supersede alternatives before merging.
3. Prepare exact production company/admin/workplace mapping, preserving all test histories and using production IDs. Unknown records remain quarantined until reviewed.
4. Verify production custom SMTP, canonical Auth redirect allowlist and external invitation/recovery delivery. No real employee recipients have been supplied.
5. Provision the isolated production Worker and fresh runtime Secrets, retire old privileged snapshots/keys, prepare domain/DNS cutover and take a final maintenance-window backup.
6. Apply the exact rehearsed migrations and reviewed mapping, deploy the exact compatible application commit, then run hosted mobile and cross-company acceptance before inviting real staff. Local SQL acceptance does not replace hosted/browser acceptance or capacity checks.

The manual encrypted database backup is not a complete hosted-service backup. Auth/SMTP settings, API keys, DNS, Vault keys, role passwords and Storage files require separate handling. Production currently has no Storage objects. No paid plan or service was added.
