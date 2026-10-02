# TYMRAK Manager Portal setup

The Manager Portal uses the same Supabase Auth project as the employee portal.
Authentication proves identity; a separate server-managed role record grants
manager authorization. An authenticated employee is **not** automatically a
manager.

## Required database change

1. Apply `supabase/migrations/202610010001_manager_roles.sql` in the Supabase SQL
   editor or through the Supabase CLI migration workflow.
2. Find the approved manager's user UUID in **Authentication > Users**.
3. Insert only explicitly approved managers or administrators:

   ```sql
   insert into public.user_roles (auth_user_id, role)
   values ('THE-AUTH-USER-UUID', 'manager')
   on conflict (auth_user_id) do update
   set role = excluded.role, updated_at = now();
   ```

   The privileged roles accepted by the portal are `manager` and `admin`.
   `employee` and `payroll` are reserved for future authorization boundaries and
   do not currently grant Manager Portal access.

The migration enables RLS and intentionally defines no browser-readable policy.
The API checks roles with the server-only secret/service key. Security is not
operational until the migration has been applied and the intended manager users
have been assigned explicitly.

## Required server environment

Configure these only in the server/deployment environment:

- `SUPABASE_URL` — the Supabase project URL.
- `SUPABASE_SECRET_KEY` — the Supabase secret/service-role key. Never expose it
  through browser JavaScript or a public environment prefix.
- `SITE_URL` — optional canonical deployment origin used to build activation
  redirects (for example, `https://tymrak.vercel.app`).

Also allow `${SITE_URL}/activate.html` as an Auth redirect URL in the Supabase
dashboard. If `SITE_URL` is omitted, the current production TYMRAK URL remains
the fallback.

## Authorization flow

1. The manager signs in through Supabase Auth in `manager-login.html`.
2. The browser sends the resulting access token to `/api/manager-session`.
3. The server asks Supabase Auth to validate the token, then reads the matching
   `user_roles` row with server-only credentials.
4. Only `manager` or `admin` reaches the portal or the invitation operation.
5. `/api/send-invitation` repeats both checks on every request; browser routing
   and hidden UI are never treated as authorization.

