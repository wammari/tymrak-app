-- Employee termination.
-- A terminated employee cannot clock in or out, but keeps read-only access to their own
-- historical timecards. Plain deactivation (is_active = false, no termination date) is
-- unchanged and still blocks all access.
--
-- The existing "employment_status" column is deliberately NOT reused: it is not defined in
-- these migrations and may already hold another meaning (for example full-time / part-time).

alter table public.employees
  add column if not exists termination_date date,
  add column if not exists termination_reason text,
  add column if not exists terminated_at timestamptz;

-- Terminated always means inactive for clocking, and the three fields move together.
alter table public.employees add constraint employees_termination_consistent check (
  (termination_date is null and termination_reason is null and terminated_at is null)
  or (termination_date is not null and terminated_at is not null and is_active is false
      and (termination_reason is null or char_length(termination_reason) <= 500))
);

-- Reading own record/history: active employees AND terminated employees.
create function tymrak_private.own_readable_company_employee(p_employee_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.employees e join public.organizations o on o.id=e.organization_id
  where e.id=p_employee_id and e.auth_user_id=(select auth.uid()) and o.is_active
   and (e.is_active or e.termination_date is not null)
   and e.invitation_status='Account Activated')
$$;
revoke all on function tymrak_private.own_readable_company_employee(uuid) from public,anon,authenticated;
grant execute on function tymrak_private.own_readable_company_employee(uuid) to authenticated;

-- Reads use the wider rule; every write keeps the strict "active employee" rule.
-- (Restrictive policies are ANDed, so the old FOR ALL policies are replaced per command.)
drop policy company_employee_boundary on public.employees;
drop policy company_punch_boundary on public.punches;

create policy company_employee_read_boundary on public.employees as restrictive for select to authenticated
  using(tymrak_private.own_readable_company_employee(id));
create policy company_employee_insert_boundary on public.employees as restrictive for insert to authenticated
  with check(tymrak_private.own_active_company_employee(id));
create policy company_employee_update_boundary on public.employees as restrictive for update to authenticated
  using(tymrak_private.own_active_company_employee(id)) with check(tymrak_private.own_active_company_employee(id));
create policy company_employee_delete_boundary on public.employees as restrictive for delete to authenticated
  using(tymrak_private.own_active_company_employee(id));

create policy company_punch_read_boundary on public.punches as restrictive for select to authenticated
  using(tymrak_private.own_readable_company_employee(employee_id));
create policy company_punch_insert_boundary on public.punches as restrictive for insert to authenticated
  with check(tymrak_private.own_active_company_employee(employee_id));
create policy company_punch_update_boundary on public.punches as restrictive for update to authenticated
  using(tymrak_private.own_active_company_employee(employee_id)) with check(tymrak_private.own_active_company_employee(employee_id));
create policy company_punch_delete_boundary on public.punches as restrictive for delete to authenticated
  using(tymrak_private.own_active_company_employee(employee_id));
