# Mandatory geofencing — implementation and acceptance plan

Status: **in development**. This branch does **not** yet enforce geofencing. Do not merge or deploy.

## Non-negotiable behaviour
- Every employee punch type (clock_in, clock_out, break_start, break_end) must require a fresh location and an assigned active workplace.
- No client-controlled flag may bypass enforcement. No manager UI toggle to disable geofencing.
- Deny missing permission, absent GPS, stale or inaccurate readings, out-of-bound readings, and unassigned employees; return actionable error messages.
- Record the matched workplace, coordinates, accuracy, and verification timestamp with the punch. Minimize access to sensitive GPS information.
- Managers configure location and radius, assign employees, and see verified workplace information.
- Preserve existing timecard approval locks and audit history.

## Security architecture required before rollout
The current employee.html inserts directly into public.punches via Supabase browser credentials. Merely checking GPS in JavaScript would be bypassable. Replace direct punch writes with an authenticated server endpoint or a tightly controlled database RPC. Revoke browser direct INSERT access, including existing anon/authenticated grants and permissive policies, in a forward-only migration. Ensure server endpoint validates the Supabase Auth JWT, maps exactly one active activated employee, checks approved-period lock, checks workplace assignment, verifies location age/accuracy/radius, and inserts atomically. The endpoint must not accept employee_id, workplace coordinates, radius or punch timestamp as trusted client authority. Protect against replay and duplicate requests.

**Threat model limitation:** Browser-supplied geolocation can be spoofed. Server-side distance checks prevent trivial client UI bypass but cannot prove physical presence. Stronger anti-spoofing would require device attestation/native capabilities and separate evaluation.

## Required discovery
- Inspect actual production/staging punches schema, grants, policies, triggers and migration order before writing migration.
- Confirm whether punches supports location_name and whether existing tables represent workplace/assignment.
- Inspect current activation, manager auth and manager role checks; do not reuse employee browser tokens as server credentials.
- Confirm staging environment variables and isolated staging database. PR #18 remains unmerged and its production rollout warning remains in effect.

## Rollout order
1. Write schema migration and rollback/recovery plan; use new workplace and employee assignment records.
2. Implement server-side verified punch endpoint with atomic insert and authorization; tests for every punch type.
3. Update employee page to request fresh GPS on click and call endpoint, with visible permission/error states.
4. Implement manager location selection, radius and assignment UI (Google Maps key restrictions and billing setup separately).
5. Add unit, API, database security, replay, RLS, and end-to-end tests.
6. Run in isolated staging with real browser GPS, outside-fence, denied permission, inaccurate/stale reading, and existing timecard-lock tests.
7. Deploy production only after manager has configured workplaces and all active employees have assignments, to avoid unexpectedly blocking existing users.

## Tests for pure helper
- Same-point distance zero; known coordinate distance; invalid/NaN coordinates.
- Reject stale/future positions, low accuracy, missing GPS, out-of-fence positions.
- Accept only when GPS uncertainty fits entirely within the configured radius.
- Validate behaviour at radius boundary and around the antimeridian.

**No production credentials, data, policies or deployment changed by this branch.**
