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

## Free OpenStreetMap picker

Replaces the unconfigured Google prototype. Leaflet 1.9.4 is pinned with official SRI
hashes. Managers explicitly load the map, click a building or drag its pin, and preview
the radius. Coordinates fill automatically; address remains an optional reference label.
No search/geocoding API, Google key, billing account, paid fallback or background tracking.

Tiles load directly in the browser from https://tile.openstreetmap.org with visible OSM
attribution, HTTPS, a valid website Referer, normal browser caching, and no bulk download,
offline packs or prefetch features. This is low-volume manager configuration only.
OSMF tile policy: https://operations.osmfoundation.org/policies/tiles/ . Service is
best-effort and can block inappropriate usage; no SLA is promised. Manual coordinates
remain available on tile/CDN failure. Reassess hosting before materially scaling usage.

Map changes do not alter server-side geofence enforcement or existing workplace records.
