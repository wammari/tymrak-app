-- Defines a server-only transaction. Applying this migration changes no rows.
-- Deploy before the Phase 1 complete-activation API.
begin;

create or replace function public.complete_employee_activation(p_auth_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  employee public.employees%rowtype;
  mapping_count bigint;
begin
  -- Serialize this short check/update with all employee writes, including a
  -- concurrent insert or identity reassignment. Row locks alone cannot prevent
  -- a second matching row from appearing when legacy mappings are not unique.
  lock table public.employees in share row exclusive mode;

  select count(*) into mapping_count
  from public.employees where auth_user_id = p_auth_user_id;
  if mapping_count = 0 then
    return jsonb_build_object('outcome', 'missing');
  elsif mapping_count <> 1 then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  select * into employee from public.employees
  where auth_user_id = p_auth_user_id;

  -- Existing activation evidence is authoritative. Do not rewrite timestamps
  -- or repair legacy inconsistencies as a side effect of a retry.
  if employee.invitation_status = 'Account Activated'
     or employee.activated_at is not null then
    return jsonb_build_object('outcome', 'already_activated');
  end if;

  update public.employees
  set invitation_status = 'Account Activated', activated_at = now()
  where id = employee.id and auth_user_id = p_auth_user_id;

  return jsonb_build_object('outcome', 'activated');
end;
$$;

revoke all on function public.complete_employee_activation(uuid) from public, anon, authenticated;
grant execute on function public.complete_employee_activation(uuid) to service_role;

comment on function public.complete_employee_activation(uuid) is
  'Server-only idempotent activation; rejects missing/duplicate mappings and preserves existing activation evidence.';

commit;

