# Employee activation reliability — Phase 1

## Required database change

Apply `supabase/migrations/202610080001_atomic_employee_activation.sql`
before deploying the new completion API. It defines the server-only
`complete_employee_activation(uuid)` function and its execution grants.
Applying it does not update employee rows or modify Auth users.

The function requires the existing `employees` columns `id`,
`auth_user_id`, `invitation_status`, and `activated_at`. Verify those
columns and the migration against a staging copy before production deployment.
No identity backfill, account recreation, password reset, uniqueness constraint,
or repair of existing inconsistent activation flags is included.

The transaction rejects zero or multiple matching employees before writing.
It preserves any existing activation timestamp and returns success without
writing if either an activation timestamp or the activated status already exists.
For a uniquely mapped pending employee, it changes only the activation status
and sets the first activation timestamp. It never changes account identity,
employment status, or profile fields.

To prevent duplicate mappings appearing between check and update without
requiring a potentially disruptive uniqueness migration, the function briefly
locks employee writes. Its five-second lock timeout turns contention into a
retryable failure. This lock does not block ordinary employee reads. Test write
contention in staging; a future audited unique Auth-ID constraint could allow
narrower locking. Invitation sending/resending code is unchanged.

## Deployment and verification

1. Run `npm ci` and `npm test`. The suite executes the migration in isolated
   embedded PostgreSQL (PGlite); it never contacts production Auth or data.
2. In staging, apply the migration, then deploy the API and activation page.
3. Verify a real Supabase invitation callback using the current email template
   and redirect allowlist. The page supports standard `type=invite` token
   fragments and `type=invite&token_hash=...` callbacks. Admin invitations do
   not use PKCE. Recovery pages and normal login storage are unchanged.
4. Simulate completion failure after saving a test employee's password. Retry
   completion on the same page and verify that password update occurs once.
   Repeat completion and confirm the original timestamp is unchanged.
5. Apply the migration to production before deploying the reviewed PR. The
   migration can coexist with the old API; do not remove it during an application
   rollback until no deployed version calls it.

The activation page uses an isolated, in-memory invitation session. No existing
saved browser session enables activation. Credentials are removed from the URL.
After password success, fields are cleared/disabled and the button retries only
completion. Keep that page open for retries: reload intentionally discards the
invitation session and retry state. If the page is closed or the session expires,
do not resend or recreate an already usable Auth account to repair its database
status; investigate the mapping/completion failure separately.

## Scope

This PR does not apply any migration, alter production data, send invitations,
change stored passwords, or delete/recreate Auth users. Missing/duplicate
mappings are reported for manual investigation, not automatically repaired.
Invitation creation/resend reliability remains a later phase.

