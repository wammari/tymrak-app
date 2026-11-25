-- Is this email already a TYMRAK sign-in account (in any company, activated or only invited)?
-- Adding an employee checks this before sending anything: inviting an email that already
-- has an account re-sends that account's old invitation (possibly naming another company)
-- instead of creating a new one. Server only; it answers yes or no and reveals nothing else.
begin;

create function public.auth_email_in_use(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users u where lower(u.email) = lower(btrim(p_email)));
$$;
revoke all on function public.auth_email_in_use(text) from public, anon, authenticated;
grant execute on function public.auth_email_in_use(text) to service_role;

commit;
