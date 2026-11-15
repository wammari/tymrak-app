-- Account deletion (App Store / privacy requirement).
-- Employees can ask for their account to be deleted; a manager or admin processes the request.
-- Processing REMOVES PERSONAL DETAILS but KEEPS TIME RECORDS: employers must retain payroll and
-- time records, so punches stay linked to an anonymous "Former Employee" row.

create table public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null,
  -- Kept only until the sign-in account is deleted (status 'Anonymized'), then cleared.
  auth_user_id uuid,
  status text not null default 'Pending' check (status in ('Pending','Anonymized','Completed','Cancelled')),
  requested_by text not null default 'employee' check (requested_by in ('employee','manager')),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  processed_by uuid,
  foreign key (employee_id, organization_id) references public.employees(id, organization_id)
);
create unique index account_deletion_one_open_request
  on public.account_deletion_requests(employee_id) where status in ('Pending','Anonymized');
create index account_deletion_requests_org_status on public.account_deletion_requests(organization_id, status);

-- Server only (service role). No browser access at all.
alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from public, anon, authenticated;
grant select, insert, update on public.account_deletion_requests to service_role;

-- Removes personal details from an employee record, keeping punches and employment facts.
-- Returns the former sign-in (auth) user id so the server can delete that account.
-- Only personal columns that exist on this database are touched, so the function works on the
-- live table even though its full column list is not defined in these migrations.
create function public.anonymize_employee_account(p_organization_id uuid, p_employee_id uuid, p_processed_by uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  employee public.employees%rowtype;
  request public.account_deletion_requests%rowtype;
  existing text[];
  sets text[] := '{}';
  col text;
begin
  select * into employee from public.employees
    where id = p_employee_id and organization_id = p_organization_id for update;
  if not found then return jsonb_build_object('error', 'employee_not_found'); end if;

  select * into request from public.account_deletion_requests
    where employee_id = p_employee_id and status in ('Pending','Anonymized') order by requested_at desc limit 1 for update;

  -- Retry path: personal data is already gone; only the sign-in account remains to be deleted.
  if found and request.status = 'Anonymized' then
    return jsonb_build_object('outcome', 'already_anonymized', 'authUserId', request.auth_user_id, 'requestId', request.id);
  end if;

  -- Active staff are only removed on their own request; otherwise the employee must be terminated first.
  if request.id is null and employee.termination_date is null then
    return jsonb_build_object('error', 'not_terminated');
  end if;
  -- Manager/admin sign-ins have approvals and audit history tied to them; handled separately.
  if employee.auth_user_id is not null and exists (
       select 1 from public.user_roles r where r.auth_user_id = employee.auth_user_id) then
    return jsonb_build_object('error', 'manager_account');
  end if;

  select array_agg(column_name::text) into existing from information_schema.columns
    where table_schema = 'public' and table_name = 'employees';

  foreach col in array array['first_name','last_name','email','username','mobile'] loop
    continue when not (col = any (coalesce(existing, '{}')));
    sets := sets || case col
      when 'first_name' then format('%I = %L', col, 'Former')
      when 'last_name'  then format('%I = %L', col, 'Employee')
      when 'email'      then format('%I = %L', col, 'deleted-' || p_employee_id || '@deleted.invalid')
      when 'username'   then format('%I = %L', col, 'deleted-' || p_employee_id)
      else format('%I = NULL', col)
    end;
  end loop;

  execute format(
    'update public.employees set %s, auth_user_id = NULL, is_active = false, ' ||
    'termination_date = coalesce(termination_date, current_date), ' ||
    'terminated_at = coalesce(terminated_at, now()), ' ||
    'termination_reason = %L where id = %L and organization_id = %L',
    array_to_string(sets, ', '), 'Personal details removed (account deletion)', p_employee_id, p_organization_id);

  if request.id is null then
    insert into public.account_deletion_requests(organization_id, employee_id, auth_user_id, status, requested_by, processed_at, processed_by)
      values (p_organization_id, p_employee_id, employee.auth_user_id, 'Anonymized', 'manager', now(), p_processed_by)
      returning id into request.id;
  else
    update public.account_deletion_requests
      set status = 'Anonymized', auth_user_id = employee.auth_user_id, processed_at = now(), processed_by = p_processed_by
      where id = request.id;
  end if;

  return jsonb_build_object('outcome', 'anonymized', 'authUserId', employee.auth_user_id, 'requestId', request.id);
end $$;
revoke all on function public.anonymize_employee_account(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.anonymize_employee_account(uuid, uuid, uuid) to service_role;

-- Marks the request finished once the sign-in account has been deleted, and drops the stored id.
create function public.complete_account_deletion(p_request_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.account_deletion_requests set status = 'Completed', auth_user_id = null
    where id = p_request_id and status = 'Anonymized';
$$;
revoke all on function public.complete_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.complete_account_deletion(uuid) to service_role;
