# Manual geofencing candidate

Built on basic clock candidate f1e991cc5b549d9efb4c73b63255511823d93852 (PR #25).
This branch must not be merged before #25 or released directly to production.

Managers open Locations in the manager portal to manually enter name, reference address,
decimal coordinates, radius (25–5000 metres), active status and employee assignments.
No geocoder, map vendor, paid key or recurring location polling is used. Addresses are
labels only: managers must verify their coordinate pin independently.

The service verifies Auth identity and database manager role. Workplace/assignment edits
are atomic and have an audit history. No browser access to new tables or RPCs is granted.
Each punch type requires a fresh browser GPS fix (30 seconds, 5 seconds clock skew,
maximum 100 metres accuracy). The complete uncertainty circle must fit in a configured
assigned active workplace. SQL checks assignment, distance and write in one transaction;
configuration edits are serialized with punch decisions using one advisory lock. This
simple lock trades throughput for correctness in the initial single-customer deployment.

Existing transition checks, server timestamps, approval locks, inactive-user denial and
request receipts remain. A committed retry can be acknowledged without fresh GPS, but a
new punch can never be inserted without it. GPS is never saved to browser localStorage.
Evidence is stored in a separate service-only table; historical punches are unchanged.
Browser GPS can be spoofed: this does not prove physical presence or device integrity.

## Staging rollout

1. Review migration 20261023172638_manual_workplaces_geofenced_punches.sql after #25's migration.
2. Stage this build; migrate only isolated staging and deploy matching code together.
   The migration revokes the old punch RPC even for service_role to close old deployment
   bypasses. Old clock APIs stop working. A code-only rollback is insufficient.
3. Configure verified workplaces and assign every active employee before customer use.
   Empty configuration denies all new punches. Do not seed fictitious workplaces as real ones.
4. Verify manager save/edit/deactivate/reassign; employee inside/outside/denied GPS,
   inaccurate/stale readings, mobile browsers, breaks, overnight/reload, lost response
   retries, inactive account and approved-period lock behavior.
5. Arrange a manager correction process if an employee cannot obtain GPS or leaves before
   clocking out; no client bypass or disabling toggle is provided.
6. Establish retention/access policy for GPS evidence before production rollout.

## Production prerequisites

Production unchanged. User authorized the basic release; geofencing requires review of
this new candidate and real workplace staging acceptance before inclusion. Free Supabase
has no automatic project backups. Obtain and verify a manual backup/recovery point before
any production migration. Do not upgrade or incur charges. Do not replay bootstrap SQL.
Confirm all users share one customer database; multi-customer tenancy is still unsupported.

## Optional Google Maps picker

The manager form can search Google Places, populate reference address/coordinates,
click the map to adjust the centre, and preview the radius. Loading is explicit and only
available to authenticated managers. Without a configured key, manual entry still works.
No database migration or GPS enforcement change is needed for this UI enhancement.

To enable: use a billing-enabled Google Cloud project, enable Maps JavaScript API and
Places API (New), create a browser key restricted to those APIs and exact site referrers
(e.g. https://tymrak-staging.vercel.app/* and separately https://www.tymrak.com/*), create
a Google Maps map ID, and set GOOGLE_MAPS_BROWSER_KEY and GOOGLE_MAPS_MAP_ID in Vercel.
Never reuse a server key or leave a browser key unrestricted. Do not paste credentials
in chat. Set quotas/budget alerts in Google Cloud; budgets are alerts, not a hard cost cap.
No Google Cloud billing, keys or paid services were provisioned by this change.

117 local tests passed after the picker addition, including selected-place field mapping,
map click/radius interaction and authorization. Live Google loading/search and configured
website restrictions remain unverified until a real restricted key/map ID are supplied.
Do not claim this as deployed or live-connected merely because the code is present.
