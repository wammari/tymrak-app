-- Performance tuning only. No change to what any role can see or do.

-- 1. Indexes for foreign keys that had none, so joins and deletes stay fast as data grows.
create index if not exists account_deletion_requests_employee_org_idx on public.account_deletion_requests (employee_id, organization_id);
create index if not exists employee_punch_requests_employee_idx on public.employee_punch_requests (employee_id);
create index if not exists employee_time_off_settings_type_idx on public.employee_time_off_settings (type_id);
create index if not exists employee_time_off_settings_updated_by_idx on public.employee_time_off_settings (updated_by);
create index if not exists employee_workplaces_employee_org_idx on public.employee_workplaces (employee_id, organization_id);
create index if not exists employee_workplaces_org_idx on public.employee_workplaces (organization_id);
create index if not exists employee_workplaces_workplace_org_idx on public.employee_workplaces (workplace_id, organization_id);
create index if not exists manager_workplaces_manager_org_idx on public.manager_workplaces (manager_id, organization_id);
create index if not exists manager_workplaces_org_idx on public.manager_workplaces (organization_id);
create index if not exists manager_workplaces_workplace_org_idx on public.manager_workplaces (workplace_id, organization_id);
create index if not exists pay_schedule_changes_changed_by_idx on public.pay_schedule_changes (changed_by);
create index if not exists time_off_ledger_created_by_idx on public.time_off_ledger (created_by);
create index if not exists time_off_ledger_type_idx on public.time_off_ledger (type_id);
create index if not exists time_off_requests_decided_by_idx on public.time_off_requests (decided_by);
create index if not exists time_off_requests_type_idx on public.time_off_requests (type_id);
create index if not exists timecard_approval_history_approval_idx on public.timecard_approval_history (approval_id);
create index if not exists timecard_approval_history_employee_idx on public.timecard_approval_history (employee_id);
create index if not exists timecard_approval_history_manager_idx on public.timecard_approval_history (manager_user_id);
create index if not exists timecard_approvals_approved_by_idx on public.timecard_approvals (approved_by);
create index if not exists timecard_approvals_reopened_by_idx on public.timecard_approvals (reopened_by);

-- 2. Evaluate auth.uid() once per query instead of once per row.
alter policy "Employees can view own profile" on public.employees
  using ((select auth.uid()) = auth_user_id);
alter policy "Employees can view own punches" on public.punches
  using (exists (select 1 from public.employees e where e.id = punches.employee_id and e.auth_user_id = (select auth.uid())));
alter policy "Employees can create own punches" on public.punches
  with check (exists (select 1 from public.employees e where e.id = punches.employee_id and e.auth_user_id = (select auth.uid()) and e.is_active = true and e.invitation_status = 'Account Activated'::text));

-- Left alone on purpose: user_roles_identity_company_unique duplicates user_roles_pkey, but a constraint
-- (and foreign keys) depend on it, so dropping it is not worth the risk.
