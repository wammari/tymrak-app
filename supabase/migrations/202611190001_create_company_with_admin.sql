-- Creating a company and making the Main Administrator its admin happen together, in one
-- transaction: either both are saved or neither is. Previously the server inserted the
-- company and then the role as two separate requests, and the second one was refused
-- (the server may only read user_roles since company isolation), which left companies
-- with no administrator.
--
-- Only the server (service_role) can call this. The browser cannot. The server checks
-- that the caller is the designated Main Administrator before calling it.
begin;

create function public.create_company_with_admin(
  p_name text,
  p_pay_frequency text,
  p_pay_period_anchor date,
  p_admin_user_id uuid
)
returns table (id uuid, name text, is_active boolean, pay_frequency text, pay_period_anchor date)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_company_id uuid;
begin
  if p_admin_user_id is null then
    raise exception 'An administrator is required' using errcode = 'not_null_violation';
  end if;
  insert into public.organizations (name, is_active, pay_frequency, pay_period_anchor)
  values (btrim(p_name), true, p_pay_frequency, p_pay_period_anchor)
  returning public.organizations.id into v_company_id;
  insert into public.user_roles (auth_user_id, organization_id, role)
  values (p_admin_user_id, v_company_id, 'admin');
  return query
    select o.id, o.name, o.is_active, o.pay_frequency, o.pay_period_anchor
    from public.organizations o where o.id = v_company_id;
end $$;

revoke all on function public.create_company_with_admin(text, text, date, uuid) from public, anon, authenticated;
grant execute on function public.create_company_with_admin(text, text, date, uuid) to service_role;

commit;
