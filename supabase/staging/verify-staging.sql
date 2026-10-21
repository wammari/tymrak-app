-- Read-only checks for an operator AFTER the separately authorized staging setup.
-- Verify the Dashboard project first. No employee data, passwords or tokens returned.
select n.nspname as schema_name, c.relname as table_name,
  c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in (
  'employees','overtime_rules','punches','user_roles','timecard_approvals','timecard_approval_history')
order by c.relname;

select tablename, policyname, roles, cmd, qual, with_check
from pg_catalog.pg_policies where schemaname = 'public' order by tablename, policyname;

select c.relname as table_name, k.conname, pg_catalog.pg_get_constraintdef(k.oid) as definition
from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid = k.conrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' order by c.relname, k.conname;

select pg_catalog.pg_get_serial_sequence('public.punches','id') as punch_id_sequence;

select role_name,
  has_function_privilege(role_name, 'public.complete_employee_activation(uuid)', 'EXECUTE') as can_complete_activation,
  has_table_privilege(role_name, 'public.employees', 'UPDATE') as can_update_employees,
  has_table_privilege(role_name, 'public.employees', 'TRUNCATE') as can_truncate_employees,
  has_table_privilege(role_name, 'public.punches', 'INSERT') as can_insert_punches,
  has_table_privilege(role_name, 'public.user_roles', 'SELECT') as can_read_roles
from (values ('anon'),('authenticated'),('service_role')) as roles(role_name);

select c.relname as table_name, t.tgname as trigger_name,
  pg_catalog.pg_get_triggerdef(t.oid) as definition
from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal order by c.relname, t.tgname;
